"""主窗口：连接状态、对话流、待读主动消息、设置与记忆检索。"""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QElapsedTimer, QSettings, Qt, QTimer, Signal
from PySide6.QtGui import QAction, QFont
from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSplitter,
    QStackedWidget,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from . import theme
from .api import ApiClient, new_session_id
from .backend import BackendController
from .backdrop import Backdrop, BackdropEditor
from .panel import MemoryPanel
from .widgets import ChatView, Composer, StatusDot


class SettingsDialog(QDialog):
    """连接参数 + 背景，两页放在同一个设置对话框里。

    背景改动实时预览，保存才落盘；取消会把主窗口恢复到打开设置前的状态。
    """

    backdropChanged = Signal(object)  # Backdrop

    def __init__(
        self,
        base_url: str,
        openid: str,
        session_id: str,
        background: Backdrop,
        initial_tab: str = "连接",
        backend: BackendController | None = None,
        parent: QWidget | None = None,
    ):
        super().__init__(parent)
        self.setWindowTitle("设置")
        self.setMinimumWidth(620)
        self.backdrop = background.copy()
        self.backend = backend

        self.base_url = QLineEdit(base_url)
        self.openid = QLineEdit(openid)
        self.session = QLineEdit(session_id)
        self.session.setReadOnly(True)
        self.session.setCursorPosition(0)

        reset = QPushButton("重置会话")
        reset.setObjectName("Ghost")
        reset.clicked.connect(lambda: self.session.setText(new_session_id()))

        session_row = QWidget()
        row = QHBoxLayout(session_row)
        row.setContentsMargins(0, 0, 0, 0)
        row.addWidget(self.session, 1)
        row.addWidget(reset)

        form = QFormLayout()
        form.setSpacing(12)
        form.addRow("服务地址", self.base_url)
        form.addRow("openid", self.openid)
        form.addRow("会话 ID", session_row)

        hint = QLabel("改服务地址后会自动重新登录；重置会话会开启一段新的对话（历史仍保留在库里）。")
        hint.setObjectName("Muted")
        hint.setWordWrap(True)

        backend_title = QLabel("本地后端")
        self.backend_status = QLabel("")
        self.backend_status.setObjectName("Muted")
        self.backend_status.setWordWrap(True)
        self.backend_btn = QPushButton("启动")
        self.backend_btn.setObjectName("Primary")
        self.backend_btn.setFixedWidth(92)
        self.backend_btn.clicked.connect(self._toggle_backend)

        backend_row = QHBoxLayout()
        backend_row.setSpacing(10)
        backend_row.addWidget(backend_title)
        backend_row.addWidget(self.backend_status, 1)
        backend_row.addWidget(self.backend_btn)

        backend_hint = QLabel(
            "启动 PGlite（5433）和 API（3000）；关闭本程序时会自动结束这两个进程。"
            "向量化还需要 Ollama 在运行。"
        )
        backend_hint.setObjectName("Muted")
        backend_hint.setWordWrap(True)

        connection = QWidget()
        connection_layout = QVBoxLayout(connection)
        connection_layout.setContentsMargins(16, 18, 16, 8)
        connection_layout.setSpacing(14)
        connection_layout.addLayout(form)
        connection_layout.addWidget(hint)
        connection_layout.addSpacing(4)
        connection_layout.addLayout(backend_row)
        connection_layout.addWidget(backend_hint)
        connection_layout.addStretch(1)

        if self.backend is not None:
            self.backend.stateChanged.connect(self._render_backend)
            self.backend.probe()
        self._render_backend()

        self.editor = BackdropEditor(self.backdrop)
        self.editor.changed.connect(self._on_backdrop)

        self.tabs = QTabWidget()
        self.tabs.addTab(connection, "连接")
        self.tabs.addTab(self.editor, "背景")
        self.tabs.setCurrentIndex(1 if initial_tab == "背景" else 0)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.button(QDialogButtonBox.StandardButton.Save).setText("保存")
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("取消")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 12, 16, 14)
        layout.setSpacing(10)
        layout.addWidget(self.tabs, 1)
        layout.addWidget(buttons)

    def _on_backdrop(self, state: Backdrop) -> None:
        self.backdrop = state.copy()
        self.backdropChanged.emit(self.backdrop.copy())

    def _toggle_backend(self) -> None:
        if self.backend is None:
            return
        if self.backend.state in ("starting", "running"):
            self.backend.stop()
            return
        error = self.backend.start()
        if error:
            QMessageBox.warning(self, "无法启动后端", error)
        self._render_backend()

    def _render_backend(self, state: str = "", detail: str = "") -> None:
        if self.backend is None:
            self.backend_status.setText("未接入")
            self.backend_btn.setEnabled(False)
            return
        state = state or self.backend.state
        detail = detail or self.backend.detail
        label = {
            "stopped": "未启动",
            "starting": "启动中…",
            "running": "已启动",
            "external": "已在运行",
            "error": "启动失败",
        }.get(state, state)
        self.backend_status.setText(f"{label}　{detail}".strip())
        self.backend_btn.setText(
            {"starting": "启动中…", "running": "停止", "external": "已运行"}.get(state, "启动")
        )
        self.backend_btn.setEnabled(state not in ("starting", "external"))


class MemoryDialog(QDialog):
    """记忆检索：直接调 /memory/search，看到 hybrid 命中的原文。"""

    def __init__(self, client: ApiClient, parent: QWidget | None = None):
        super().__init__(parent)
        self.client = client
        self.setWindowTitle("记忆检索")
        self.resize(560, 460)

        self.input = QLineEdit()
        self.input.setPlaceholderText("比如：最近工作压力大 / 想养猫")
        self.input.returnPressed.connect(self.search)
        button = QPushButton("检索")
        button.setObjectName("Primary")
        button.clicked.connect(self.search)

        top = QHBoxLayout()
        top.addWidget(self.input, 1)
        top.addWidget(button)

        self.result = QListWidget()
        self.result.itemDoubleClicked.connect(self._show_full)

        self.hint = QLabel("双击查看全文。source 表示命中路径：both / vector / keyword。")
        self.hint.setObjectName("Muted")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 18, 18, 16)
        layout.setSpacing(10)
        layout.addLayout(top)
        layout.addWidget(self.result, 1)
        layout.addWidget(self.hint)

        self.client.searchReceived.connect(self._fill)
        self.client.requestFailed.connect(self._fail)

    def search(self) -> None:
        query = self.input.text().strip()
        if not query:
            return
        self.hint.setText("检索中…")
        self.client.search_memory(query, 10)

    def _fill(self, items: list[dict]) -> None:
        self.result.clear()
        if not items:
            self.hint.setText("没有命中。换种说法试试，或者先写几条笔记。")
            return
        for item in items:
            title = str(item.get("title") or "")
            content = str(item.get("content") or "")
            source = str(item.get("source") or "")
            row = QListWidgetItem(f"{title}   [{source}]\n{content[:90]}")
            row.setData(Qt.ItemDataRole.UserRole, content)
            self.result.addItem(row)
        self.hint.setText(f"命中 {len(items)} 条")

    def _fail(self, scene: str, message: str) -> None:
        if scene == "记忆检索":
            self.hint.setText(f"检索失败：{message}")

    def _show_full(self, item: QListWidgetItem) -> None:
        content = item.data(Qt.ItemDataRole.UserRole) or ""
        dialog = QDialog(self)
        dialog.setWindowTitle("笔记全文")
        dialog.resize(520, 380)
        label = QLabel(str(content))
        label.setWordWrap(True)
        label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.addWidget(label)
        dialog.exec()


class MainWindow(QMainWindow):
    def __init__(self, autostart: bool = True) -> None:
        super().__init__()
        self.settings = QSettings("companion", "desktop")
        self.base_url = str(self.settings.value("base_url", "http://127.0.0.1:3000"))
        self.openid = str(self.settings.value("openid", "seed-openid-001"))
        self.session_id = str(self.settings.value("session_id", "") or new_session_id())
        self.settings.setValue("session_id", self.session_id)
        self.background = Backdrop.from_settings(self.settings)
        # 后端由设置页按需启动；关窗时只结束这里启动的进程
        self.backend = BackendController(self)

        self.client = ApiClient(self.base_url, self)
        self.busy = False
        self.online = False
        self.stream_bubble = None
        self.streamed = ""
        self.timer = QElapsedTimer()
        self.pending_items: list[dict] = []

        self.setWindowTitle("陪伴 · 桌面端")
        self.resize(880, 700)
        self.setMinimumSize(620, 480)
        self._restore_geometry()
        self._build_ui()
        self._wire()
        # 背景要在 UI 建好之后套用；这一步不写回设置，避免每次启动都重存一遍
        self.apply_background(self.background, save=False)

        if autostart:
            QTimer.singleShot(120, self.boot)

    # ---------------------------------------------------------------- UI

    def _build_ui(self) -> None:
        root = QWidget()
        layout = QVBoxLayout(root)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        layout.addWidget(self._build_header())

        self.stack = QStackedWidget()
        self.chat = ChatView()
        self.stack.addWidget(self.chat)
        self.stack.addWidget(self._build_offline())

        self.panel = MemoryPanel(self.client)
        self.panel.setVisible(False)

        self.splitter = QSplitter(Qt.Orientation.Horizontal)
        self.splitter.addWidget(self.stack)
        self.splitter.addWidget(self.panel)
        self.splitter.setStretchFactor(0, 1)
        self.splitter.setStretchFactor(1, 0)
        self.splitter.setCollapsible(0, False)
        self.splitter.setSizes([560, 420])

        layout.addWidget(self.splitter, 1)
        layout.addWidget(self._build_footer())
        self.setCentralWidget(root)

        # 菜单（快捷键）
        menu = self.menuBar()
        file_menu = menu.addMenu("文件")
        config_action = QAction("配置密钥与模型…", self)
        config_action.setShortcut("Ctrl+K")
        config_action.triggered.connect(self.open_configurator)
        file_menu.addAction(config_action)
        file_menu.addSeparator()
        settings_action = QAction("设置…", self)
        settings_action.setShortcut("Ctrl+,")
        settings_action.triggered.connect(lambda: self.open_settings())
        file_menu.addAction(settings_action)
        quit_action = QAction("退出", self)
        quit_action.setShortcut("Ctrl+Q")
        quit_action.triggered.connect(self.close)
        file_menu.addAction(quit_action)

        tools = menu.addMenu("工具")
        panel_action = QAction("记忆面板（笔记 / 洞察 / 状态）", self)
        panel_action.setShortcut("Ctrl+M")
        panel_action.triggered.connect(self.toggle_panel)
        tools.addAction(panel_action)
        memory_action = QAction("记忆检索…", self)
        memory_action.setShortcut("Ctrl+F")
        memory_action.triggered.connect(self.open_memory)
        tools.addAction(memory_action)
        pending_action = QAction("拉取待读消息", self)
        pending_action.setShortcut("Ctrl+R")
        pending_action.triggered.connect(self.refresh_pending)
        tools.addAction(pending_action)
        tools.addSeparator()
        background_action = QAction("更换背景…", self)
        background_action.setShortcut("Ctrl+B")
        background_action.triggered.connect(self.open_background)
        tools.addAction(background_action)
        clear_action = QAction("清空当前会话（仅界面）", self)
        clear_action.triggered.connect(self.chat.clear)
        tools.addAction(clear_action)

        self.status_label = QLabel(f"{self.base_url} · openid={self.openid}")
        self.status_label.setObjectName("Muted")
        self.statusBar().addWidget(self.status_label)

    def _build_header(self) -> QWidget:
        header = QWidget()
        header.setObjectName("Header")
        header.setFixedHeight(56)

        self.dot = StatusDot()
        title = QLabel("陪伴")
        title.setObjectName("AppTitle")
        self.subtitle = QLabel("正在连接…")
        self.subtitle.setObjectName("Muted")

        left = QHBoxLayout()
        left.setContentsMargins(18, 0, 0, 0)
        left.setSpacing(8)
        left.addWidget(self.dot)
        left.addWidget(title)
        left.addWidget(self.subtitle)
        left.addStretch(1)

        self.pending_btn = QPushButton("待读 0")
        self.pending_btn.setObjectName("Ghost")
        self.pending_btn.clicked.connect(self.show_pending)
        self.panel_btn = QPushButton("记忆")
        self.panel_btn.setObjectName("Ghost")
        self.panel_btn.setToolTip("笔记 / 洞察 / 状态")
        self.panel_btn.clicked.connect(self.toggle_panel)
        background_btn = QPushButton("背景")
        background_btn.setObjectName("Ghost")
        background_btn.setToolTip("在设置里更换聊天区背景（Ctrl+B，也可以把图片拖进聊天区）")
        background_btn.clicked.connect(self.open_background)
        settings_btn = QPushButton("设置")
        settings_btn.setObjectName("Ghost")
        settings_btn.clicked.connect(lambda: self.open_settings())

        right = QHBoxLayout()
        right.setContentsMargins(0, 0, 14, 0)
        right.setSpacing(6)
        right.addWidget(self.pending_btn)
        right.addWidget(self.panel_btn)
        right.addWidget(background_btn)
        right.addWidget(settings_btn)

        row = QHBoxLayout(header)
        row.setContentsMargins(0, 0, 0, 0)
        row.addLayout(left, 1)
        row.addLayout(right)
        return header

    def _build_offline(self) -> QWidget:
        page = QWidget()
        card = QFrame()
        card.setObjectName("Card")
        card.setMaximumWidth(520)

        title = QLabel("后端没有响应")
        font = QFont()
        font.setPointSize(12)
        font.setBold(True)
        title.setFont(font)

        self.offline_detail = QLabel("")
        self.offline_detail.setObjectName("Muted")
        self.offline_detail.setWordWrap(True)

        steps = QLabel(
            "按顺序启动（三个终端，或先分别跑前两条）：\n\n"
            "    pnpm pg:wasm      # 数据库（WASM 版）\n"
            "    pnpm mock:llm     # LLM 替身（有 Key 可跳过）\n"
            "    pnpm dev:wasm     # 后端服务\n\n"
            "确认 http://127.0.0.1:3000/healthz 返回 200 后，点下面的按钮。"
        )
        steps.setObjectName("Muted")
        steps.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        steps.setStyleSheet(
            f"background: {theme.SURFACE_2}; border: 1px solid {theme.BORDER};"
            f"border-radius: 8px; padding: 12px; font-family: Consolas, monospace;"
        )

        retry = QPushButton("重新连接")
        retry.setObjectName("Primary")
        retry.clicked.connect(self.boot)

        inner = QVBoxLayout(card)
        inner.setContentsMargins(24, 22, 24, 22)
        inner.setSpacing(14)
        inner.addWidget(title)
        inner.addWidget(self.offline_detail)
        inner.addWidget(steps)
        inner.addWidget(retry, 0, Qt.AlignmentFlag.AlignLeft)

        row = QHBoxLayout(page)
        row.addStretch(1)
        row.addWidget(card, 0, Qt.AlignmentFlag.AlignVCenter)
        row.addStretch(1)
        return page

    def _build_footer(self) -> QWidget:
        footer = QWidget()
        footer.setObjectName("Footer")

        self.composer = Composer()
        self.composer.submitted.connect(self.send)
        self.send_btn = QPushButton("发送")
        self.send_btn.setObjectName("Primary")
        self.send_btn.setFixedSize(76, 40)
        self.send_btn.clicked.connect(self.send)

        self.context_label = QLabel("Enter 发送 · Shift+Enter 换行")
        self.context_label.setObjectName("Muted")

        btn_col = QVBoxLayout()
        btn_col.setContentsMargins(0, 0, 0, 0)
        btn_col.addStretch(1)
        btn_col.addWidget(self.send_btn)

        row = QHBoxLayout()
        row.setContentsMargins(16, 10, 16, 6)
        row.setSpacing(10)
        row.addWidget(self.composer, 1)
        row.addLayout(btn_col)

        wrap = QVBoxLayout(footer)
        wrap.setContentsMargins(0, 0, 0, 0)
        wrap.setSpacing(0)
        wrap.addLayout(row)
        hint_row = QHBoxLayout()
        hint_row.setContentsMargins(18, 0, 18, 8)
        hint_row.addWidget(self.context_label, 1)
        wrap.addLayout(hint_row)
        return footer

    # ---------------------------------------------------------------- 事件

    def _wire(self) -> None:
        c = self.client
        c.healthOk.connect(self._on_health_ok)
        c.healthFailed.connect(self._on_offline)
        c.loggedIn.connect(self._on_logged_in)
        c.authFailed.connect(self._on_offline)
        c.metaReceived.connect(self._on_meta)
        c.tokenReceived.connect(self._on_token)
        c.streamDone.connect(self._on_done)
        c.streamFailed.connect(self._on_stream_failed)
        c.streamAborted.connect(self._on_aborted)
        c.pendingReceived.connect(self._on_pending)
        c.historyReceived.connect(self._on_history)
        c.requestFailed.connect(self._on_request_failed)
        self.chat.backdropDropped.connect(self.apply_background_path)
        self.backend.ready.connect(self.boot)

    def boot(self) -> None:
        self.dot.set_state("connecting")
        self.subtitle.setText("正在连接…")
        self.client.base_url = self.base_url.rstrip("/")
        self.client.check_health()

    def _on_health_ok(self, payload: dict) -> None:
        model = str(payload.get("embedding", {}).get("model") or "?")
        self.subtitle.setText(f"正在登录 · 向量模型 {model}")
        self.client.login(self.openid)

    def _on_logged_in(self, payload: dict) -> None:
        self.dot.set_state("online")
        self.online = True
        self.composer.setEnabled(True)
        self.subtitle.setText(f"在线 · userId={payload.get('userId')}")
        self.status_label.setText(f"{self.base_url} · userId={payload.get('userId')} · session={self.session_id[:8]}")
        self.stack.setCurrentIndex(0)
        self.chat.clear()
        self.chat.add("system", f"已连接 {self.base_url}，会话 {self.session_id[:8]}")
        self.client.fetch_history(self.session_id)
        self.refresh_pending()
        if self.panel.isVisible():
            self.panel.refresh()

    def _on_offline(self, message: str) -> None:
        self.dot.set_state("offline")
        self.online = False
        self.composer.setEnabled(False)
        self.subtitle.setText("未连接")
        self.offline_detail.setText(f"{self.base_url}  →  {message}")
        self.stack.setCurrentIndex(1)
        self._set_busy(False)

    def _on_history(self, items: list[dict]) -> None:
        if items:
            self.chat.add("system", f"回填了 {len(items)} 条历史消息")
        for item in items:
            role = "user" if item.get("role") == "user" else "assistant"
            self.chat.add(role, str(item.get("content") or ""))

    def refresh_pending(self) -> None:
        self.client.fetch_pending()

    def _on_pending(self, items: list[dict]) -> None:
        self.pending_items = items
        self.pending_btn.setText(f"待读 {len(items)}")
        self.pending_btn.setEnabled(bool(items))
        for item in items:
            message = str(item.get("message") or "")
            self.chat.add("proactive", message)

    def show_pending(self) -> None:
        if not self.pending_items:
            return
        self.chat.add("system", f"以上是她没等到你回复时留下的 {len(self.pending_items)} 条")
        self.pending_items = []
        self.pending_btn.setText("待读 0")
        self.pending_btn.setEnabled(False)
        self.refresh_pending()

    # ---------------------------------------------------------------- 发送

    def send(self) -> None:
        if self.busy or not self.online:
            return
        text = self.composer.take_text()
        if not text:
            return
        if not self.client.token:
            self._on_offline("尚未登录")
            return

        self.chat.add("user", text).stamp()
        self.stream_bubble = self.chat.add("assistant", "· · ·")
        self.streamed = ""
        self._set_busy(True)
        self.timer.start()
        self.client.send_message(text, self.session_id)

    def _on_meta(self, payload: dict) -> None:
        ctx = payload.get("context") or {}
        bits = []
        if ctx.get("hits"):
            bits.append(f"记忆 {ctx['hits']} 条")
        if ctx.get("insights"):
            bits.append(f"洞察 {ctx['insights']}")
        if ctx.get("hasSummary"):
            bits.append("有摘要")
        if ctx.get("estimatedTokens"):
            bits.append(f"{ctx['estimatedTokens']} tokens")
        if payload.get("safety") == "crisis":
            bits.append("已触发安全话术")
        if bits and self.stream_bubble is not None:
            self.stream_bubble.set_meta(" · ".join(bits))

    def _on_token(self, text: str) -> None:
        if self.stream_bubble is None:
            return
        if not self.streamed:
            self.stream_bubble.set_text("")
        self.streamed += text
        self.stream_bubble.append_text(text)
        self.chat.scroll_to_bottom()

    def _on_done(self, payload: dict) -> None:
        elapsed = self.timer.elapsed() if self.timer.isValid() else 0
        if self.stream_bubble is not None:
            if not self.streamed:
                self.stream_bubble.set_text("（没有内容返回）")
            meta_bits = [f"{elapsed / 1000:.1f}s"]
            if payload.get("usage"):
                usage = payload["usage"]
                if isinstance(usage, dict) and usage.get("total_tokens"):
                    meta_bits.append(f"{usage['total_tokens']} tokens")
            existing = self.stream_bubble.meta.text()
            self.stream_bubble.set_meta(" · ".join(meta_bits + ([existing] if existing else [])))
        self.stream_bubble = None
        self._set_busy(False)
        if self.panel.isVisible():
            self.panel.refresh()

    def _on_stream_failed(self, message: str) -> None:
        if self.stream_bubble is not None:
            self.stream_bubble.set_text(f"（生成失败：{message}）")
            self.stream_bubble.set_meta("")
        self.stream_bubble = None
        self._set_busy(False)

    def _on_aborted(self) -> None:
        if self.stream_bubble is not None:
            self.stream_bubble.set_meta("已中断")
        self.stream_bubble = None
        self._set_busy(False)

    def _on_request_failed(self, scene: str, message: str) -> None:
        self.chat.add("system", f"{scene}失败：{message}")

    def _set_busy(self, busy: bool) -> None:
        self.busy = busy
        self.send_btn.setEnabled(not busy and self.online)
        self.send_btn.setText("生成中" if busy else "发送")
        if not busy and self.online:
            self.composer.setFocus()

    # ---------------------------------------------------------------- 设置

    def open_settings(self, tab: str = "连接") -> None:
        original = self.background.copy()
        dialog = SettingsDialog(
            self.base_url, self.openid, self.session_id, self.background, tab, self.backend, self
        )
        # 背景改动实时看得到，但不落盘；取消就恢复到打开设置前的样子
        dialog.backdropChanged.connect(lambda state: self.apply_background(state, save=False))
        if dialog.exec() != QDialog.DialogCode.Accepted:
            self.apply_background(original, save=False)
            return
        old_base = self.base_url
        self.base_url = dialog.base_url.text().strip() or old_base
        self.openid = dialog.openid.text().strip() or self.openid
        new_session = dialog.session.text().strip() or self.session_id
        session_changed = new_session != self.session_id
        self.session_id = new_session

        self.settings.setValue("base_url", self.base_url)
        self.settings.setValue("openid", self.openid)
        self.settings.setValue("session_id", self.session_id)
        self.apply_background(dialog.backdrop, save=True)

        if session_changed:
            self.chat.clear()
        self.boot()

    def open_memory(self) -> None:
        if not self.client.token:
            self._on_offline("尚未登录")
            return
        MemoryDialog(self.client, self).exec()

    def toggle_panel(self) -> None:
        """右侧记忆抽屉：笔记 / 洞察 / 状态。"""
        show = not self.panel.isVisible()
        self.panel.setVisible(show)
        self.panel_btn.setText("收起" if show else "记忆")
        if show:
            self.splitter.setSizes([560, 420])
            if self.online:
                self.panel.refresh()

    def open_configurator(self) -> None:
        """独立进程打开配置器：它直接读写 .env，不依赖后端是否在跑。"""
        import subprocess
        import sys
        from pathlib import Path

        script = Path(__file__).resolve().parent.parent / "configurator.py"
        if not script.exists():
            self.chat.add("system", f"找不到配置器：{script}")
            return
        subprocess.Popen([sys.executable, str(script)], cwd=str(script.parent))

    # ---------------------------------------------------------------- 背景

    def open_background(self) -> None:
        """背景已经收进设置页，这里直接打开「背景」标签。"""
        self.open_settings("背景")

    def apply_background_path(self, path: str) -> None:
        """拖进来的图片直接换背景，保留当前的填充方式与遮罩强度。"""
        state = self.background.copy()
        state.path = path
        self.apply_background(state)
        if not self.chat.backdrop.error:
            self.statusBar().showMessage(f"背景已换成 {Path(path).name}", 4000)

    def apply_background(self, state: Backdrop, save: bool = True) -> None:
        self.background = state.copy()
        error = self.chat.set_backdrop(self.background)
        if error:
            # 读不出来的路径不落盘，否则每次启动都会带着一条无效配置
            self.statusBar().showMessage(f"{error}，已回退为纯色背景", 8000)
            return
        if save:
            self.background.save(self.settings)

    # ---------------------------------------------------------------- 杂项

    def _restore_geometry(self) -> None:
        geo = self.settings.value("geometry")
        if geo:
            self.restoreGeometry(geo)

    def closeEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        self.settings.setValue("geometry", self.saveGeometry())
        if self.stream_bubble is not None:
            self.client.abort_stream()
        self.backend.stop()
        super().closeEvent(event)
