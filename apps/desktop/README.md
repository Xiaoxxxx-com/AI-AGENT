# 陪伴 · 桌面端

用**系统已有的 Python 3.12 + PySide6 6.9** 写的 Qt6 桌面客户端，不引入任何新依赖。

![对话界面](docs/preview-chat.png)

## 跑起来

后端要先起着（三个终端，或前两条已有就只起第三条）：

```powershell
pnpm pg:wasm      # 数据库（WASM 版，5433）
pnpm mock:llm     # LLM 替身（有 DeepSeek Key 时改成 pnpm dev）
pnpm dev:wasm     # 后端（3000）
```

然后双击 `run.bat`，或：

```powershell
cd apps\desktop
D:\Python\Python3.14\python.exe main.py
```

后端也可以不在终端手动起：打开上位机「设置 → 连接 → 本地后端」点「启动」，
程序会拉起 PGlite（5433）和 API（3000）并自动连接；关掉上位机时这两个进程会被一起结束。

`run.bat` 会自己找 Python、检查 PySide6（缺了才装），出错时停住不闪退。

## 配置：可视化改 `.env`

![配置器](docs/preview-config.png)

改 API key 最常发生在**后端起不来的时候**，所以配置器不经过后端，直接读写 `companion/.env`：

```powershell
config.bat                                  # 双击，或在应用里按 Ctrl+K
D:\Python\Python3.14\python.exe configurator.py
```

- 三个区块：对话模型 / 向量化 / 其他（DATABASE_URL、JWT_SECRET）
- **先测再存**：「测试对话」发一条 `max_tokens=1` 的真实请求；「测试向量」量出实际维度并和 `EMBEDDING_DIM` 比对，不一致会当场提示（这是最难查的一类错）
- 保存时**只改值、不动注释**——`.env` 里那些"为什么这么配"的说明不会被 dotenv 的 `set_key` 洗掉
- 密钥默认打码，点「显示」才明文；JWT_SECRET 可一键随机生成

## 功能

| 功能 | 说明 |
| ---- | ---- |
| 流式对话 | `POST /chat/stream`，逐 token 渲染，可随时关窗中断（会 abort 上游） |
| 记忆召回 | 每轮 `meta` 里显示召回条数、token 预算，底部实时更新 |
| 待读主动消息 | 启动即拉 `/proactive/pending`，以琥珀色气泡呈现 |
| 历史回填 | 按会话 ID 拉 `/chat/history`，重启不丢上下文 |
| **记忆面板** | `Ctrl+M` 打开右侧抽屉：笔记增删查 / 洞察 / 状态，见下节 |
| 记忆检索 | `Ctrl+F` 打开，直接调 `/memory/search`，能看到 `both / vector / keyword` 命中路径 |
| 危机标记 | 命中安全话术时，气泡上方显示「已触发安全话术」 |
| **聊天背景** | 设置页「背景」标签：选图 / 填充方式 / 遮罩强度；图片拖进聊天区也能换，保存后重启保留 |
| **本地后端** | 设置页「连接」标签一键启停 PGlite + API；关窗自动结束由它启动的进程 |
| 离线引导 | 后端没起时给出可复制的启动命令，而不是只报错 |

### 记忆面板（验证 APP 功能用）

小程序只有 chat 和 notes 两页，桌面端这个抽屉把它们补齐，还多给了两样——洞察和状态。
在没有真机的情况下，这是验证后端行为最直接的入口。

| Tab | 数据来源 | 能做什么 |
| --- | -------- | -------- |
| 笔记 | `GET/POST/DELETE /notes` | 新建（标题+正文）、筛选、双击看全文、删除；每条标注「已向量化 / 待向量化」 |
| 洞察 | `GET /insights` | 只看：类型、置信度、依据几条笔记；被取代的置灰并标出被谁取代 |
| 状态 | `GET /me` | 只看：心情、能量、连续未回应、冷却至、今日主动/上限、订阅额度、下次心跳 |

「待向量化」这个标记有实际意义：`JOBS_ENABLED=false`（WASM 模式）时队列不跑，
新建笔记只进分词索引、不生成向量，检索会走关键词路。补向量用 `pnpm backfill:embeddings`。

### 背景（设置页 →「背景」标签）

![背景设置](docs/preview-settings-background.png)

设好之后聊天区是这样：

![聊天区背景](docs/preview-background.png)

三种入口：「设置」→「背景」标签、`Ctrl+B`、顶部「背景」按钮（后两者直接跳到该标签），
另外把图片拖进聊天区也会立即换背景。可调**填充方式**（铺满 / 适应 / 平铺）和
**遮罩强度**（越高文字越清楚，浅色主题下是一层白色柔化）。

改动实时同步到主窗口和页内预览，点「保存」才写入 QSettings；点「取消」会恢复到
打开设置前的背景，不会把临时试的效果留下。本机常用图放在 `apps/desktop/background/`，
对话框会列出来直接点选；「选择图片…」可以挑任意路径。「清除背景」回到纯色，
「还原默认」清掉填充与遮罩的改动。图片读不出来时自动回退为纯色，并且不会把坏路径存进设置。

实现要点：背景是聊天区最底层的一个 `QWidget`，滚动区 → viewport → 内容容器三层用
ID 选择器设成透明叠在上面，所以背景固定不动、不随消息滚动；缩放结果按
「尺寸 + 填充方式 + 路径」缓存，并乘上 `devicePixelRatio`，滚动和高分屏下都不会糊。

### 本地后端（设置页 →「连接」标签）

![本地后端](docs/preview-settings-backend.png)

一个按钮管住两件事：先起 PGlite（5433），等端口就绪再起 API（3000），
API 就绪后主窗口自动重连（不用再点「重新连接」）。

- **状态**：未启动 / 启动中 / 已启动 / 已在运行 / 启动失败，失败会在按钮旁给出原因
- **已在运行**：如果 3000 是你在终端里自己起的，程序不会接管，「停止」按钮也不可用；
  关窗时它同样不会动你的进程
- **自动关闭**：关闭上位机时对本程序启动的进程执行 `taskkill /T /F`，
  node → tsx → server 整棵进程树一起结束
- **日志**：子进程输出写到 `companion/var/desktop-backend.log`，启动失败先看这里
- **前置**：Node.js 20+；`node_modules` 已安装（`pnpm install`）。向量化仍需要 Ollama 在跑

实现上不依赖 `pnpm` 必须在 PATH 里：本机实测只有 `.workbuddy` 自带的 Node 22 可用，
所以 `backend.py` 会按「PATH → 常见安装目录 → WorkBuddy 运行时」找 `node.exe`，
再用 `node node_modules/tsx/dist/cli.mjs scripts/pglite-server.ts|dev-wasm.ts` 直接启动。

## 快捷键

| 键 | 动作 |
| -- | ---- |
| `Enter` | 发送 |
| `Shift+Enter` | 换行 |
| `Ctrl+K` | 打开配置器（改 key / 模型） |
| `Ctrl+M` | 记忆面板（笔记 / 洞察 / 状态） |
| `Ctrl+,` | 设置（连接 / 背景） |
| `Ctrl+F` | 记忆检索 |
| `Ctrl+B` | 设置 →「背景」标签 |
| `Ctrl+R` | 拉取待读消息 |
| `Ctrl+Q` | 退出 |

## 结构

```text
apps/desktop/
├── main.py                 入口：QApplication + 全局字体 + 样式
├── configurator.py         配置器：可视化改 .env
├── companion/
│   ├── api.py              ApiClient：登录 / SSE / 待读 / 历史 / 检索
│   ├── window.py           主窗口、设置对话框（连接 / 背景）、记忆检索对话框
│   ├── panel.py            记忆抽屉：笔记 / 洞察 / 状态
│   ├── backdrop.py         聊天区背景：绘制 / 持久化 / 设置页背景面板
│   ├── backend.py          本地后端启停：PGlite + API，关窗结束进程树
│   ├── widgets.py          气泡、输入框、状态点、滚动容器
│   ├── envfile.py          .env 读写（保留注释与顺序）
│   ├── probe.py            DeepSeek / embedding 连通性探测
│   ├── theme.py            浅色配色、QSS、QPalette
│   └── fonts.py            中文字体解析（找不到就注册 msyh.ttc）
├── assets/                 箭头图标（QSS 接管绘制后必须自带）
├── background/             自选背景图（对话框里直接列出，可增删）
├── tools/
│   ├── api_smoke.py        无界面联调：登录 + SSE + 待读，退出码可用于 CI
│   ├── config_smoke.py     .env 读写保真 + 探测 + 配置器截图
│   └── preview.py          离屏渲染对话界面预览图
├── docs/                   预览图
└── run.bat / config.bat
```

## 关键实现

**SSE 用 QNetworkAccessManager，不用线程池。**
`readyRead` 里把字节喂给增量 UTF-8 解码器（`codecs.getincrementaldecoder`），
再按 `\n\n` 切事件块。这样多字节汉字被拆在两个 TCP 包里也不会乱码——
这是自己拼 buffer 最容易踩的坑。

**气泡宽度按字宽自适应。**
`QLabel(wordWrap=True)` 的 `sizeHint` 会退化成很窄的一列，
所以 `Bubble._fit()` 用 `QFontMetrics.horizontalAdvance` 算最长一行的自然宽度，
再夹到「窗口宽度 74%」的上限内，气泡才会贴住文字而不是留一片空白。

**字体兜底。**
某些环境（沙箱、精简 Qt 部署、远程会话）里 `QFontDatabase.families()` 是空的，
中文会全变方块。`fonts.apply_app_font()` 检测到这种情况会直接
`addApplicationFont("C:\Windows\Fonts\msyh.ttc")` 兜住。

## 自测

```powershell
# 1) 语法检查
D:\Python\Python3.14\python.exe -m py_compile main.py configurator.py companion\*.py tools\*.py

# 2) 无界面联调（后端要起着），退出码 0 表示通过
D:\Python\Python3.14\python.exe tools\api_smoke.py

# 3) 配置器自检：.env 读写保真 + 对 mock 探测连通性
D:\Python\Python3.14\python.exe tools\config_smoke.py

# 4) 重新生成预览图
D:\Python\Python3.14\python.exe tools\preview.py ..\..\var
D:\Python\Python3.14\python.exe tools\config_smoke.py --shot ..\..\var\preview-config.png
```

`api_smoke.py` 覆盖：健康检查 → 登录 → 待读 → 笔记列表 → 洞察 → 我的状态 →
流式对话（token 计数）→ 新建笔记 → 删除笔记。
`config_smoke.py` 覆盖：改值生效 / 新键追加 / 注释保留 / 其他键不受影响 / 带空格值自动加引号 / 两个接口探测 + 维度比对。

## 已知限制

- 只有单一会话（会话 ID 在设置里，可重置）；后端没有「会话列表」接口，多会话要加接口
- 不做本地缓存：断网后看不到历史，重连会重新拉取
- 没有打包成 exe；需要分发时用 `pyinstaller --noconsole main.py`
- 主动消息靠后端直推（Bark / Server酱等），桌面端自身不弹系统通知
