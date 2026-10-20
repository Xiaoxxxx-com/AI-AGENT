"""配色与全局样式表。深色、低饱和，尽量像原生的陪伴类应用。"""

BG = "#0f1115"
SURFACE = "#171a21"
SURFACE_2 = "#1e222b"
BORDER = "#272c37"
TEXT = "#e7eaf3"
TEXT_MUTED = "#8c95a8"
ACCENT = "#6ea8fe"
ACCENT_DIM = "#2b5cd9"
WARN = "#e0af68"
OK = "#7ee0a1"
DANGER = "#f28b82"

FONT_FAMILY = '"Microsoft YaHei UI", "PingFang SC", "Segoe UI", sans-serif'

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
QPushButton:hover {{ background: #262b36; }}
QPushButton:disabled {{ color: #5b6273; border-color: #22262f; }}
QPushButton#Primary {{
    background: {ACCENT_DIM};
    border: 1px solid {ACCENT_DIM};
    color: #ffffff;
    font-weight: 600;
}}
QPushButton#Primary:hover {{ background: #3468e8; }}
QPushButton#Primary:disabled {{ background: #2a3550; border-color: #2a3550; color: #7e879c; }}
QPushButton#Ghost {{ background: transparent; border: 1px solid transparent; padding: 4px 8px; }}
QPushButton#Ghost:hover {{ background: {SURFACE_2}; border-color: {BORDER}; }}

QScrollArea {{ border: none; background: {BG}; }}
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 4px 2px; }}
QScrollBar::handle:vertical {{ background: #2c3240; border-radius: 5px; min-height: 28px; }}
QScrollBar::handle:vertical:hover {{ background: #3a4252; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}

QPlainTextEdit#Composer {{
    background: {SURFACE_2};
    border: 1px solid {BORDER};
    border-radius: 10px;
    padding: 8px 10px;
    color: {TEXT};
    selection-background-color: #2f4a80;
}}
QPlainTextEdit#Composer:focus {{ border-color: {ACCENT}; }}

QLineEdit {{
    background: {SURFACE_2};
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 7px 10px;
    color: {TEXT};
}}
QLineEdit:focus {{ border-color: {ACCENT}; }}

QListWidget {{
    background: {SURFACE};
    border: 1px solid {BORDER};
    border-radius: 10px;
    padding: 4px;
}}
QListWidget::item {{ padding: 8px; border-radius: 6px; }}
QListWidget::item:selected {{ background: {SURFACE_2}; color: {TEXT}; }}

QFrame#Card {{
    background: {SURFACE};
    border: 1px solid {BORDER};
    border-radius: 12px;
}}
QFrame#BubbleUser {{ background: {ACCENT_DIM}; border: none; border-radius: 12px; }}
QFrame#BubbleAssistant {{ background: {SURFACE_2}; border: 1px solid {BORDER}; border-radius: 12px; }}
QFrame#BubbleProactive {{ background: #211d16; border: 1px solid #4a3d22; border-radius: 12px; }}
QFrame#BubbleSystem {{ background: transparent; border: none; }}

QLabel#BubbleText {{ color: {TEXT}; font-size: 13px; line-height: 1.55; }}
QLabel#BubbleTextUser {{ color: #ffffff; font-size: 13px; }}
QLabel#BubbleMeta {{ color: {TEXT_MUTED}; font-size: 11px; }}

QMenuBar {{ background: {SURFACE}; }}
QMenu {{ background: {SURFACE_2}; border: 1px solid {BORDER}; padding: 4px; }}
QMenu::item {{ padding: 6px 22px 6px 14px; border-radius: 6px; }}
QMenu::item:selected {{ background: #262b36; }}
QStatusBar {{ background: {SURFACE}; border-top: 1px solid {BORDER}; color: {TEXT_MUTED}; }}
QToolTip {{
    background: {SURFACE_2};
    color: {TEXT};
    border: 1px solid {BORDER};
    padding: 6px;
}}
"""
