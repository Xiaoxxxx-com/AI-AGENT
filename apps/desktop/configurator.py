"""可视化配置器：直接读写 companion/.env，不依赖后端是否运行。

    python configurator.py

设计要点：
- 只改值、不动注释，保存后文件里那些「为什么这么配」的说明还在；
- 每个区块自带连通性测试，先测再存，避免带着坏配置重启；
- 维度不一致会当场警告——这是最容易犯又最难查的错（库是 vector(1024)）。
"""

from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from companion import theme
from companion.envfile import EnvFile
from companion.fonts import apply_app_font
from companion.probe import Prober

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
ENV_PATH = PROJECT_ROOT / ".env"

MODELS = ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat"]


class KeyField(QWidget):
    """带显示/隐藏按钮的密钥输入框。"""

    def __init__(self, value: str = "", placeholder: str = "sk-..."):
        super().__init__()
        self.edit = QLineEdit(value)
        self.edit.setEchoMode(QLineEdit.EchoMode.Password)
        self.edit.setPlaceholderText(placeholder)

        self.toggle = QPushButton("显示")
        self.toggle.setObjectName("Ghost")
        self.toggle.setFixedWidth(52)
        self.toggle.setCheckable(True)
        self.toggle.toggled.connect(self._on_toggle)

        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(6)
        row.addWidget(self.edit, 1)
        row.addWidget(self.toggle)

    def _on_toggle(self, shown: bool) -> None:
        self.edit.setEchoMode(QLineEdit.EchoMode.Normal if shown else QLineEdit.EchoMode.Password)
        self.toggle.setText("隐藏" if shown else "显示")

    def text(self) -> str:
        return self.edit.text().strip()

    def setText(self, value: str) -> None:  # noqa: N802 - 与 Qt 命名保持一致
        self.edit.setText(value)


class Section(QFrame):
    def __init__(self, title: str, subtitle: str = ""):
        super().__init__()
        self.setObjectName("Card")
        self.form = QFormLayout()
        self.form.setContentsMargins(18, 16, 18, 16)
        self.form.setSpacing(10)
        self.form.setLabelAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)

        head = QVBoxLayout()
        name = QLabel(title)
        name.setObjectName("AppTitle")
        head.addWidget(name)
        if subtitle:
            sub = QLabel(subtitle)
            sub.setObjectName("Muted")
            head.addWidget(sub)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)
        box = QWidget()
        box.setLayout(self.form)
        layout.addLayout(head)
        layout.addWidget(box)
        layout.setContentsMargins(0, 0, 0, 0)
        self.form.setContentsMargins(18, 4, 18, 16)
        head.setContentsMargins(18, 14, 18, 0)


class Configurator(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("配置 · 陪伴")
        self.resize(720, 760)
        self.setMinimumWidth(640)

        self.env = EnvFile(ENV_PATH).load()
        self.prober = Prober(self)
        self.prober.deepseekDone.connect(self._on_deepseek_done)
        self.prober.embeddingDone.connect(self._on_embedding_done)
        self.dirty = False

        self._build()
        self._load_values()

    # ---------------------------------------------------------------- UI

    def _build(self) -> None:
        root = QWidget()
        outer = QVBoxLayout(root)
        outer.setContentsMargins(20, 16, 20, 16)
        outer.setSpacing(12)

        header = QHBoxLayout()
        title_box = QVBoxLayout()
        title = QLabel("环境配置")
        title.setObjectName("AppTitle")
        self.path_label = QLabel(str(ENV_PATH))
        self.path_label.setObjectName("Muted")
        self.path_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        title_box.addWidget(title)
        title_box.addWidget(self.path_label)

        open_dir = QPushButton("打开所在文件夹")
        open_dir.setObjectName("Ghost")
        open_dir.clicked.connect(self._open_dir)

        header.addLayout(title_box, 1)
        header.addWidget(open_dir)
        outer.addLayout(header)

        # --- 对话模型
        llm = Section("对话模型", "DeepSeek 或任意 OpenAI 兼容服务；改完需要重启后端")
        self.api_key = KeyField()
        self.base_url = QLineEdit()
        self.base_url.setPlaceholderText("https://api.deepseek.com")
        self.model = QComboBox()
        self.model.setEditable(True)
        self.model.addItems(MODELS)
        self.timeout = QSpinBox()
        self.timeout.setRange(1000, 600000)
        self.timeout.setSingleStep(5000)
        self.timeout.setSuffix(" ms")

        self.llm_status = QLabel("未测试")
        self.llm_status.setObjectName("Muted")
        test_llm = QPushButton("测试对话")
        test_llm.clicked.connect(self._test_llm)
        llm_row = QHBoxLayout()
        llm_row.addWidget(test_llm)
        llm_row.addWidget(self.llm_status, 1)

        llm.form.addRow("API Key", self.api_key)
        llm.form.addRow("Base URL", self.base_url)
        llm.form.addRow("模型", self.model)
        llm.form.addRow("超时", self.timeout)
        llm.form.addRow("", self._wrap(llm_row))
        outer.addWidget(llm)

        # --- 向量化
        emb = Section("向量化（Embedding）", "维度必须与数据库 vector(1024) 一致，换模型要重算向量")
        self.emb_key = KeyField(placeholder="ollama（本地服务随便填）")
        self.emb_base = QLineEdit()
        self.emb_base.setPlaceholderText("http://127.0.0.1:11434/v1")
        self.emb_model = QLineEdit()
        self.emb_model.setPlaceholderText("bge-m3")
        self.emb_dim = QSpinBox()
        self.emb_dim.setRange(64, 8192)
        self.emb_dim.setSingleStep(128)

        self.emb_status = QLabel("未测试")
        self.emb_status.setObjectName("Muted")
        test_emb = QPushButton("测试向量")
        test_emb.clicked.connect(self._test_embedding)
        emb_row = QHBoxLayout()
        emb_row.addWidget(test_emb)
        emb_row.addWidget(self.emb_status, 1)

        emb.form.addRow("API Key", self.emb_key)
        emb.form.addRow("Base URL", self.emb_base)
        emb.form.addRow("模型", self.emb_model)
        emb.form.addRow("维度", self.emb_dim)
        emb.form.addRow("", self._wrap(emb_row))
        outer.addWidget(emb)

        # --- 其他
        other = Section("其他", "一般不用改")
        self.db_url = QLineEdit()
        self.db_url.setPlaceholderText("postgres://companion:companion_dev@127.0.0.1:5432/companion")
        self.jwt = QLineEdit()
        self.jwt.setEchoMode(QLineEdit.EchoMode.Password)
        gen_jwt = QPushButton("随机生成")
        gen_jwt.setObjectName("Ghost")
        gen_jwt.clicked.connect(self._gen_jwt)
        jwt_row = QHBoxLayout()
        jwt_row.addWidget(self.jwt, 1)
        jwt_row.addWidget(gen_jwt)

        other.form.addRow("DATABASE_URL", self.db_url)
        other.form.addRow("JWT_SECRET", self._wrap(jwt_row))
        outer.addWidget(other)

        outer.addStretch(1)

        # --- 底部
        self.hint = QLabel("保存后重启后端生效：在跑 pnpm dev 的窗口按 Ctrl+C，再执行一次。")
        self.hint.setObjectName("Muted")
        self.hint.setWordWrap(True)

        reset = QPushButton("重新载入")
        reset.clicked.connect(self._load_values)
        save = QPushButton("保存")
        save.setObjectName("Primary")
        save.clicked.connect(self._save)

        buttons = QHBoxLayout()
        buttons.addWidget(self.hint, 1)
        buttons.addWidget(reset)
        buttons.addWidget(save)
        outer.addLayout(buttons)

        self.setCentralWidget(root)
        self.statusBar().showMessage("就绪")

    @staticmethod
    def _wrap(layout) -> QWidget:  # type: ignore[no-untyped-def]
        holder = QWidget()
        holder.setLayout(layout)
        layout.setContentsMargins(0, 0, 0, 0)
        return holder

    # ---------------------------------------------------------------- 数据

    def _load_values(self) -> None:
        self.api_key.setText(self.env.get("DEEPSEEK_API_KEY"))
        self.base_url.setText(self.env.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"))
        model = self.env.get("DEEPSEEK_MODEL", "deepseek-flash")
        self.model.setCurrentText(model)
        self.timeout.setValue(int(self.env.get("DEEPSEEK_TIMEOUT_MS", "60000") or 60000))

        self.emb_key.setText(self.env.get("EMBEDDING_API_KEY", "ollama"))
        self.emb_base.setText(self.env.get("EMBEDDING_BASE_URL", "http://127.0.0.1:11434/v1"))
        self.emb_model.setText(self.env.get("EMBEDDING_MODEL", "bge-m3"))
        self.emb_dim.setValue(int(self.env.get("EMBEDDING_DIM", "1024") or 1024))

        self.db_url.setText(self.env.get("DATABASE_URL", ""))
        self.jwt.setText(self.env.get("JWT_SECRET", ""))

        self.llm_status.setText("未测试")
        self.emb_status.setText("未测试")
        self.statusBar().showMessage(f"已载入 {ENV_PATH.name}")

    def _gen_jwt(self) -> None:
        self.jwt.setText(secrets.token_urlsafe(32))
        self.statusBar().showMessage("已生成 32 字节随机密钥")

    def _open_dir(self) -> None:
        target = ENV_PATH.parent
        if sys.platform == "win32":
            os.startfile(target)  # type: ignore[attr-defined]
        else:
            QFileDialog.getExistingDirectory(self, "打开目录", str(target))

    # ---------------------------------------------------------------- 测试

    def _test_llm(self) -> None:
        base = self.base_url.text().strip()
        key = self.api_key.text()
        if not base.startswith("http"):
            self.llm_status.setText("Base URL 要以 http 开头")
            return
        if not key:
            self.llm_status.setText("先填 API Key")
            return
        self.llm_status.setText("测试中…")
        self.prober.test_deepseek(base, key, self.model.currentText().strip())

    def _on_deepseek_done(self, ok: bool, message: str) -> None:
        self.llm_status.setText(("可用 · " if ok else "失败 · ") + message)
        self.llm_status.setStyleSheet(f"color: {theme.OK if ok else theme.DANGER};")

    def _test_embedding(self) -> None:
        base = self.emb_base.text().strip()
        if not base.startswith("http"):
            self.emb_status.setText("Base URL 要以 http 开头")
            return
        self.emb_status.setText("测试中…")
        self.prober.test_embedding(base, self.emb_key.text(), self.emb_model.text().strip())

    def _on_embedding_done(self, ok: bool, message: str, dim: int) -> None:
        if not ok:
            self.emb_status.setText("失败 · " + message)
            self.emb_status.setStyleSheet(f"color: {theme.DANGER};")
            return

        expected = self.emb_dim.value()
        if dim and dim != expected:
            self.emb_status.setText(f"{message}，与配置的 {expected} 维不一致")
            self.emb_status.setStyleSheet(f"color: {theme.WARN};")
            answer = QMessageBox.question(
                self,
                "维度不一致",
                f"服务实际输出 {dim} 维，配置里是 {expected} 维。\n\n"
                f"数据库 notes.embedding 定义是 vector({expected})，"
                f"两者必须一致，否则写入会失败或检索错乱。\n\n"
                f"要把配置改成 {dim} 吗？（改完还需要改迁移并重算向量）",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if answer == QMessageBox.StandardButton.Yes:
                self.emb_dim.setValue(dim)
        else:
            self.emb_status.setText("可用 · " + message)
            self.emb_status.setStyleSheet(f"color: {theme.OK};")

    # ---------------------------------------------------------------- 保存

    def _save(self) -> None:
        problems: list[str] = []
        if not self.api_key.text():
            problems.append("DEEPSEEK_API_KEY 为空")
        if not self.base_url.text().strip().startswith("http"):
            problems.append("DEEPSEEK_BASE_URL 不是合法地址")
        if not self.emb_base.text().strip().startswith("http"):
            problems.append("EMBEDDING_BASE_URL 不是合法地址")
        if len(self.jwt.text().strip()) < 32:
            problems.append("JWT_SECRET 不足 32 字符")

        if problems:
            QMessageBox.warning(self, "还没保存", "请先处理：\n\n· " + "\n· ".join(problems))
            return

        self.env.set("DEEPSEEK_API_KEY", self.api_key.text())
        self.env.set("DEEPSEEK_BASE_URL", self.base_url.text().strip())
        self.env.set("DEEPSEEK_MODEL", self.model.currentText().strip())
        self.env.set("DEEPSEEK_TIMEOUT_MS", str(self.timeout.value()))
        self.env.set("EMBEDDING_API_KEY", self.emb_key.text())
        self.env.set("EMBEDDING_BASE_URL", self.emb_base.text().strip())
        self.env.set("EMBEDDING_MODEL", self.emb_model.text().strip())
        self.env.set("EMBEDDING_DIM", str(self.emb_dim.value()))
        self.env.set("DATABASE_URL", self.db_url.text().strip())
        self.env.set("JWT_SECRET", self.jwt.text().strip())

        try:
            path = self.env.save()
        except OSError as exc:
            QMessageBox.critical(self, "写入失败", f"{path}\n\n{exc}")
            return

        self.statusBar().showMessage(f"已保存 {path}")
        QMessageBox.information(
            self,
            "已保存",
            f"写入 {path}\n\n"
            "接下来：\n"
            "1. 在跑 pnpm dev 的窗口按 Ctrl+C\n"
            "2. 重新执行 pnpm dev\n"
            "3. 换过 embedding 模型的话，再跑 pnpm backfill:embeddings --force",
        )


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("陪伴 · 配置")
    theme.apply_palette(app)
    app.setStyleSheet(theme.QSS)
    apply_app_font(app, 10)
    window = Configurator()
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
