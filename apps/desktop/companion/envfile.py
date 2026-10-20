"""读写 .env，保留注释、空行和原有顺序。

为什么不直接用 dotenv 的 set_key：它会重排/丢注释，而这个 .env 里有
大量说明性注释（每个变量为什么这么配），丢了以后没人看得懂。
"""

from __future__ import annotations

import re
from pathlib import Path

KEY_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        return value[1:-1]
    return value


def _quote_if_needed(value: str) -> str:
    if not value:
        return ""
    if any(ch in value for ch in (' ', '#', '"', "'")) or value != value.strip():
        return '"' + value.replace('"', '\\"') + '"'
    return value


class EnvFile:
    """一个能被反复改写的 .env。"""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.lines: list[str] = []
        self._updates: dict[str, str] = {}

    # -------------------------------------------------------------- 读写

    def load(self) -> "EnvFile":
        if self.path.exists():
            self.lines = self.path.read_text(encoding="utf-8").splitlines()
        else:
            self.lines = []
        self._updates.clear()
        return self

    def get(self, key: str, default: str = "") -> str:
        if key in self._updates:
            return self._updates[key]
        for line in self.lines:
            match = KEY_RE.match(line)
            if match and match.group(1) == key:
                return _unquote(match.group(2))
        return default

    def set(self, key: str, value: str) -> None:
        self._updates[key] = value

    def as_dict(self) -> dict[str, str]:
        data: dict[str, str] = {}
        for line in self.lines:
            match = KEY_RE.match(line)
            if match:
                data[match.group(1)] = _unquote(match.group(2))
        data.update(self._updates)
        return data

    # -------------------------------------------------------------- 保存

    def save(self) -> Path:
        """把 _updates 合并进原文件：已有键原地替换，新键追加到末尾。"""
        pending = dict(self._updates)
        out: list[str] = []

        for line in self.lines:
            match = KEY_RE.match(line)
            if not match:
                out.append(line)
                continue
            key = match.group(1)
            if key in pending:
                out.append(f"{key}={_quote_if_needed(pending.pop(key))}")
            else:
                out.append(line)

        if pending:
            if out and out[-1].strip():
                out.append("")
            out.append("# --- 由配置器补充 ---")
            for key, value in pending.items():
                out.append(f"{key}={_quote_if_needed(value)}")

        text = "\n".join(out).rstrip("\n") + "\n"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(text, encoding="utf-8")
        self.lines = text.splitlines()
        self._updates.clear()
        return self.path

    # -------------------------------------------------------------- 工具

    def mask(self, key: str, keep: int = 4) -> str:
        value = self.get(key)
        if len(value) <= keep * 2:
            return "*" * len(value)
        return f"{value[:keep]}{'*' * (len(value) - keep * 2)}{value[-keep:]}"
