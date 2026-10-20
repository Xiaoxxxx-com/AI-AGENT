"""聊天气泡、输入框、状态点等可复用控件。"""

from __future__ import annotations

from datetime import datetime

from PySide6.QtCore import QEvent, Qt, QTimer, Signal
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QScrollArea,
    QSizePolicy,
    QStackedLayout,
    QVBoxLayout,
    QWidget,
)

from . import theme
from .backdrop import Backdrop, BackdropLayer, is_image_file

BUBBLE_MAX_RATIO = 0.74
BUBBLE_MIN_WIDTH = 220


class Bubble(QFrame):
    """一条消息。user 靠右，assistant/proactive 靠左，system 居中且无气泡。"""

    def __init__(self, role: str, text: str = "", parent: QWidget | None = None):
        super().__init__(parent)
        self.role = role
        self._text = text

        object_name = {
            "user": "BubbleUser",
            "assistant": "BubbleAssistant",
            "proactive": "BubbleProactive",
            "system": "BubbleSystem",
        }.get(role, "BubbleAssistant")
        self.setObjectName(object_name)
        self.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Maximum)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(14, 10, 14, 8)
        outer.setSpacing(4)
        if role == "system":
            # 系统提示在浅色主题下是一条半透明白色小条，内边距收紧一点
            outer.setContentsMargins(12, 5, 12, 5)

        self.label = QLabel(text)
        self.label.setWordWrap(True)
        self.label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.label.setObjectName("BubbleTextUser" if role == "user" else "BubbleText")
        if role == "system":
            self.label.setObjectName("Muted")
        outer.addWidget(self.label)

        self.meta = QLabel("")
        self.meta.setObjectName("BubbleMeta")
        if role == "system":
            self.meta.setAlignment(Qt.AlignmentFlag.AlignCenter)
        outer.addWidget(self.meta)

        if role == "proactive":
            self.meta.setText("她主动留下的")
            self.meta.setStyleSheet(f"color: {theme.WARN}; font-size: 11px;")

    # -- 内容
    @property
    def text(self) -> str:
        return self._text

    def set_text(self, text: str) -> None:
        self._text = text
        self.label.setText(text)
        self._fit()

    def append_text(self, delta: str) -> None:
        self.set_text(self._text + delta)

    def set_meta(self, text: str) -> None:
        self.meta.setText(text)

    def stamp(self) -> None:
        if not self.meta.text():
            self.meta.setText(datetime.now().strftime("%H:%M"))

    def set_max_width(self, limit: int) -> None:
        self.setMaximumWidth(limit)
        self._fit()

    def _fit(self) -> None:
        """QLabel 开了 wordWrap 后 sizeHint 会退化成很窄的一列，
        这里按最长一行算自然宽度，再夹到上限内，气泡才会“贴住文字”。"""
        limit = self.maximumWidth()
        if limit <= 0 or limit > 10000:
            limit = 640
        text = self._text or " "
        metrics = self.label.fontMetrics()
        natural = max((metrics.horizontalAdvance(line) for line in text.split("\n")), default=0)
        width = min(limit - 28, max(180, natural + 4))
        self.label.setFixedWidth(max(120, width))


class ChatView(QWidget):
    """可滚动的对话区，负责自动贴底与气泡宽度。

    背景层铺在最底下，滚动区整层透明叠上去。这样滚动时背景是固定的，
    不会像给容器设 background-image 那样跟着内容一起滚（长对话里会看到图片被拉走）。
    """

    backdropDropped = Signal(str)

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.backdrop = BackdropLayer(self)

        self.scroll = QScrollArea(self)
        self.scroll.setObjectName("ChatScroll")
        self.scroll.setWidgetResizable(True)
        self.scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        # 透明必须设在 viewport 上：QScrollArea 的底色其实由 viewport 画，
        # 只改外层样式，滚动时仍会刷出一块不透明底色盖住背景
        self.scroll.viewport().setObjectName("ChatViewport")
        self.scroll.viewport().setAutoFillBackground(False)

        self.container = QWidget()
        self.container.setObjectName("ChatContainer")
        self.container.setAutoFillBackground(False)
        self.lines = QVBoxLayout(self.container)
        self.lines.setContentsMargins(22, 18, 22, 18)
        self.lines.setSpacing(10)
        self.lines.addStretch(1)

        self.scroll.setWidget(self.container)

        stack = QStackedLayout(self)
        stack.setContentsMargins(0, 0, 0, 0)
        stack.setStackingMode(QStackedLayout.StackingMode.StackAll)
        stack.addWidget(self.backdrop)  # 先加的在下层
        stack.addWidget(self.scroll)
        # StackAll 会把 currentWidget 抬到最上层，不指定的话背景会把整个对话区盖住
        stack.setCurrentWidget(self.scroll)

        self._bubbles: list[Bubble] = []
        self.setAcceptDrops(True)

    # -- 背景
    def set_backdrop(self, state: Backdrop) -> str:
        return self.backdrop.set_state(state)

    @staticmethod
    def _dropped_image(mime) -> str:  # type: ignore[no-untyped-def]
        if not mime.hasUrls():
            return ""
        for url in mime.urls():
            if url.isLocalFile():
                path = url.toLocalFile()
                if is_image_file(path):
                    return path
        return ""

    def dragEnterEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        if self._dropped_image(event.mimeData()):
            event.acceptProposedAction()
        else:
            event.ignore()

    def dragMoveEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        if self._dropped_image(event.mimeData()):
            event.acceptProposedAction()

    def dropEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        path = self._dropped_image(event.mimeData())
        if path:
            event.acceptProposedAction()
            self.backdropDropped.emit(path)

    # -- 添加
    def add(self, role: str, text: str = "") -> Bubble:
        bubble = Bubble(role, text, self.container)
        if role == "system":
            row = QHBoxLayout()
            row.setContentsMargins(0, 2, 0, 2)
            row.addStretch(1)
            row.addWidget(bubble)
            row.addStretch(1)
            self.lines.insertLayout(self.lines.count() - 1, row)
        else:
            row = QHBoxLayout()
            row.setContentsMargins(0, 0, 0, 0)
            if role == "user":
                row.addStretch(1)
                row.addWidget(bubble)
            else:
                row.addWidget(bubble)
                row.addStretch(1)
            self.lines.insertLayout(self.lines.count() - 1, row)

        self._bubbles.append(bubble)
        self._apply_width(bubble)
        self.scroll_to_bottom()
        # 布局要等一轮事件循环才稳定，这时再贴一次底
        QTimer.singleShot(0, self.scroll_to_bottom)
        return bubble

    def clear(self) -> None:
        while self.lines.count() > 1:
            item = self.lines.takeAt(0)
            widget = item.widget()
            layout = item.layout()
            if widget is not None:
                widget.deleteLater()
            elif layout is not None:
                self._clear_layout(layout)
        self._bubbles.clear()

    def _clear_layout(self, layout) -> None:  # type: ignore[no-untyped-def]
        while layout.count():
            item = layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()

    # -- 布局
    def _apply_width(self, bubble: Bubble) -> None:
        viewport = self.scroll.viewport().width()
        if viewport <= 1:  # 还没显示，等 show 之后再算
            limit = BUBBLE_MIN_WIDTH
        else:
            limit = max(BUBBLE_MIN_WIDTH, int(viewport * BUBBLE_MAX_RATIO))
        bubble.set_max_width(limit)

    def _refresh_widths(self) -> None:
        for bubble in self._bubbles:
            self._apply_width(bubble)
        self.scroll_to_bottom()

    def showEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        super().showEvent(event)
        # 首次显示时 viewport 才有真实宽度，这里统一重算一次
        QTimer.singleShot(0, self._refresh_widths)

    def resizeEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        super().resizeEvent(event)
        self._refresh_widths()

    def scroll_to_bottom(self) -> None:
        bar = self.scroll.verticalScrollBar()
        bar.setValue(bar.maximum())


class Composer(QPlainTextEdit):
    """Enter 发送、Shift+Enter 换行。"""

    submitted = Signal()

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("Composer")
        self.setPlaceholderText("说点什么…  Enter 发送，Shift+Enter 换行")
        self.setFixedHeight(84)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)

    def keyPressEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        if event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter) and not (
            event.modifiers() & Qt.KeyboardModifier.ShiftModifier
        ):
            self.submitted.emit()
            return
        super().keyPressEvent(event)

    def take_text(self) -> str:
        text = self.toPlainText().strip()
        if text:
            self.clear()
        return text


class StatusDot(QLabel):
    """一个小圆点：在线绿、连接中黄、离线红。"""

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setFixedSize(9, 9)
        self.set_state("offline")

    def set_state(self, state: str) -> None:
        color = {
            "online": theme.OK,
            "connecting": theme.WARN,
            "offline": theme.DANGER,
        }.get(state, theme.DANGER)
        self.setStyleSheet(f"background: {color}; border-radius: 4px;")
        self.setToolTip({"online": "已连接", "connecting": "连接中", "offline": "未连接"}.get(state, ""))


class TypingDots(QLabel):
    """等待首个 token 时的占位。"""

    def __init__(self, parent: QWidget | None = None):
        super().__init__("· · ·", parent)
        self.setObjectName("Muted")

    def event(self, e: QEvent) -> bool:  # type: ignore[override]
        return super().event(e)
