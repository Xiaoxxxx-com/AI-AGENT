"""字体解析：优先用系统里的中文字体，实在没有就显式注册字体文件。

为什么需要：某些运行环境（沙箱、精简版 Qt 部署、远程会话）里
QFontDatabase.families() 可能是空的，此时界面上的中文会全部变成方块。
显式 addApplicationFont 能兜住这种情况。
"""

from __future__ import annotations

import os
from pathlib import Path

from PySide6.QtGui import QFont, QFontDatabase
from PySide6.QtWidgets import QApplication

# 按优先级排列：微软雅黑 UI → 雅黑 → 苹方 → 思源 → 黑体 → 宋体 → 西文兜底
CANDIDATES = (
    "Microsoft YaHei UI",
    "Microsoft YaHei",
    "微软雅黑",
    "PingFang SC",
    "Source Han Sans SC",
    "Noto Sans CJK SC",
    "SimHei",
    "SimSun",
    "Segoe UI",
)

FONT_FILES = (
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyhl.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
)


def resolve_family() -> str:
    families = set(QFontDatabase.families())
    for name in CANDIDATES:
        if name in families:
            return name

    # 字体库为空或不含中文字体：直接注册文件
    for path in FONT_FILES:
        if not os.path.exists(path):
            continue
        font_id = QFontDatabase.addApplicationFont(str(path))
        if font_id < 0:
            continue
        loaded = QFontDatabase.applicationFontFamilies(font_id)
        if loaded:
            return loaded[0]

    return QApplication.font().family() or "Sans Serif"


def apply_app_font(app: QApplication, point_size: int = 10) -> str:
    family = resolve_family()
    font = QFont(family, point_size)
    font.setStyleHint(QFont.StyleHint.SansSerif)
    font.setHintingPreference(QFont.HintingPreference.PreferDefaultHinting)
    app.setFont(font)
    return family


def mono_family() -> str:
    for name in ("Cascadia Mono", "Consolas", "JetBrains Mono", "Courier New"):
        if name in set(QFontDatabase.families()):
            return name
    return "monospace"


def font_file_dir() -> Path:
    return Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
