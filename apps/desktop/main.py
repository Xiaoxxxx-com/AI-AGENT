"""陪伴 · 桌面端入口。

    python main.py

依赖：系统 Python 3.12 自带的 PySide6 6.9（无需额外安装）。
"""

from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication

from companion import theme
from companion.fonts import apply_app_font
from companion.window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("陪伴")
    app.setOrganizationName("companion")
    app.setStyleSheet(theme.QSS)

    family = apply_app_font(app, 10)
    if not family:
        print("[warn] 没有找到可用字体，中文可能显示为方块", file=sys.stderr)

    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
