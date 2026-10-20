"""无界面联调：直接验证登录 + SSE 流式 + 待读消息。

    python tools/api_smoke.py [base_url]

前提：后端已启动（pnpm pg:wasm / pnpm mock:llm / pnpm dev:wasm）。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from PySide6.QtCore import QCoreApplication, QTimer  # noqa: E402

from companion.api import ApiClient, new_session_id  # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000"

app = QCoreApplication(sys.argv[:1])
client = ApiClient(BASE)

state = {"tokens": 0, "text": "", "meta": None, "done": False, "failed": None, "pending": None}
failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {name}{(' · ' + detail) if detail else ''}")
    if not ok:
        failures.append(name)


def on_health(payload: dict) -> None:
    db_ok = payload.get("checks", {}).get("db", {}).get("ok")
    check("健康检查", bool(db_ok), f"db={db_ok}")
    client.login("seed-openid-001")


client.healthOk.connect(on_health)
client.healthFailed.connect(lambda m: check("健康检查", False, m))
client.authFailed.connect(lambda m: check("登录", False, m))


def on_login(payload: dict) -> None:
    check("登录", bool(payload.get("token")), f"userId={payload.get('userId')}")
    client.fetch_pending()
    client.send_message("今天有点累，随便说句话就行", new_session_id())


client.loggedIn.connect(on_login)


def on_meta(payload: dict) -> None:
    state["meta"] = payload
    ctx = payload.get("context") or {}
    check("收到 meta", payload.get("sessionId") is not None, f"hits={ctx.get('hits')}")


def on_token(text: str) -> None:
    state["tokens"] += 1
    state["text"] += text


def on_pending(items: list) -> None:
    state["pending"] = len(items)
    check("待读接口", isinstance(items, list), f"{len(items)} 条")


def on_fail(message: str) -> None:
    state["failed"] = message
    check("流式对话", False, message)


def on_done(payload: dict) -> None:
    state["done"] = True
    check("流式对话", state["tokens"] >= 2, f"{state['tokens']} 个 token，共 {len(state['text'])} 字")
    print(f"  回复片段: {state['text'][:60]!r}")
    finish()


client.metaReceived.connect(on_meta)
client.tokenReceived.connect(on_token)
client.streamDone.connect(on_done)
client.streamFailed.connect(on_fail)
client.pendingReceived.connect(on_pending)
client.requestFailed.connect(lambda scene, msg: check(scene, False, msg))


def finish() -> None:
    check("待读接口已调用", state["pending"] is not None)
    print()
    if failures:
        print(f"{len(failures)} 项失败: {', '.join(failures)}")
        app.exit(1)
    else:
        print("联调通过")
        app.exit(0)


QTimer.singleShot(0, client.check_health)
QTimer.singleShot(20000, lambda: (check("整体超时", False, "20s 未完成"), finish()))
sys.exit(app.exec())
