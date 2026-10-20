"""聊天区背景：图片绘制、状态持久化、设置页里的背景面板。

三个约束决定了这里的实现方式：

1. **不能给容器设内联 QSS 背景**。QScrollArea 里那张 `background: transparent`
   会顺着 QSS 层叠影响到所有气泡（气泡本身就是 QFrame），结果是气泡底色全没。
   所以透明只写在 theme.QSS 的 ID 选择器上，靠 objectName 精确命中。
2. **缩放必须缓存**。paintEvent 每帧都在调，源图 1080×607 每次重采样会把滚动拖卡。
   尺寸或填充方式没变就直接复用上一张。
3. **必须按 devicePixelRatio 缩放**。否则 150% 缩放的屏幕上背景是糊的，
   而气泡文字是清晰的——这种"只有背景糊"的差异比整体都糊更难看。
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path

from PySide6.QtCore import QPointF, QSize, Qt, Signal
from PySide6.QtGui import QColor, QIcon, QPainter, QPixmap
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QSlider,
    QVBoxLayout,
    QWidget,
)

from . import theme

IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".bmp")

FILLS: tuple[tuple[str, str], ...] = (
    ("cover", "铺满（裁切铺展）"),
    ("contain", "适应（完整留边）"),
    ("tile", "平铺（原图重复）"),
)

# 用户自己的图片放在 apps/desktop/background/，选择对话框默认从这里打开
GALLERY_DIR = Path(__file__).resolve().parent.parent / "background"

DIM_MAX = 85


def is_image_file(path: str | Path) -> bool:
    return Path(path).suffix.lower() in IMAGE_SUFFIXES


def scan_gallery() -> list[Path]:
    if not GALLERY_DIR.is_dir():
        return []
    return sorted(p for p in GALLERY_DIR.iterdir() if p.is_file() and is_image_file(p))


@dataclass
class Backdrop:
    path: str = ""
    fill: str = "cover"
    dim: int = 45

    @property
    def active(self) -> bool:
        return bool(self.path)

    def copy(self) -> "Backdrop":
        return replace(self)

    @classmethod
    def from_settings(cls, settings) -> "Backdrop":  # type: ignore[no-untyped-def]
        path = str(settings.value("background/path", "") or "")
        fill = str(settings.value("background/fill", "cover") or "cover")
        if fill not in {key for key, _ in FILLS}:
            fill = "cover"
        try:
            dim = int(settings.value("background/dim", 45))
        except (TypeError, ValueError):
            dim = 45
        return cls(path=path, fill=fill, dim=max(0, min(DIM_MAX, dim)))

    def save(self, settings) -> None:  # type: ignore[no-untyped-def]
        settings.setValue("background/path", self.path)
        settings.setValue("background/fill", self.fill)
        settings.setValue("background/dim", self.dim)


class BackdropLayer(QWidget):
    """一张铺满自身的背景图，带一层柔化遮罩。

    没有设置图片时退化成纯色（theme.BG），所以它可以无条件铺在聊天区最底层，
    不需要在"有背景/没背景"之间切换控件树。
    """

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        # 自己会把整块矩形填满，交给 Qt 清屏只会多一次全窗重绘
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)
        self._state = Backdrop()
        self._source: QPixmap | None = None
        self._scaled: QPixmap | None = None
        self._cache_key: tuple[int, int, str, str] | None = None
        self.error = ""

    # -- 状态
    @property
    def state(self) -> Backdrop:
        return self._state

    def set_state(self, state: Backdrop) -> str:
        """应用新状态，返回错误信息（空串表示成功）。"""
        reload = state.path != self._state.path
        self._state = state.copy()
        if reload:
            self._load()
        self._invalidate()
        self.update()
        return self.error

    def _load(self) -> None:
        self._source = None
        self.error = ""
        path = self._state.path
        if not path:
            return
        file = Path(path)
        if not file.is_file():
            self.error = f"找不到图片：{file.name}"
            return
        pixmap = QPixmap(path)
        if pixmap.isNull():
            self.error = f"无法读取图片：{file.name}（格式可能不受支持）"
            return
        self._source = pixmap

    def _invalidate(self) -> None:
        self._scaled = None
        self._cache_key = None

    def resizeEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        super().resizeEvent(event)
        # 尺寸变了，缓存作废；这里不主动重算，留给下一帧 paint
        self._invalidate()

    # -- 绘制
    def paintEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        painter = QPainter(self)
        rect = self.rect()
        painter.fillRect(rect, QColor(theme.BG))

        if self._source is not None:
            if self._state.fill == "tile":
                self._paint_tile(painter, rect)
            else:
                self._paint_scaled(painter, rect)
            dim = max(0, min(DIM_MAX, self._state.dim))
            if dim:
                # 遮罩颜色跟随主题：浅色主题用白色柔化，深色文字才不会陷进照片里
                painter.fillRect(rect, QColor(*theme.OVERLAY, round(dim * 255 / 100)))
        painter.end()

    def _paint_scaled(self, painter: QPainter, rect) -> None:  # type: ignore[no-untyped-def]
        assert self._source is not None
        dpr = self.devicePixelRatioF()
        target = QSize(max(1, int(rect.width() * dpr)), max(1, int(rect.height() * dpr)))
        cover = self._state.fill != "contain"
        key = (target.width(), target.height(), self._state.fill, self._state.path)

        if self._cache_key != key or self._scaled is None:
            mode = (
                Qt.AspectRatioMode.KeepAspectRatioByExpanding
                if cover
                else Qt.AspectRatioMode.KeepAspectRatio
            )
            scaled = self._source.scaled(target, mode, Qt.TransformationMode.SmoothTransformation)
            scaled.setDevicePixelRatio(dpr)
            self._scaled = scaled
            self._cache_key = key

        scaled = self._scaled
        logical_w = scaled.width() / dpr
        logical_h = scaled.height() / dpr
        # 铺满时按中心对齐，裁掉溢出的部分；适应时居中留边
        x = (rect.width() - logical_w) / 2
        y = (rect.height() - logical_h) / 2
        painter.drawPixmap(QPointF(x, y), scaled)

    def _paint_tile(self, painter: QPainter, rect) -> None:  # type: ignore[no-untyped-def]
        assert self._source is not None
        dpr = self.devicePixelRatioF()
        # 原图一般远大于一屏，平铺前先缩到 420 逻辑像素内，否则一块屏只放得下半张图
        limit = int(420 * dpr)
        tile = self._source
        if tile.width() > limit or tile.height() > limit:
            tile = tile.scaled(
                limit,
                limit,
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
        else:
            # 复制一份再设 DPR，避免改到 _source（否则切回铺满时用的是被改过的源图）
            tile = QPixmap(tile)
        tile.setDevicePixelRatio(dpr)
        painter.drawTiledPixmap(rect, tile)


class BackdropEditor(QWidget):
    """背景设置面板，嵌在设置页的「背景」标签里。

    实时生效：改一下就能在设置页里看到预览，主窗口也会同步；由设置页决定保存或回滚。
    """

    changed = Signal(object)  # Backdrop

    def __init__(self, state: Backdrop, parent: QWidget | None = None):
        super().__init__(parent)
        self.state = state.copy()

        self.preview = BackdropLayer(self)
        self.preview.setFixedSize(300, 168)
        self.preview.setStyleSheet(f"border: 1px solid {theme.BORDER}; border-radius: 10px;")

        self.fill = QComboBox()
        for key, label in FILLS:
            self.fill.addItem(label, key)
        index = self.fill.findData(self.state.fill)
        self.fill.setCurrentIndex(max(0, index))

        self.dim = QSlider(Qt.Orientation.Horizontal)
        self.dim.setRange(0, DIM_MAX)
        self.dim.setValue(self.state.dim)
        self.dim.setTickInterval(10)
        self.dim_value = QLabel(f"{self.state.dim}%")
        self.dim_value.setObjectName("Muted")
        self.dim_value.setFixedWidth(40)

        choose = QPushButton("选择图片…")
        choose.setObjectName("Primary")
        choose.clicked.connect(self.pick_file)
        clear = QPushButton("清除背景")
        clear.setObjectName("Ghost")
        clear.clicked.connect(self.clear_backdrop)
        reset = QPushButton("还原默认")
        reset.setObjectName("Ghost")
        reset.clicked.connect(self.reset)

        self.hint = QLabel("")
        self.hint.setObjectName("Muted")
        self.hint.setWordWrap(True)

        self.gallery = QListWidget()
        self.gallery.setIconSize(QSize(72, 42))
        self.gallery.setFixedHeight(140)
        self.gallery.itemClicked.connect(self._pick_gallery_item)
        self._fill_gallery()

        dim_row = QHBoxLayout()
        dim_row.setSpacing(10)
        dim_row.addWidget(self.dim, 1)
        dim_row.addWidget(self.dim_value)

        left = QVBoxLayout()
        left.setSpacing(10)
        left.addWidget(self.preview, 0, Qt.AlignmentFlag.AlignLeft)
        buttons = QHBoxLayout()
        buttons.setSpacing(8)
        buttons.addWidget(choose)
        buttons.addWidget(clear)
        buttons.addStretch(1)
        left.addLayout(buttons)
        left.addStretch(1)

        right = QVBoxLayout()
        right.setSpacing(8)
        right.addWidget(QLabel("填充方式"))
        right.addWidget(self.fill)
        right.addWidget(QLabel("遮罩强度（越高文字越清楚）"))
        right.addLayout(dim_row)
        right.addStretch(1)

        body = QHBoxLayout()
        body.setSpacing(16)
        body.addLayout(left, 0)
        body.addLayout(right, 1)

        gallery_label = QLabel(f"本机图片（{GALLERY_DIR.name}/）" if scan_gallery() else "")
        gallery_label.setObjectName("Muted")

        reset_row = QHBoxLayout()
        reset_row.setSpacing(8)
        reset_row.addWidget(reset)
        reset_row.addStretch(1)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 8)
        layout.setSpacing(12)
        layout.addLayout(body)
        if gallery_label.text():
            layout.addWidget(gallery_label)
            layout.addWidget(self.gallery)
        layout.addWidget(self.hint)
        layout.addLayout(reset_row)
        layout.addStretch(1)

        self.fill.currentIndexChanged.connect(self._emit)
        self.dim.valueChanged.connect(self._on_dim)
        self._render_preview()

    # -- 数据
    def _fill_gallery(self) -> None:
        for path in scan_gallery():
            pixmap = QPixmap(str(path))
            icon = QIcon(
                pixmap.scaled(
                    72,
                    42,
                    Qt.AspectRatioMode.KeepAspectRatioByExpanding,
                    Qt.TransformationMode.SmoothTransformation,
                )
            )
            item = QListWidgetItem(icon, f"{path.name}   {pixmap.width()}×{pixmap.height()}")
            item.setData(Qt.ItemDataRole.UserRole, str(path))
            self.gallery.addItem(item)

    def _pick_gallery_item(self, item: QListWidgetItem) -> None:
        self.state.path = str(item.data(Qt.ItemDataRole.UserRole) or "")
        self._render_preview()
        self._emit()

    # -- 操作
    def pick_file(self) -> None:
        start = str(GALLERY_DIR if GALLERY_DIR.is_dir() else Path.home())
        path, _ = QFileDialog.getOpenFileName(
            self, "选择背景图片", start, "图片 (*.png *.jpg *.jpeg *.webp *.bmp)"
        )
        if path:
            self.state.path = path
            self._render_preview()
            self._emit()

    def clear_backdrop(self) -> None:
        self.state.path = ""
        self._render_preview()
        self._emit()

    def reset(self) -> None:
        self.state = Backdrop()
        self.fill.setCurrentIndex(max(0, self.fill.findData("cover")))
        self.dim.setValue(45)
        self._render_preview()
        self._emit()

    # -- 联动
    def _on_dim(self, value: int) -> None:
        self.dim_value.setText(f"{value}%")
        self._render_preview()
        self._emit()

    def _emit(self) -> None:
        self.state.fill = str(self.fill.currentData() or "cover")
        self.state.dim = self.dim.value()
        self.changed.emit(self.state.copy())

    def _render_preview(self) -> None:
        self.state.fill = str(self.fill.currentData() or "cover")
        self.state.dim = self.dim.value()
        error = self.preview.set_state(self.state)
        if error:
            self.hint.setText(f"{error}　—— 已回退为纯色背景")
        elif not self.state.path:
            self.hint.setText("当前没有设置背景，聊天区使用纯色。拖一张图片到聊天区也可以直接设为背景。")
        else:
            name = Path(self.state.path).name
            self.hint.setText(f"当前：{name}　（拖图片到聊天区同样可以更换）")
