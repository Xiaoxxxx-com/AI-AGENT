"""右侧「记忆」抽屉：笔记、洞察、我的状态。

对应方案里 §5 的 /notes、/insights、/me 三个接口。
小程序只有 chat + notes 两页，这里把 B/C 阶段产出的洞察和状态也一并暴露出来，
方便在没有真机的情况下验证后端行为。
"""

from __future__ import annotations

from datetime import datetime, timezone

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QFont
from PySide6.QtWidgets import (
    QAbstractItemView,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from . import theme
from .api import ApiClient


def _fmt_time(value: object) -> str:
    if not value:
        return "—"
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone().strftime("%m-%d %H:%M")
    return str(value)


class NoteEditor(QDialog):
    """新建一条笔记。"""

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setWindowTitle("新建笔记")
        self.resize(520, 420)

        self.title = QLineEdit()
        self.title.setPlaceholderText("标题，比如：今天在地铁上想到的事")
        self.content = QPlainTextEdit()
        self.content.setPlaceholderText("正文。写具体一点——她之后是从这些字里找线索的。")
        self.content.setObjectName("Composer")

        hint = QLabel("保存后会立刻分词入库，向量在几秒内补齐（取决于队列）。")
        hint.setObjectName("Muted")
        hint.setWordWrap(True)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.button(QDialogButtonBox.StandardButton.Save).setText("保存")
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("取消")
        buttons.accepted.connect(self._accept)
        buttons.rejected.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 18, 18, 16)
        layout.setSpacing(10)
        layout.addWidget(self.title)
        layout.addWidget(self.content, 1)
        layout.addWidget(hint)
        layout.addWidget(buttons)

    def _accept(self) -> None:
        if not self.title.text().strip():
            self.title.setFocus()
            return
        if not self.content.toPlainText().strip():
            self.content.setFocus()
            return
        self.accept()

    def values(self) -> tuple[str, str]:
        return self.title.text().strip(), self.content.toPlainText().strip()


class MemoryPanel(QWidget):
    def __init__(self, client: ApiClient, parent: QWidget | None = None):
        super().__init__(parent)
        self.client = client
        self.setMinimumWidth(310)
        self.setMaximumWidth(520)
        self._notes: dict[int, dict] = {}

        self.tabs = QTabWidget()
        self.tabs.addTab(self._build_notes(), "笔记")
        self.tabs.addTab(self._build_insights(), "洞察")
        self.tabs.addTab(self._build_state(), "状态")
        self.tabs.currentChanged.connect(lambda _: self.refresh())

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.tabs)

        c = self.client
        c.notesReceived.connect(self._on_notes)
        c.noteCreated.connect(lambda _payload: self.refresh_notes())
        c.noteDeleted.connect(lambda _id: self.refresh_notes())
        c.insightsReceived.connect(self._on_insights)
        c.meReceived.connect(self._on_me)

    # ---------------------------------------------------------------- 笔记

    def _build_notes(self) -> QWidget:
        page = QWidget()

        self.filter = QLineEdit()
        self.filter.setPlaceholderText("筛选标题或内容…")
        self.filter.textChanged.connect(self._apply_filter)

        add = QPushButton("新建")
        add.setObjectName("Primary")
        add.clicked.connect(self._new_note)
        refresh = QPushButton("刷新")
        refresh.setObjectName("Ghost")
        refresh.clicked.connect(self.refresh_notes)

        top = QHBoxLayout()
        top.setContentsMargins(10, 10, 10, 4)
        top.setSpacing(6)
        top.addWidget(self.filter, 1)
        top.addWidget(add)
        top.addWidget(refresh)

        self.notes_list = QListWidget()
        self.notes_list.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.notes_list.setWordWrap(True)
        self.notes_list.setTextElideMode(Qt.TextElideMode.ElideRight)
        self.notes_list.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.notes_list.setSpacing(2)
        self.notes_list.itemDoubleClicked.connect(self._open_note)

        delete = QPushButton("删除选中")
        delete.setObjectName("Ghost")
        delete.clicked.connect(self._delete_note)

        bottom = QHBoxLayout()
        bottom.setContentsMargins(10, 0, 10, 10)
        bottom.addStretch(1)
        bottom.addWidget(delete)

        layout = QVBoxLayout(page)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(4)
        layout.addLayout(top)
        layout.addWidget(self.notes_list, 1)
        layout.addLayout(bottom)
        return page

    def refresh_notes(self) -> None:
        self.client.fetch_notes(80)

    def _on_notes(self, items: list[dict]) -> None:
        self._notes = {int(item.get("id", 0)): item for item in items}
        self.notes_list.clear()

        if not items:
            placeholder = QListWidgetItem("还没有笔记。点「新建」写下第一条。")
            placeholder.setFlags(Qt.ItemFlag.NoItemFlags)
            placeholder.setForeground(QColor(theme.TEXT_MUTED))
            self.notes_list.addItem(placeholder)
            return

        for item in items:
            note_id = int(item.get("id", 0))
            title = str(item.get("title") or "（无标题）")
            content = str(item.get("content") or "")
            created = _fmt_time(item.get("createdAt"))
            has_vec = "· 已向量化" if item.get("hasEmbedding") else "· 待向量化"
            row = QListWidgetItem(f"{title}\n{created} {has_vec}  {content[:46]}")
            row.setData(Qt.ItemDataRole.UserRole, note_id)
            row.setToolTip(content[:300])
            self.notes_list.addItem(row)

        self._apply_filter(self.filter.text())

    def _apply_filter(self, text: str) -> None:
        needle = text.strip().lower()
        for i in range(self.notes_list.count()):
            item = self.notes_list.item(i)
            if item is None:
                continue
            item.setHidden(bool(needle) and needle not in item.text().lower())

    def _selected_note_id(self) -> int | None:
        item = self.notes_list.currentItem()
        if item is None:
            return None
        note_id = item.data(Qt.ItemDataRole.UserRole)
        return int(note_id) if note_id else None

    def _new_note(self) -> None:
        dialog = NoteEditor(self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        title, content = dialog.values()
        self.client.create_note(title, content)

    def _delete_note(self) -> None:
        note_id = self._selected_note_id()
        if not note_id:
            QMessageBox.information(self, "删除笔记", "先在列表里选中一条。")
            return
        note = self._notes.get(note_id, {})
        answer = QMessageBox.question(
            self,
            "删除笔记",
            f"确定删除「{note.get('title', note_id)}」？\n\n注意：这是真删，洞察里引用它的证据会变成悬空。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if answer == QMessageBox.StandardButton.Yes:
            self.client.delete_note(note_id)

    def _open_note(self, item: QListWidgetItem) -> None:
        note_id = item.data(Qt.ItemDataRole.UserRole)
        note = self._notes.get(int(note_id)) if note_id else None
        if not note:
            return

        dialog = QDialog(self)
        dialog.setWindowTitle(str(note.get("title") or "笔记"))
        dialog.resize(520, 400)
        head = QLabel(f"{_fmt_time(note.get('createdAt'))} · id={note.get('id')}")
        head.setObjectName("Muted")
        body = QLabel(str(note.get("content") or ""))
        body.setWordWrap(True)
        body.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        body.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)

        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(20, 18, 20, 18)
        layout.setSpacing(8)
        layout.addWidget(head)
        layout.addWidget(body, 1)
        dialog.exec()

    # ---------------------------------------------------------------- 洞察

    def _build_insights(self) -> QWidget:
        page = QWidget()
        self.insights_list = QListWidget()
        self.insights_list.setWordWrap(True)
        self.insights_list.setTextElideMode(Qt.TextElideMode.ElideRight)
        self.insights_list.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.insights_list.setSpacing(2)

        self.insights_hint = QLabel("洞察由每日反思生成，只喂给模型，不直接给用户看——这里是把它们摊开。")
        self.insights_hint.setObjectName("Muted")
        self.insights_hint.setWordWrap(True)

        refresh = QPushButton("刷新")
        refresh.setObjectName("Ghost")
        refresh.clicked.connect(self.refresh_insights)
        bottom = QHBoxLayout()
        bottom.setContentsMargins(10, 0, 10, 10)
        bottom.addWidget(self.insights_hint, 1)
        bottom.addWidget(refresh)

        layout = QVBoxLayout(page)
        layout.setContentsMargins(10, 10, 10, 0)
        layout.setSpacing(6)
        layout.addWidget(self.insights_list, 1)
        layout.addLayout(bottom)
        return page

    def refresh_insights(self) -> None:
        self.client.fetch_insights(40, True)

    def _on_insights(self, items: list[dict]) -> None:
        self.insights_list.clear()
        if not items:
            placeholder = QListWidgetItem("还没有洞察。连着记几天笔记，反思任务会自己长出来。")
            placeholder.setFlags(Qt.ItemFlag.NoItemFlags)
            placeholder.setForeground(QColor(theme.TEXT_MUTED))
            self.insights_list.addItem(placeholder)
            return

        active = sum(1 for i in items if i.get("isActive"))
        for item in items:
            kind = {"pattern": "模式", "preference": "偏好", "concern": "牵挂", "milestone": "节点"}.get(
                str(item.get("type")), str(item.get("type"))
            )
            confidence = float(item.get("confidence") or 0)
            note_ids = item.get("noteIds") or []
            suffix = f"依据 {len(note_ids)} 条笔记"
            if not item.get("isActive"):
                suffix = f"已被 #{item.get('supersededBy')} 取代"
            row = QListWidgetItem(
                f"【{kind}】{item.get('content')}\n置信度 {confidence:.2f} · {suffix}"
            )
            row.setToolTip(str(item.get("supersededReason") or ""))
            if not item.get("isActive"):
                row.setForeground(QColor(theme.TEXT_MUTED))
            self.insights_list.addItem(row)

        self.insights_hint.setText(f"共 {len(items)} 条，其中有效 {active} 条")

    # ---------------------------------------------------------------- 状态

    def _build_state(self) -> QWidget:
        page = QWidget()
        self.state_form = QFormLayout()
        self.state_form.setContentsMargins(14, 14, 14, 8)
        self.state_form.setSpacing(10)
        self.state_form.setLabelAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self._state_values: dict[str, QLabel] = {}

        fields = [
            ("mind", "当前心情"),
            ("energy", "能量"),
            ("ignored", "连续未回应"),
            ("cooldown", "冷却至"),
            ("daily", "今日主动"),
            ("quota", "订阅额度"),
            ("last_user", "最后对话"),
            ("last_proactive", "上次主动"),
            ("heartbeat", "下次心跳"),
            ("quiet", "静默时段"),
        ]
        for key, label in fields:
            value = QLabel("—")
            value.setObjectName("Muted")
            value.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            self._state_values[key] = value
            self.state_form.addRow(label, value)

        refresh = QPushButton("刷新")
        refresh.setObjectName("Ghost")
        refresh.clicked.connect(self.refresh_state)
        bottom = QHBoxLayout()
        bottom.setContentsMargins(10, 0, 10, 10)
        bottom.addStretch(1)
        bottom.addWidget(refresh)

        hint = QLabel("这几个数决定她会不会主动找你：连续未回应触发退避，额度决定订阅消息还能发几条。")
        hint.setObjectName("Muted")
        hint.setWordWrap(True)

        layout = QVBoxLayout(page)
        layout.setContentsMargins(0, 10, 0, 0)
        layout.setSpacing(8)
        layout.addLayout(self.state_form)
        layout.addWidget(hint)
        layout.addStretch(1)
        layout.addLayout(bottom)
        return page

    def refresh_state(self) -> None:
        self.client.fetch_me()

    def _on_me(self, payload: dict) -> None:
        user = payload.get("user") or {}
        state = payload.get("state") or {}

        def put(key: str, text: str) -> None:
            label = self._state_values.get(key)
            if label is not None:
                label.setText(text)

        put("mind", str(state.get("current_mood") or "—"))
        energy = state.get("energy")
        put("energy", f"{float(energy):.2f}" if isinstance(energy, (int, float)) else "—")
        put("ignored", str(state.get("consecutive_ignored", "—")))
        put("cooldown", _fmt_time(state.get("cooldown_until")))
        cap = user.get("dailyProactiveCap", "—")
        put("daily", f"{state.get('daily_proactive_count', 0)} / {cap}")
        put("quota", str(user.get("subscriptionQuota", "—")))
        put("last_user", _fmt_time(state.get("last_user_message_at")))
        put("last_proactive", _fmt_time(state.get("last_proactive_at")))
        put("heartbeat", _fmt_time(state.get("next_heartbeat_at")))
        put("quiet", f"{str(user.get('quietStart', '—'))[:5]} – {str(user.get('quietEnd', '—'))[:5]}")

    # ---------------------------------------------------------------- 统一刷新

    def refresh(self) -> None:
        index = self.tabs.currentIndex()
        if index == 0:
            self.refresh_notes()
        elif index == 1:
            self.refresh_insights()
        else:
            self.refresh_state()


def panel_font() -> QFont:
    font = QFont()
    font.setPointSize(10)
    return font
