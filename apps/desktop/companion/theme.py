"""配色与全局样式表。浅色、低饱和，尽量像原生的陪伴类应用。"""

BG = "#f4f6fa"
SURFACE = "#ffffff"
SURFACE_2 = "#eef2f8"
BORDER = "#d9e0ea"
TEXT = "#1f2733"
TEXT_MUTED = "#687386"
ACCENT = "#2f6fed"
ACCENT_DIM = "#2f6fed"
WARN = "#a8690a"
OK = "#0f9d63"
DANGER = "#d93a3a"

# 背景图上盖的一层柔化遮罩。浅色主题用白色，深色文字才不会陷进照片里
OVERLAY = (255, 255, 255)

FONT_FAMILY = '"Microsoft YaHei UI", "PingFang SC", "Segoe UI", sans-serif'

# 箭头图标：QSS 一旦接管 QComboBox/QSpinBox 的绘制，原生子控件就不再画，
# 必须自带图片。路径用绝对 posix 形式，避免依赖工作目录。
_ASSETS = (__import__("pathlib").Path(__file__).resolve().parent.parent / "assets").as_posix()
ARROW_DOWN = f"{_ASSETS}/arrow-down.png"
ARROW_UP = f"{_ASSETS}/arrow-up.png"

# 注意：`*` 里不写 font-family —— Qt 的 QSS 对多字体列表支持不一致，
# 统一由 fonts.apply_app_font() 设置 QApplication 字体，控件自然继承。
QSS = f"""
* {{
    font-size: 13px;
    color: {TEXT};
}}
QMainWindow, QDialog {{ background: {BG}; }}
QWidget#Header {{ background: {SURFACE}; border-bottom: 1px solid {BORDER}; }}
QWidget#Footer {{ background: {SURFACE}; border-top: 1px solid {BORDER}; }}
QLabel#AppTitle {{ font-size: 14px; font-weight: 600; }}
QLabel#Muted {{ color: {TEXT_MUTED}; font-size: 12px; }}
QLabel#Chip {{
    background: {SURFACE_2};
    border: 1px solid {BORDER};
    border-radius: 9px;
    padding: 2px 8px;
    color: {TEXT_MUTED};
    font-size: 11px;
}}
QPushButton {{
    background: {SURFACE_2};
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 6px 14px;
    color: {TEXT};
}}
QPushButton:hover {{ background: #e2e8f2; }}
QPushButton:disabled {{ color: #a2abba; border-color: #e6eaf1; }}
QPushButton#Primary {{
    background: {ACCENT_DIM};
    border: 1px solid {ACCENT_DIM};
    color: #ffffff;
    font-weight: 600;
}}
QPushButton#Primary:hover {{ background: #1f5fe0; }}
QPushButton#Primary:disabled {{ background: #b8cdf7; border-color: #b8cdf7; color: #ffffff; }}
QPushButton#Ghost {{ background: transparent; border: 1px solid transparent; padding: 4px 8px; }}
QPushButton#Ghost:hover {{ background: {SURFACE_2}; border-color: {BORDER}; }}

QScrollArea {{ border: none; background: {BG}; }}
/* 聊天区三层透明，背景图才能从最底层透上来：
   滚动区 → viewport → 内容容器。只用 ID 选择器，避免 `background` 顺带把气泡也洗成透明。 */
QScrollArea#ChatScroll, QWidget#ChatViewport, QWidget#ChatContainer {{ background: transparent; }}
/* 设置页的「连接 / 背景」两个标签 */
QTabWidget::pane {{
    border: 1px solid {BORDER};
    border-radius: 10px;
    background: {SURFACE};
    top: -1px;
}}
QTabBar::tab {{
    background: transparent;
    color: {TEXT_MUTED};
    padding: 7px 18px;
    border: none;
    border-bottom: 2px solid transparent;
}}
QTabBar::tab:selected {{ color: {TEXT}; border-bottom-color: {ACCENT}; }}
QTabBar::tab:hover {{ color: {TEXT}; }}
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 4px 2px; }}
QScrollBar::handle:vertical {{ background: #c8d1de; border-radius: 5px; min-height: 28px; }}
QScrollBar::handle:vertical:hover {{ background: #b3bfd0; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}

QPlainTextEdit#Composer {{
    background: {SURFACE_2};
    border: 1px solid {BORDER};
    border-radius: 10px;
    padding: 8px 10px;
    color: {TEXT};
    selection-background-color: #d4e2ff;
}}
QPlainTextEdit#Composer:focus {{ border-color: {ACCENT}; }}

QLineEdit, QComboBox, QSpinBox {{
    background: {SURFACE_2};
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 7px 10px;
    color: {TEXT};
    min-height: 18px;
}}
QLineEdit:focus, QComboBox:focus, QSpinBox:focus {{ border-color: {ACCENT}; }}

QComboBox::drop-down {{
    subcontrol-origin: padding;
    subcontrol-position: center right;
    width: 20px;
    border: none;
    background: transparent;
}}
QComboBox QAbstractItemView {{
    background: {SURFACE_2};
    border: 1px solid {BORDER};
    color: {TEXT};
    selection-background-color: #d4e2ff;
    selection-color: {TEXT};
    outline: none;
    padding: 4px;
}}

QComboBox::drop-down {{
    subcontrol-origin: padding;
    subcontrol-position: center right;
    width: 22px;
    border: none;
    background: transparent;
}}
QComboBox::down-arrow {{
    image: url("{ARROW_DOWN}");
    width: 10px;
    height: 7px;
    margin-right: 6px;
}}

QSpinBox::up-button, QSpinBox::down-button {{
    width: 20px;
    background: transparent;
    border: none;
}}
QSpinBox::up-button:hover, QSpinBox::down-button:hover {{ background: #e2e8f2; border-radius: 4px; }}
QSpinBox::up-arrow {{ image: url("{ARROW_UP}"); width: 10px; height: 7px; }}
QSpinBox::down-arrow {{ image: url("{ARROW_DOWN}"); width: 10px; height: 7px; }}

QSpinBox::up-button, QSpinBox::down-button {{
    width: 18px;
    background: transparent;
    border: none;
}}

QListWidget {{
    background: {SURFACE};
    border: 1px solid {BORDER};
    border-radius: 10px;
    padding: 4px;
}}
QListWidget::item {{ padding: 8px; border-radius: 6px; }}
QListWidget::item:hover {{ background: {SURFACE_2}; }}
QListWidget::item:selected {{ background: #e3ecfb; color: {TEXT}; }}

QFrame#Card {{
    background: {SURFACE};
    border: 1px solid {BORDER};
    border-radius: 12px;
}}
QFrame#BubbleUser {{ background: {ACCENT_DIM}; border: none; border-radius: 12px; }}
QFrame#BubbleAssistant {{ background: {SURFACE_2}; border: 1px solid {BORDER}; border-radius: 12px; }}
QFrame#BubbleProactive {{ background: #fff8e8; border: 1px solid #f0dcb2; border-radius: 12px; }}
QFrame#BubbleSystem {{ background: rgba(255, 255, 255, 0.72); border: none; border-radius: 10px; }}

QLabel#BubbleText {{ color: {TEXT}; font-size: 13px; line-height: 1.55; }}
QLabel#BubbleTextUser {{ color: #ffffff; font-size: 13px; }}
QLabel#BubbleMeta {{ color: {TEXT_MUTED}; font-size: 11px; }}
QFrame#BubbleUser QLabel#BubbleMeta {{ color: rgba(255, 255, 255, 0.78); }}

QMenuBar {{ background: {SURFACE}; }}
QMenuBar::item {{ padding: 4px 8px; border-radius: 4px; background: transparent; }}
QMenuBar::item:selected {{ background: {SURFACE_2}; }}
QMenu {{ background: {SURFACE}; border: 1px solid {BORDER}; padding: 4px; }}
QMenu::item {{ padding: 6px 22px 6px 14px; border-radius: 6px; }}
QMenu::item:selected {{ background: #eaf0fa; }}
QStatusBar {{ background: {SURFACE}; border-top: 1px solid {BORDER}; color: {TEXT_MUTED}; }}
QToolTip {{
    background: {SURFACE};
    color: {TEXT};
    border: 1px solid {BORDER};
    padding: 6px;
}}
"""


def apply_palette(app) -> None:
    """浅色 QPalette。

    QSS 管不到的细节（QComboBox 的箭头、QSpinBox 的上下键、原生对话框）
    由样式引擎按调色板绘制，所以必须连 palette 一起设成浅色，
    否则这些子控件会保留系统默认或出现深底黑字。
    """
    from PySide6.QtGui import QColor, QPalette

    # Fusion 能稳定按调色板绘制箭头/滚动条；Windows 原生样式会忽略部分设置
    app.setStyle("Fusion")

    p = QPalette()
    p.setColor(QPalette.ColorRole.Window, QColor(BG))
    p.setColor(QPalette.ColorRole.WindowText, QColor(TEXT))
    p.setColor(QPalette.ColorRole.Base, QColor(SURFACE))
    p.setColor(QPalette.ColorRole.AlternateBase, QColor(SURFACE_2))
    p.setColor(QPalette.ColorRole.Text, QColor(TEXT))
    p.setColor(QPalette.ColorRole.Button, QColor(SURFACE_2))
    p.setColor(QPalette.ColorRole.ButtonText, QColor(TEXT))
    p.setColor(QPalette.ColorRole.BrightText, QColor("#000000"))
    p.setColor(QPalette.ColorRole.Highlight, QColor(ACCENT_DIM))
    p.setColor(QPalette.ColorRole.HighlightedText, QColor("#ffffff"))
    p.setColor(QPalette.ColorRole.ToolTipBase, QColor(SURFACE))
    p.setColor(QPalette.ColorRole.ToolTipText, QColor(TEXT))
    p.setColor(QPalette.ColorRole.PlaceholderText, QColor("#9aa4b4"))
    p.setColor(QPalette.ColorRole.Link, QColor(ACCENT))

    for role in (QPalette.ColorRole.WindowText, QPalette.ColorRole.Text, QPalette.ColorRole.ButtonText):
        p.setColor(QPalette.ColorGroup.Disabled, role, QColor("#a2abba"))
    app.setPalette(p)
