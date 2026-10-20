"""连通性探测：直接打 DeepSeek / embedding 服务，不经过本项目后端。

这样即使后端没起来（改 key 最常见就是这时候），也能先确认 key 有效、维度对得上。
"""

from __future__ import annotations

import json

from PySide6.QtCore import QByteArray, QObject, QUrl, Signal
from PySide6.QtNetwork import QNetworkAccessManager, QNetworkReply, QNetworkRequest


def _join(base: str, path: str) -> str:
    return f"{base.rstrip('/')}/{path.lstrip('/')}"


class Prober(QObject):
    """两个探测：对话（顺带验证 model 名）和向量（顺带量出维度）。"""

    deepseekDone = Signal(bool, str)  # (ok, 说明)
    embeddingDone = Signal(bool, str, int)  # (ok, 说明, 维度)

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self.nam = QNetworkAccessManager(self)

    def _request(self, url: str, key: str) -> QNetworkRequest:
        req = QNetworkRequest(QUrl(url))
        req.setHeader(QNetworkRequest.KnownHeaders.ContentTypeHeader, "application/json")
        if key:
            req.setRawHeader(QByteArray(b"Authorization"), QByteArray(f"Bearer {key}".encode()))
        req.setTransferTimeout(15000)
        return req

    @staticmethod
    def _describe(reply: QNetworkReply) -> str:
        status = reply.attribute(QNetworkRequest.Attribute.HttpStatusCodeAttribute)
        raw = bytes(reply.readAll()).decode("utf-8", "replace").strip()
        if status in (401, 403):
            return f"密钥被拒绝（HTTP {status}），检查 key 是否正确/有无余额"
        if status == 404:
            return f"地址不对（HTTP 404）：{raw[:80] or '检查 Base URL 是否需要带 /v1'}"
        if status and int(status) >= 400:
            return f"HTTP {status}：{raw[:120]}"
        return reply.errorString() or f"HTTP {status}"

    # ------------------------------------------------------------ DeepSeek

    def test_deepseek(self, base_url: str, api_key: str, model: str) -> None:
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
            "stream": False,
        }
        reply = self.nam.post(
            self._request(_join(base_url, "chat/completions"), api_key),
            QByteArray(json.dumps(payload).encode()),
        )

        def done() -> None:
            reply.deleteLater()
            if reply.error() != QNetworkReply.NetworkError.NoError:
                self.deepseekDone.emit(False, self._describe(reply))
                return
            try:
                data = json.loads(bytes(reply.readAll()).decode("utf-8"))
            except ValueError:
                self.deepseekDone.emit(False, "返回不是 JSON，地址可能指向了别的服务")
                return
            used = (data.get("model") or model) if isinstance(data, dict) else model
            self.deepseekDone.emit(True, f"可用，实际模型 {used}")

        reply.finished.connect(done)

    # ------------------------------------------------------------ Embedding

    def test_embedding(self, base_url: str, api_key: str, model: str) -> None:
        payload = {"model": model, "input": ["连通性测试"], "encoding_format": "float"}
        reply = self.nam.post(
            self._request(_join(base_url, "embeddings"), api_key),
            QByteArray(json.dumps(payload, ensure_ascii=False).encode("utf-8")),
        )

        def done() -> None:
            reply.deleteLater()
            if reply.error() != QNetworkReply.NetworkError.NoError:
                self.embeddingDone.emit(False, self._describe(reply), 0)
                return
            try:
                data = json.loads(bytes(reply.readAll()).decode("utf-8"))
                vector = data["data"][0]["embedding"]
                dim = len(vector)
            except (ValueError, KeyError, IndexError, TypeError):
                self.embeddingDone.emit(False, "返回结构不认识，可能不是 OpenAI 兼容的 embedding 接口", 0)
                return
            self.embeddingDone.emit(True, f"{model} 输出 {dim} 维", dim)

        reply.finished.connect(done)
