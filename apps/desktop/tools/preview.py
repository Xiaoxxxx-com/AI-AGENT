"""离屏渲染预览图（不需要显示器，方便在无界面环境检查排版）。

    python tools/preview.py [输出目录]
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from PySide6.QtWidgets import QApplication  # noqa: E402

from companion import theme  # noqa: E402
from companion.fonts import apply_app_font  # noqa: E402
from companion.window import MainWindow  # noqa: E402


def shot(window: MainWindow, path: Path) -> None:
    app = QApplication.instance()
    assert app is not None
    for _ in range(6):
        app.processEvents()
    window.grab().save(str(path))
    print(f"saved {path}")


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent.parent / "var"
    out_dir.mkdir(parents=True, exist_ok=True)

    app = QApplication(sys.argv[:1])
    app.setStyleSheet(theme.QSS)
    apply_app_font(app, 10)

    window = MainWindow(autostart=False)
    window.subtitle.setText("在线 · userId=1")
    window.dot.set_state("online")
    window.status_label.setText("http://127.0.0.1:3000 · userId=1 · session=8f3c1d2a")
    window.stack.setCurrentIndex(0)
    window.chat.clear()

    window.chat.add("system", "已连接 http://127.0.0.1:3000，会话 8f3c1d2a")
    window.chat.add("proactive", "昨天你说项目上线前都在加班，今天还顺利吗？").stamp()
    window.chat.add("user", "今天在公司被领导当众说了，有点没缓过来。").stamp()

    reply = window.chat.add(
        "assistant",
        "被当众说，那种下不来台的感觉会留很久。\n"
        "你之前提过这个项目已经连着加了两周班——如果本来就在硬撑，"
        "再被这样说一句，很难不往心里去。\n"
        "今晚还打算接着做吗，还是先停一停？",
    )
    reply.set_meta("记忆 12 条 · 洞察 0 · 1124 tokens · 2.4s")
    reply.stamp()

    window.chat.add("user", "不太想做了，但又怕拖慢进度。").stamp()
    window.chat.add(
        "assistant",
        "那就先做一件最小的事：把明天必须交出去的部分列出来，其余的往后放。\n"
        "你现在需要的不是再扛一下，是让今晚有个能结束的点。",
    ).stamp()
    window.chat.scroll_to_bottom()

    window.composer.setPlainText("我想先睡了，明天再说")
    window.show()
    shot(window, out_dir / "preview-chat.png")

    window.chat.clear()
    window._on_offline("Connection refused（后端进程没起）")
    window.show()
    shot(window, out_dir / "preview-offline.png")


if __name__ == "__main__":
    main()
