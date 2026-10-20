"""本地后端的生命周期：设置页启动，关窗时结束自己启动的进程树。

启动顺序是 PGlite(5433) → 等端口就绪 → API(3000)，因为 API 启动时会先探活数据库，
数据库没起来会直接退出。只结束本程序启动的子进程，用户自己在终端里开的服务不受影响。
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QObject, QTimer, Signal

DESKTOP_DIR = Path(__file__).resolve().parent.parent
ROOT = DESKTOP_DIR.parent.parent  # companion/
LOG_PATH = ROOT / "var" / "desktop-backend.log"
TSX_CLI = ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"

DB_PORT = 5433
API_PORT = 3000
START_TIMEOUT = 75.0

# 不弹控制台窗口；子进程的输出去 var/desktop-backend.log
CREATE_NO_WINDOW = 0x08000000


def port_open(port: int, host: str = "127.0.0.1", timeout: float = 0.2) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, port)) == 0


def find_node() -> str:
    """按 PATH → 常见安装位置 → WorkBuddy 自带运行时的顺序找 node.exe。

    本机实测 node 不在 PATH 里，只有 .workbuddy 下的 22.22.2 可用，
    所以这里不能只依赖 shutil.which。
    """
    found = shutil.which("node")
    if found:
        return found

    candidates: list[Path] = []
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates.append(Path(local) / "Programs" / "nodejs" / "node.exe")
    candidates.append(Path("C:/Program Files/nodejs/node.exe"))
    versions = Path.home() / ".workbuddy" / "binaries" / "node" / "versions"
    if versions.is_dir():
        candidates.extend(sorted(versions.glob("*/node.exe"), reverse=True))
    for path in candidates:
        if path.is_file():
            return str(path)
    return ""


class BackendController(QObject):
    """PGlite + API 的启停控制器。

    state: stopped / starting / running / external / error
    """

    stateChanged = Signal(str, str)  # state, detail
    ready = Signal()

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self._procs: dict[str, subprocess.Popen] = {}
        self._state = "stopped"
        self._detail = ""
        self._phase = ""
        self._log = None
        self._node = ""
        self._deadline = 0.0

        self._timer = QTimer(self)
        self._timer.setInterval(350)
        self._timer.timeout.connect(self._poll)

    @property
    def state(self) -> str:
        return self._state

    @property
    def detail(self) -> str:
        return self._detail

    # -- 外部接口
    def probe(self) -> None:
        """打开设置页时探一下：3000 已有服务但不是本程序起的，就别显示成「未启动」。"""
        if self._state == "stopped" and not self._procs and port_open(API_PORT):
            self._set_state(
                "external",
                f"{API_PORT} 已有服务在运行，不是本程序启动的，关闭窗口不会结束它",
            )

    def start(self) -> str:
        """启动后端。返回错误信息（空串表示已开始启动）。"""
        if self._state in ("starting", "running"):
            return ""
        # 3000 已有服务：可能是用户上次自己开的，不接管、也不在关窗时杀掉
        if port_open(API_PORT):
            self._set_state(
                "external",
                f"{API_PORT} 已有服务在运行，不是本程序启动的，关闭窗口不会结束它",
            )
            return ""

        node = find_node()
        if not node:
            return "找不到 Node.js（需要 20 或更高版本），请安装后重试"
        if not TSX_CLI.is_file():
            return f"缺少 {TSX_CLI.relative_to(ROOT).as_posix()}，请先在 companion 目录执行 pnpm install"

        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        self._log = open(LOG_PATH, "ab", buffering=0)
        self._log.write(f"\n===== {datetime.now():%Y-%m-%d %H:%M:%S} 启动 =====\n".encode())
        self._node = node

        self._deadline = time.monotonic() + START_TIMEOUT
        if port_open(DB_PORT):
            # 数据库已在跑（可能是用户自己开的），只启 API
            if not self._spawn("api", node):
                return ""
            self._phase = "api"
            self._set_state("starting", f"检测到 {DB_PORT} 上的数据库，正在启动 API…")
        else:
            if not self._spawn("db", node):
                return ""
            self._phase = "db"
            self._set_state("starting", "正在启动数据库（PGlite 5433）…")

        self._timer.start()
        return ""

    def stop(self) -> None:
        self._timer.stop()
        self._phase = ""
        self._kill_all()
        self._set_state("stopped", "")

    # -- 内部
    def _spawn(self, name: str, node: str) -> bool:
        script = "scripts/pglite-server.ts" if name == "db" else "scripts/dev-wasm.ts"
        try:
            self._procs[name] = subprocess.Popen(
                [node, str(TSX_CLI), script],
                cwd=str(ROOT),
                stdin=subprocess.DEVNULL,
                stdout=self._log,
                stderr=subprocess.STDOUT,
                creationflags=CREATE_NO_WINDOW,
            )
        except OSError as exc:
            self._fail(f"无法启动{'数据库' if name == 'db' else 'API'}：{exc}")
            return False
        return True

    def _poll(self) -> None:
        for name, proc in list(self._procs.items()):
            code = proc.poll()
            if code is not None:
                label = "数据库" if name == "db" else "API"
                self._fail(f"{label} 进程已退出（代码 {code}），详情看 var/desktop-backend.log")
                return

        if self._phase == "db" and port_open(DB_PORT):
            if self._spawn("api", self._node):
                self._phase = "api"
                self._set_state("starting", "数据库已就绪，正在启动 API（3000）…")
        elif self._phase == "api" and port_open(API_PORT):
            self._timer.stop()
            self._phase = ""
            self._set_state("running", "由本程序托管，关闭窗口时自动结束")
            self.ready.emit()
            return

        if time.monotonic() >= self._deadline:
            self._fail("启动超时，详情看 var/desktop-backend.log")

    def _fail(self, detail: str) -> None:
        self._timer.stop()
        self._phase = ""
        self._kill_all()
        self._set_state("error", detail)

    def _kill_all(self) -> None:
        procs, self._procs = self._procs, {}
        for proc in procs.values():
            if proc.poll() is not None:
                continue
            try:
                # /T 连子进程一起结束：node → tsx → server
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    capture_output=True,
                    creationflags=CREATE_NO_WINDOW,
                    timeout=10,
                )
            except (OSError, subprocess.SubprocessError):
                pass
        if self._log is not None:
            try:
                self._log.close()
            except OSError:
                pass
            self._log = None

    def _set_state(self, state: str, detail: str) -> None:
        self._state = state
        self._detail = detail
        self.stateChanged.emit(state, detail)
