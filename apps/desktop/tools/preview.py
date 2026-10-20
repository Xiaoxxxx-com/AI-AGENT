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
    theme.apply_palette(app)
    app.setStyleSheet(theme.QSS)
    apply_app_font(app, 10)

    window = MainWindow(autostart=False)
    window.resize(880, 700)
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
    panel_shot(out_dir)

    window.chat.clear()
    window._on_offline("Connection refused（后端进程没起）")
    window.show()
    shot(window, out_dir / "preview-offline.png")


def panel_shot(out_dir: Path) -> None:
    """记忆抽屉：笔记 / 洞察 / 状态，用假数据渲染，不依赖后端。"""
    from datetime import datetime, timedelta, timezone

    app = QApplication.instance()
    assert app is not None

    window = MainWindow(autostart=False)
    window.resize(1080, 720)
    window.online = True
    window.dot.set_state("online")
    window.subtitle.setText("在线 · userId=1")
    window.stack.setCurrentIndex(0)
    window.chat.clear()
    window.chat.add("system", "已连接 http://127.0.0.1:3000，会话 8f3c1d2a")
    window.chat.add("user", "今天在公司被领导当众说了，有点没缓过来。").stamp()
    reply = window.chat.add(
        "assistant",
        "被当众说，那种下不来台的感觉会留很久。\n"
        "你之前提过这个项目已经连着加了两周班——如果本来就在硬撑，"
        "再被这样说一句，很难不往心里去。\n今晚还打算接着做吗，还是先停一停？",
    )
    reply.set_meta("记忆 12 条 · 1124 tokens · 2.4s")
    reply.stamp()

    now = datetime.now(timezone.utc)
    window.panel.setVisible(True)
    window.panel_btn.setText("收起")
    window.panel.tabs.setCurrentIndex(0)
    window.panel._on_notes(
        [
            {"id": 331, "title": "被当众说了一句", "content": "周会上汇报，被领导打断说方案太粗。回来坐着，手一直在抖。", "createdAt": now.isoformat(), "hasEmbedding": True},
            {"id": 330, "title": "妈妈的膝盖手术", "content": "下周住院，小手术。她说不用我回去，我还是请了两天假。", "createdAt": (now - timedelta(days=1)).isoformat(), "hasEmbedding": True},
            {"id": 329, "title": "夜跑第三天", "content": "跑到两公里开始喘，但跑完之后睡得比以前好。", "createdAt": (now - timedelta(days=2)).isoformat(), "hasEmbedding": True},
            {"id": 328, "title": "房子", "content": "房东说涨租五百，算了算存款，搬还是不搬都难。", "createdAt": (now - timedelta(days=3)).isoformat(), "hasEmbedding": False},
        ]
    )
    window.panel._on_insights(
        [
            {"id": 12, "type": "concern", "content": "工作评价对情绪影响很大，被否定后会反复回想", "confidence": 0.82, "noteIds": [331, 310, 288], "isActive": True},
            {"id": 11, "type": "pattern", "content": "压力大时会开始夜跑，跑步是有效的自我调节", "confidence": 0.74, "noteIds": [329, 312], "isActive": True},
            {"id": 9, "type": "preference", "content": "更希望被倾听而不是被给建议", "confidence": 0.68, "noteIds": [301], "isActive": False, "supersededBy": 12, "supersededReason": "被 #12 的更新理解取代"},
        ]
    )
    window.panel._on_me(
        {
            "user": {"dailyProactiveCap": 3, "subscriptionQuota": 2, "quietStart": "23:00:00", "quietEnd": "08:00:00"},
            "state": {
                "current_mood": "low",
                "energy": 0.42,
                "consecutive_ignored": 1,
                "cooldown_until": (now + timedelta(hours=6)).isoformat(),
                "daily_proactive_count": 1,
                "last_user_message_at": (now - timedelta(minutes=12)).isoformat(),
                "last_proactive_at": (now - timedelta(hours=3)).isoformat(),
                "next_heartbeat_at": (now + timedelta(minutes=18)).isoformat(),
            },
        }
    )
    window.show()
    shot(window, out_dir / "preview-panel.png")

    for index, name in ((1, "preview-panel-insights.png"), (2, "preview-panel-state.png")):
        window.panel.tabs.setCurrentIndex(index)
        for _ in range(5):
            app.processEvents()
        window.panel.grab().save(str(out_dir / name))
        print(f"saved {out_dir / name}")


if __name__ == "__main__":
    main()
