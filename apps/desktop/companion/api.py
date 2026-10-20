"""companion 桌面端 · 后端接口客户端。

只用 PySide6 自带能力：QNetworkAccessManager 负责 HTTP，SSE 靠 readyRead 增量解析。
不依赖 requests / httpx —— 系统 Python 里也没有装。

约定：所有回调都通过 Qt 信号发回主线程，网络回调里不碰 UI。
"""

from __future__ import annotations

import codecs
import json
import uuid
from typing import Any

from PySide6.QtCore import QByteArray, QObject, QUrl, Signal
from PySide6.QtNetwork import QNetworkAccessManager, QNetworkReply, QNetworkRequest


class ApiClient(QObject):
    """登录、流式对话、待读消息、历史、记忆检索。"""

    # 连接状态
    healthOk = Signal(dict)
    healthFailed = Signal(str)
    loggedIn = Signal(dict)
    authFailed = Signal(str)

    # 流式对话
    metaReceived = Signal(dict)
    tokenReceived = Signal(str)
    streamDone = Signal(dict)
    streamFailed = Signal(str)
    streamAborted = Signal()

    # 其他
    pendingReceived = Signal(list)
    historyReceived = Signal(list)
    searchReceived = Signal(list)
    notesReceived = Signal(list)
    noteCreated = Signal(dict)
    noteDeleted = Signal(int)
    insightsReceived = Signal(list)
    meReceived = Signal(dict)
    requestFailed = Signal(str, str)  # (场景, 错误信息)

    def __init__(self, base_url: str = "http://127.0.0.1:3000", parent: QObject | None = None):
        super().__init__(parent)
        self.nam = QNetworkAccessManager(self)
        self.base_url = base_url.rstrip("/")
        self.token: str | None = None
        self.user_id: int | None = None

        self._stream_reply: QNetworkReply | None = None
        self._stream_buffer = ""
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._aborted = False

    # ---------------------------------------------------------------- 基础

    def _req(
        self,
        path: str,
        auth: bool = True,
        accept: str = "application/json",
        with_body: bool = True,
    ) -> QNetworkRequest:
        req = QNetworkRequest(QUrl(f"{self.base_url}{path}"))
        # DELETE 没有 body 时不能带 Content-Type: application/json，
        # 否则 Fastify 会报 "Body cannot be empty when content-type is set"
        if with_body:
            req.setHeader(QNetworkRequest.KnownHeaders.ContentTypeHeader, "application/json")
        req.setRawHeader(QByteArray(b"Accept"), QByteArray(accept.encode()))
        if auth and self.token:
            req.setRawHeader(QByteArray(b"Authorization"), QByteArray(f"Bearer {self.token}".encode()))
        return req

    @staticmethod
    def _body(payload: dict[str, Any] | None) -> QByteArray:
        return QByteArray(json.dumps(payload or {}, ensure_ascii=False).encode("utf-8"))

    @staticmethod
    def _error_text(reply: QNetworkReply) -> str:
        status = reply.attribute(QNetworkRequest.Attribute.HttpStatusCodeAttribute)
        raw = bytes(reply.readAll()).decode("utf-8", "replace").strip()
        detail = ""
        if raw:
            try:
                parsed = json.loads(raw)
                detail = str(parsed.get("message") or parsed.get("error") or raw[:160])
            except (ValueError, AttributeError):
                detail = raw[:160]
        if status:
            return f"HTTP {status}{'：' + detail if detail else ''}"
        return reply.errorString() or detail or "网络错误"

    # ---------------------------------------------------------------- 健康检查

    def check_health(self) -> None:
        reply = self.nam.get(self._req("/healthz", auth=False))

        def done() -> None:
            reply.deleteLater()
            if reply.error() != QNetworkReply.NetworkError.NoError:
                self.healthFailed.emit(self._error_text(reply))
                return
            try:
                self.healthOk.emit(json.loads(bytes(reply.readAll()).decode("utf-8")))
            except ValueError:
                self.healthFailed.emit("健康检查返回的不是 JSON")

        reply.finished.connect(done)

    # ---------------------------------------------------------------- 登录

    def login(self, openid: str = "dev-openid-001") -> None:
        reply = self.nam.post(self._req("/auth/dev", auth=False), self._body({"openid": openid}))

        def done() -> None:
            reply.deleteLater()
            if reply.error() != QNetworkReply.NetworkError.NoError:
                self.authFailed.emit(self._error_text(reply))
                return
            try:
                data = json.loads(bytes(reply.readAll()).decode("utf-8"))
            except ValueError:
                self.authFailed.emit("登录返回的不是 JSON")
                return
            self.token = data.get("token")
            self.user_id = data.get("userId")
            self.loggedIn.emit(data)

        reply.finished.connect(done)

    # ---------------------------------------------------------------- 流式对话

    def send_message(self, message: str, session_id: str | None = None) -> None:
        if not self.token:
            self.streamFailed.emit("尚未登录")
            return
        if self._stream_reply is not None:
            self.abort_stream()

        self._aborted = False
        self._stream_buffer = ""
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")

        payload = {"message": message}
        if session_id:
            payload["sessionId"] = session_id

        reply = self.nam.post(
            self._req("/chat/stream", accept="text/event-stream"),
            self._body(payload),
        )
        self._stream_reply = reply
        reply.readyRead.connect(self._on_stream_ready)
        reply.finished.connect(lambda: self._on_stream_finished(reply))

    def abort_stream(self) -> None:
        if self._stream_reply is None:
            return
        self._aborted = True
        self._stream_reply.abort()

    def _on_stream_ready(self) -> None:
        reply = self._stream_reply
        if reply is None:
            return
        chunk = bytes(reply.readAll())
        if not chunk:
            return
        self._stream_buffer += self._decoder.decode(chunk).replace("\r\n", "\n")
        while "\n\n" in self._stream_buffer:
            block, self._stream_buffer = self._stream_buffer.split("\n\n", 1)
            self._handle_block(block)

    def _handle_block(self, block: str) -> None:
        event = "message"
        data_lines: list[str] = []
        for line in block.split("\n"):
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
        if not data_lines:
            return
        raw = "\n".join(data_lines)
        try:
            payload = json.loads(raw)
        except ValueError:
            return

        if event == "meta":
            self.metaReceived.emit(payload)
        elif event == "token":
            text = payload.get("text")
            if text:
                self.tokenReceived.emit(str(text))
        elif event == "done":
            self.streamDone.emit(payload)
        elif event == "error":
            self.streamFailed.emit(str(payload.get("message") or payload.get("error") or "生成失败"))

    def _on_stream_finished(self, reply: QNetworkReply) -> None:
        if self._stream_reply is reply:
            self._stream_reply = None

        aborted = self._aborted
        self._aborted = False
        # 收尾时可能还有半个块没吐完
        tail = self._decoder.decode(b"", final=True).replace("\r\n", "\n")
        if tail:
            self._stream_buffer += tail
        if self._stream_buffer.strip():
            self._handle_block(self._stream_buffer)
            self._stream_buffer = ""

        if aborted:
            reply.deleteLater()
            self.streamAborted.emit()
            return
        if reply.error() != QNetworkReply.NetworkError.NoError:
            self.streamFailed.emit(self._error_text(reply))
        reply.deleteLater()

    # ---------------------------------------------------------------- 待读 / 历史 / 检索

    def fetch_pending(self) -> None:
        reply = self.nam.get(self._req("/proactive/pending"))

        def done() -> None:
            reply.deleteLater()
            if reply.error() != QNetworkReply.NetworkError.NoError:
                self.requestFailed.emit("待读消息", self._error_text(reply))
                return
            try:
                data = json.loads(bytes(reply.readAll()).decode("utf-8"))
                self.pendingReceived.emit(list(data.get("items") or []))
            except ValueError:
                self.requestFailed.emit("待读消息", "返回不是 JSON")

        reply.finished.connect(done)

    def fetch_history(self, session_id: str, limit: int = 30) -> None:
        reply = self.nam.get(self._req(f"/chat/history?sessionId={session_id}&limit={limit}"))

        def done() -> None:
            reply.deleteLater()
            if reply.error() != QNetworkReply.NetworkError.NoError:
                self.requestFailed.emit("历史消息", self._error_text(reply))
                return
            try:
                data = json.loads(bytes(reply.readAll()).decode("utf-8"))
                self.historyReceived.emit(list(data.get("items") or []))
            except ValueError:
                self.requestFailed.emit("历史消息", "返回不是 JSON")

        reply.finished.connect(done)

    def search_memory(self, query: str, top_k: int = 8) -> None:
        reply = self.nam.get(self._req(f"/memory/search?q={QUrl.toPercentEncoding(query).data().decode()}&topK={top_k}"))

        def done() -> None:
            reply.deleteLater()
            if reply.error() != QNetworkReply.NetworkError.NoError:
                self.requestFailed.emit("记忆检索", self._error_text(reply))
                return
            try:
                data = json.loads(bytes(reply.readAll()).decode("utf-8"))
                self.searchReceived.emit(list(data.get("items") or []))
            except ValueError:
                self.requestFailed.emit("记忆检索", "返回不是 JSON")

        reply.finished.connect(done)

    # ---------------------------------------------------------------- 笔记 / 洞察 / 我的状态

    def fetch_notes(self, limit: int = 50) -> None:
        reply = self.nam.get(self._req(f"/notes?limit={limit}"))

        def done() -> None:
            reply.deleteLater()
            if reply.error() != QNetworkReply.NetworkError.NoError:
                self.requestFailed.emit("笔记列表", self._error_text(reply))
                return
            try:
                data = json.loads(bytes(reply.readAll()).decode("utf-8"))
                self.notesReceived.emit(list(data.get("items") or []))
            except ValueError:
                self.requestFailed.emit("笔记列表", "返回不是 JSON")

        reply.finished.connect(done)

    def create_note(self, title: str, content: str) -> None:
        reply = self.nam.post(self._req("/notes"), self._body({"title": title, "content": content}))

        def done() -> None:
            reply.deleteLater()
            if reply.error() != QNetworkReply.NetworkError.NoError:
                self.requestFailed.emit("新建笔记", self._error_text(reply))
                return
            try:
                self.noteCreated.emit(json.loads(bytes(reply.readAll()).decode("utf-8")))
            except ValueError:
                self.noteCreated.emit({})

        reply.finished.connect(done)

    def delete_note(self, note_id: int) -> None:
        reply = self.nam.deleteResource(self._req(f"/notes/{note_id}", with_body=False))

        def done() -> None:
            reply.deleteLater()
            if reply.error() != QNetworkReply.NetworkError.NoError:
                self.requestFailed.emit("删除笔记", self._error_text(reply))
                return
            self.noteDeleted.emit(note_id)

        reply.finished.connect(done)

    def fetch_insights(self, limit: int = 30, include_superseded: bool = True) -> None:
        flag = '1' if include_superseded else '0'
        reply = self.nam.get(self._req(f"/insights?limit={limit}&includeSuperseded={flag}"))

        def done() -> None:
            reply.deleteLater()
            if reply.error() != QNetworkReply.NetworkError.NoError:
                self.requestFailed.emit("洞察", self._error_text(reply))
                return
            try:
                data = json.loads(bytes(reply.readAll()).decode("utf-8"))
                self.insightsReceived.emit(list(data.get("items") or []))
            except ValueError:
                self.requestFailed.emit("洞察", "返回不是 JSON")

        reply.finished.connect(done)

    def fetch_me(self) -> None:
        reply = self.nam.get(self._req("/me"))

        def done() -> None:
            reply.deleteLater()
            if reply.error() != QNetworkReply.NetworkError.NoError:
                self.requestFailed.emit("我的状态", self._error_text(reply))
                return
            try:
                self.meReceived.emit(json.loads(bytes(reply.readAll()).decode("utf-8")))
            except ValueError:
                self.requestFailed.emit("我的状态", "返回不是 JSON")

        reply.finished.connect(done)


def new_session_id() -> str:
    return str(uuid.uuid4())