"""配置器自检：.env 读写保真 + 连通性探测 + 界面预览图。

    python tools/config_smoke.py                      # 读写 + 探测（会打 mock）
    python tools/config_smoke.py --shot out.png       # 离屏渲染配置器
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent.parent))

from PySide6.QtCore import QCoreApplication, QTimer  # noqa: E402

from companion.envfile import EnvFile  # noqa: E402
from companion.probe import Prober  # noqa: E402

MOCK = os.environ.get("MOCK_BASE", "http://127.0.0.1:4010/v1")
failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {name}{(' · ' + detail) if detail else ''}")
    if not ok:
        failures.append(name)


def test_envfile() -> None:
    print("envfile")
    source = ROOT.parent.parent / "companion" / ".env"
    if not source.exists():
        source = ROOT.parent.parent / ".env"
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / ".env"
        shutil.copy(source, target)
        original = target.read_text(encoding="utf-8")

        env = EnvFile(target).load()
        original_key = env.get("DEEPSEEK_MODEL")
        env.set("DEEPSEEK_MODEL", "deepseek-v4-pro")
        env.set("PROBE_NEW_KEY", "hello world")
        env.save()

        after = target.read_text(encoding="utf-8")
        reloaded = EnvFile(target).load()

        check("改值生效", reloaded.get("DEEPSEEK_MODEL") == "deepseek-v4-pro", f"{original_key} → deepseek-v4-pro")
        check("新键被追加", reloaded.get("PROBE_NEW_KEY") == "hello world")
        check("注释保留", "#" in after and after.count("#") >= original.count("#"))
        check("原有其他键未变", reloaded.get("DATABASE_URL") == EnvFile(source).load().get("DATABASE_URL"))
        check("带空格的值加了引号", 'PROBE_NEW_KEY="hello world"' in after)


def test_probe() -> None:
    print("probe")
    app = QCoreApplication.instance() or QCoreApplication([])
    prober = Prober()
    results = {"llm": None, "emb": None}

    def on_llm(ok: bool, message: str) -> None:
        results["llm"] = (ok, message)
        if results["emb"] is not None:
            finished()

    def on_emb(ok: bool, message: str, dim: int) -> None:
        results["emb"] = (ok, message, dim)
        if results["llm"] is not None:
            finished()

    def finished() -> None:
        ok_llm, msg_llm = results["llm"]  # type: ignore[misc]
        ok_emb, msg_emb, dim = results["emb"]  # type: ignore[misc]
        check("对话接口探测", bool(ok_llm), str(msg_llm))
        check("向量接口探测并量出维度", bool(ok_emb), f"{msg_emb} / dim={dim}")
        check("维度与 mock 一致", dim == 1024, f"dim={dim}")
        app.quit()

    prober.deepseekDone.connect(on_llm)
    prober.embeddingDone.connect(on_emb)
    QTimer.singleShot(0, lambda: (prober.test_deepseek(MOCK, "mock-key", "mock"), prober.test_embedding(MOCK, "mock-key", "bge-m3")))
    QTimer.singleShot(15000, lambda: (check("探测超时", False, "15s"), app.quit()))
    app.exec()


def shot(path: Path) -> None:
    from PySide6.QtWidgets import QApplication

    from companion import theme
    from companion.fonts import apply_app_font

    sys.modules["__main__"].__dict__  # 保持引用，避免被回收
    from configurator import Configurator

    app = QApplication.instance() or QApplication([])
    theme.apply_palette(app)
    app.setStyleSheet(theme.QSS)
    apply_app_font(app, 10)
    window = Configurator()
    window.show()
    for _ in range(6):
        app.processEvents()
    window.grab().save(str(path))
    print(f"saved {path}")


def main() -> int:
    if "--shot" in sys.argv:
        shot(Path(sys.argv[sys.argv.index("--shot") + 1]))
        return 0

    test_envfile()
    test_probe()

    print()
    if failures:
        print(f"{len(failures)} 项失败: {', '.join(failures)}")
        return 1
    print("配置器自检通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
