# AI 伴侣 · 认知基底（companion）

按 `implementation_plan_20261020.md`（v1）落地的工程骨架：**PostgreSQL 认知基底 + Fastify 同步链路 + pg-boss 异步生命维持 + ComfyUI 可降级视觉**。

一句话取舍：不引入第二个存储/消息系统，把「记忆、状态、调度」全压在 PostgreSQL 上；用应用侧分词解决中文检索；用硬规则 + 结构化工具调用解决「克制」；ComfyUI 永远可拔掉。

---

## 1. 已经落地的东西

| 模块 | 文件 | 状态 |
| ---- | ---- | ---- |
| 表结构（9 张表 / 向量 / 生成列 / 局部索引） | `apps/backend/src/db/schema.ts` + `drizzle/` | ✅ 可迁移 |
| 启动链路（env 校验 → 池 → 插件 → 路由 → 队列 → worker） | `src/server.ts` | ✅ 可编译 |
| 微信登录 / JWT / 越权防护 | `src/auth/wechat.ts`, `src/plugins/auth.ts` | ✅ |
| 中文分词（jieba 应用侧）+ tsquery 拼装 | `src/memory/segment.ts` | ✅ |
| Embedding 可插拔层（OpenAI 兼容 / Ollama bge-m3） | `src/memory/embed.ts` | ✅ |
| 混合检索 + RRF | `src/memory/hybrid-search.ts` | ✅ |
| 分层上下文组装（8K 固定预算） | `src/memory/assemble.ts` | ✅ |
| 滚动摘要（阈值 + 合并 + supersede） | `src/memory/summarize.ts` | ✅ |
| 每日反思 → 可追溯洞察 | `src/companion/reflection.ts` | ✅ |
| 心跳「tick + 每用户任务」+ 硬规则闸门 | `src/companion/heartbeat.ts`, `proactive.ts`, `state.ts` | ✅ |
| 投递（订阅消息 + 站内 pending + 配额记账） | `src/companion/delivery.ts` | ✅ |
| 主动触达直推（bark / serverchan / 企业微信 / telegram） | `src/companion/push.ts` | ✅ 自用推荐 |
| SSE 流式对话（abort、半截落库） | `src/chat/stream.ts` | ✅ |
| 危机内容识别 + 固定安全指令 | `src/chat/safety.ts` | ✅ |
| ComfyUI 可降级 + 图片静态服务 | `src/vision/comfyui.ts`, `src/server.ts` | ✅ 默认关闭 |
| 数据导出 / 删除（隐私合规） | `src/routes/account.ts` | ✅ |
| 小程序（登录 / SSE 分块 / 主动消息 / 记忆页） | `apps/miniprogram/` | ✅ |
| 单元测试（分词 / token / 状态机 / 危机识别） | `apps/backend/tests/` | ✅ |
| 本地 mock LLM（免 Key 跑全链路） | `scripts/mock-openai-server.ts` | ✅ |
| 检索评测（Recall@10 / MRR / 关键词独有占比） | `scripts/eval-retrieval.ts` | ✅ |
| 便携版 PostgreSQL 控制脚本 | `scripts/pg.ts` | ✅ 免管理员 |
| WASM 版 PostgreSQL（无 Docker 也能验收） | `scripts/pglite-server.ts` | ✅ `pnpm pg:wasm` |
| A/B/C 验收断言（索引 / 洞察 / 证据 / 去重 / 冷却） | `scripts/check-*.ts`, `scripts/load-sse.ts` | ✅ 见 `docs/ACCEPTANCE.md` |
| 洞察冲突下线（superseded_by） | `src/companion/reflection.ts` + 迁移 0003 | ✅ |
| Android 开发环境（JDK 17 + SDK 36 + adb，免管理员） | `docs/ANDROID-SETUP.md`, `ops/android-env.*` | ✅ |
| 桌面端（Python 3.12 + PySide6 6.9，流式对话/待读/检索） | `apps/desktop/` | ✅ |

## 2. 目录

```text
companion/
├── apps/backend/
│   ├── src/
│   │   ├── db/            schema / client / seed
│   │   ├── memory/        segment · embed · hybrid-search · assemble · summarize · index-note
│   │   ├── companion/     state · proactive · heartbeat · reflection · delivery
│   │   ├── chat/          deepseek · stream · messages
│   │   ├── vision/        comfyui
│   │   ├── auth/          wechat
│   │   ├── plugins/       db · jobs · auth · log
│   │   ├── routes/        health · auth · notes · memory · proactive · account
│   │   └── server.ts / workers.ts / queue.ts / config.ts
│   ├── drizzle/           0000_extensions · 0001_init · 0002_vector_index
│   └── tests/
├── apps/miniprogram/      pages/chat · pages/notes · utils/{request,sse}.js
├── ops/                   init/001_extensions.sql · backup.sh · Caddyfile · legacy/alter_existing.sql
├── docker-compose.yml     开发：只有 PG
├── docker-compose.prod.yml 生产：db + backend + caddy
└── drizzle.config.ts
```

## 3. 装环境（三条路，选一条）

### 路线 A：便携版 PostgreSQL（推荐，无需 Docker / 无需管理员）

便携版已下载并装好 pgvector 到 `var/pg/pgsql`（PostgreSQL 17.6 + vector 0.8.6）。只需初始化：

```powershell
pnpm install
copy .env.example .env        # 关键项：JWT_SECRET（≥32 字符）
pnpm pg:setup                 # initdb → 启动 → 建库 → 建扩展（一条命令搞定）
pnpm db:migrate               # 三条迁移：扩展 → 建表 → HNSW/GIN
pnpm db:seed                  # 30 条中文笔记
```

也可以直接双击 `ops\pg-setup.bat`（会自动暂停并提示下一步）。
如果 `pg:setup` 报 `0xC0000409`，说明进程被沙箱/杀 soft 拦截，换普通终端重跑即可——
脚本会自动打印可复制的手动分步命令。

其他常用命令：`pnpm pg:start` / `pnpm pg:stop` / `pnpm pg:status` / `pnpm pg:psql`。

数据在 `var/pgdata`，日志在 `var/pg.log`，只监听 `127.0.0.1`。
**不要用管理员身份运行**：PostgreSQL 拒绝以 Administrator 启动，`pg_ctl` 会直接报错退出。

### 路线 B：Docker

```powershell
docker compose up -d
docker exec -it companion-db psql -U companion -d companion -c "SELECT extname, extversion FROM pg_extension;"
pnpm db:migrate && pnpm db:seed
```

### 路线 C：已有 PostgreSQL

装好 `pgvector` 扩展、建库、把 `DATABASE_URL` 指过去，然后：

```powershell
pnpm db:migrate     # 空库直接跑；已有 users/notes 表的话改用 ops/legacy/alter_existing.sql
```

### 路线 D：什么都装不了时（WASM）

真 PostgreSQL 起不来的环境（无 Docker、WSL 被禁、`initdb` 被拦）可以用 PGlite 跑完整验收：

```powershell
pnpm pg:wasm        # PostgreSQL 18.6(WASM) + pgvector 0.8.7，监听 127.0.0.1:5433
$env:DATABASE_URL="postgres://companion:companion_dev@127.0.0.1:5433/companion"
pnpm db:migrate && pnpm db:seed

# 起服务（另开一个窗口）
pnpm mock:llm       # 没有 DeepSeek Key 时
pnpm dev:wasm       # 自动指向 5433 + 关闭队列 + LLM 走 mock
```

限制：单进程串行、不支持 pg-boss（起服务时加 `JOBS_ENABLED=false`）、
规划器不实现 GIN/HNSW 扫描（`check:indexes` 的 2 条计划断言会跳过）。详见 `docs/ACCEPTANCE.md`。

### 起服务：有 Key 用真模型，没 Key 用 mock

```powershell
# 有 DeepSeek Key + 本地 Ollama（bge-m3）
pnpm dev

# 没有 Key 也能跑通全链路：一个窗口起 mock，另一个窗口起服务
pnpm mock:llm
pnpm dev:mock
```

`/healthz` 会同时检查 **DB + pgvector + 队列**，返回 503 说明其中一项没起来。

```powershell
pnpm backfill:embeddings          # 生成向量（mock 也行）
pnpm eval:retrieval               # Recall@10 / MRR / 关键词路独有占比

# 本地拿 token（非生产环境才有这个路由）
curl -X POST http://127.0.0.1:3000/auth/dev -H "content-type: application/json" -d "{}"

curl "http://127.0.0.1:3000/memory/search?q=最近工作压力大&topK=5" `
  -H "authorization: Bearer <token>"
```

返回里每条命中都带 `source: vector | keyword | both`，`meta.tokens` 是分词结果——
**如果 `meta.tokens` 有值但 `source` 全是 vector，说明 `content_tokens` 没写进去**，这是本方案最需要盯的回归点。

## 4. 环境变量要点

| 变量 | 说明 |
| ---- | ---- |
| `DEEPSEEK_MODEL` | 默认 `deepseek-flash`。`deepseek-chat` 是旧名，正在退役，别再用 |
| `EMBEDDING_DIM` | 必须与模型输出、`notes.embedding` 列定义三者一致；换模型要全量重算 |
| `JWT_SECRET` | ≥32 字符，启动时校验，不满足直接退出 |
| `COMFYUI_ENABLED` | 默认 `false`；关闭时文本链路零影响 |
| `HEARTBEAT_INTERVAL_MINUTES` | 每用户心跳间隔，默认 30 分钟 |
| `JOBS_ENABLED` | 默认 `true`。`false` 时队列降级为 no-op，只跑 HTTP 层（WASM 验收 / 只读调试用） |

> 注：方案原文用 `z.coerce.boolean()` 解析 `COMFYUI_ENABLED`，它会把字符串 `"false"` 判成 `true`。
> 这里换成了显式白名单解析（`src/config.ts`）。

### 4.1 切到真实模型

`.env` 里三行就够：

```ini
DEEPSEEK_API_KEY=sk-你的key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
```

验证（真打一次，不经过 mock）：

```powershell
pnpm smoke:llm --real
# ok chatText / chatStream / chatJson / shouldReachOut
```

**关于 `deepseek-flash`：它是思考模型。** 回复前会先输出 `reasoning_content`，
这段也**计入 `completion_tokens`**。所以：

- 结构化调用（`chatJson` / `shouldReachOut`）的 `max_tokens` 至少留 **800**，
  否则推理就把预算吃光，正文是空字符串、`finish_reason=length`——
  看起来像"模型没返回"，其实是预算不够。代码里已用 `MIN_STRUCTURED_BUDGET` 兜住。
- 计费时 reasoning token 按 completion 收费，长推理会更贵。
- `deepseek-chat` 目前会被路由到 `deepseek-flash`（响应里 model 字段就是 flash），
  但那是即将退役的旧名，别再用。

**Embedding 是另一件事。** DeepSeek 不提供 embedding 接口，`EMBEDDING_*` 要单独配
（Ollama 本地跑 bge-m3，或任意 OpenAI 兼容的向量服务）。没配时聊天照常，
检索自动退化成纯关键词——`assemble.ts` 里有兜底，不会因此聊不了天。

### 4.2 开发脚本怎么选

| 命令 | 数据库 | 模型 | 用途 |
| ---- | ------ | ---- | ---- |
| `pnpm dev` | `.env` 里的（原生 PG） | `.env` 里的真实配置 | 正式开发 |
| `pnpm dev:wasm` | PGlite 5433 | `.env` 里的真实配置 | 原生 PG 起不来时的开发 |
| `pnpm dev:wasm:mock` | PGlite 5433 | 本地 mock | 没有 key 时跑通链路 |
| `pnpm dev:mock` | `.env` 里的 | 本地 mock | 只把 LLM 换成 mock |

`dev:wasm` 只覆盖数据库和队列，**不动模型配置**——这是 2026-10-20 改的，
之前的版本会把 LLM 强制指到 mock，导致填了真 key 也切不过去。

### 4.3 让 AI 主动找你（自用关键配置）

平台限制摆在这：小程序**一次性订阅**一次授权只能发一条，**长期订阅**只对政务/医疗/交通/金融/教育等类目开放，
AI 陪伴类拿不到。所以“她主动找到你”不能只靠订阅消息。

解法是服务端把消息推到手机通知栏，点开再进小程序读正文、回话。
投递优先级写死在 `companion/delivery.ts`：**直推 → 订阅消息 → 站内待读**，前一步失败自动降级。

```ini
# 四选一，都只需要一个 URL（telegram 额外要 chat_id）
PUSH_KIND=bark
PUSH_URL=https://api.day.app/你的KEY

# PUSH_KIND=serverchan  PUSH_URL=https://sctapi.ftqq.com/SCTxxxx.send
# PUSH_KIND=wecom       PUSH_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
# PUSH_KIND=telegram    PUSH_URL=https://api.telegram.org/bot<token>/sendMessage
#                       PUSH_TARGET=<chat_id>
# PUSH_KIND=generic     PUSH_URL=你自己的 webhook（POST {title, body, link}）
```

冒烟：

```powershell
pnpm push:test --kind=bark --url=https://api.day.app/你的KEY
# 端到端（写一条 proactive_log → 投递 → 断言 channel=push:bark）
pnpm push:test --kind=bark --url=... --e2e
```

要点：
- 自用把 `HEARTBEAT_INTERVAL_MINUTES` 调到 10，主动消息才够“活”；默认 30 分钟。
- `PUBLIC_BASE_URL` 没有网页端就留空，否则会推出去一个死链。
- 推送失败不会重试轰炸，直接降级站内；`proactive_log.channel` 会记成 `push:bark` / `in_app` 便于排查。

## 5. API

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET | `/healthz` | DB + 队列 + 扩展健康 |
| POST | `/auth/wechat` | `{code}` → `{token, userId}` |
| POST | `/auth/dev` | **仅非生产**：本地直登，绕开微信 |
| POST | `/notes` | 新建笔记（同步分词 + 异步入队向量化） |
| GET | `/notes` | 游标分页列表 |
| DELETE | `/notes/:id` | 删除 |
| GET | `/memory/search?q=&topK=` | 混合检索 + RRF |
| POST | `/chat/stream` | SSE：`meta` → `token`* → `done`/`error` |
| GET | `/chat/history?sessionId=` | 会话回填 |
| GET | `/proactive/pending` | 未读主动消息全文 |
| POST | `/proactive/:id/read` | 标记已读 |
| POST | `/proactive/subscribe` | 订阅配额 +1（一次授权一条） |
| POST | `/proactive/toggle` | 主动关怀总开关 |
| GET | `/me` | 用户 + 状态 |
| DELETE | `/account` | 删除账号（级联） |
| GET | `/account/export` | 导出全部数据（笔记/对话/洞察/摘要/主动消息） |
| GET | `/static/images/*` | ComfyUI 产出的图片 |

## 6. 十条修正点的落地位置

| # | 修正 | 落地 |
| - | ---- | ---- |
| 1 | 用原生 `vector()` | `schema.ts` |
| 2 | 中文必须应用侧分词 | `memory/segment.ts` + 生成列 `content_tsvector` |
| 3 | 模型名走 env | `config.ts` / `chat/deepseek.ts` |
| 4 | HNSW 参数当量级参考 | `drizzle/0002_vector_index.sql`（m=16, ef=64，查询 ef_search=40） |
| 5 | 固定 8K 预算 | `memory/assemble.ts`（6K 输入 + 2K 输出） |
| 6 | 订阅消息只发模板 | `companion/delivery.ts`（正文留在 `proactive_log`，站内 pending 读全文） |
| 7 | 摘要要有落库表 | `conversation_summaries` + `memory/summarize.ts` |
| 8 | `proactive_log` 要状态机/去重 | `schema.ts`（`UNIQUE(user_id, dedupe_key)`）+ `proactive.ts` |
| 9 | pg-boss v10 用法 | `plugins/jobs.ts`（先 createQueue）+ `workers.ts`（handler 收数组） |
| 10 | CPU 任务别堵 SSE | 分词/向量化走队列 `note.index`，embedding 可换外部服务 |

## 7. 测试与验收

```powershell
pnpm typecheck     # tsc --noEmit（strict）
pnpm test          # vitest：分词、token、退避表、硬规则闸门、危机识别
pnpm selftest      # 同批断言的纯 node 版，不依赖 vite 临时目录（受限环境可用）

pnpm mock:llm      # 窗口 1
pnpm smoke:llm     # LLM 契约：embedding 维度、流式分块、JSON 模式、tool_calls
pnpm eval:retrieval  # 检索评测（需 DB + seed + embedding）
```

- `smoke:llm` 跑的是项目自己的封装（`createEmbedder` / `chatStream` / `chatJson` / `shouldReachOut`），
  用 mock 校验「协议层」是否正确；换成真 Key 后同一条命令即是真实连通性测试。
- `eval:retrieval` 输出 hybrid / 纯向量 / 纯关键词三路 Recall@10、MRR，以及关键词路取数方式，
  低于阈值会直接提示排查方向。

### A / B / C 阶段的验收断言

| 阶段 | 命令 | 断言内容 |
| ---- | ---- | -------- |
| A | `pnpm check:indexes` | 扩展、HNSW 参数、GIN/HNSW 是否被用上、`content_tsvector` 覆盖率 |
| A | `pnpm eval:retrieval` | Recall@10 / MRR / 关键词路独有占比 |
| B | `pnpm check:insights` | 洞察冲突下线、幂等、越权保护、组装层过滤 |
| B | `pnpm check:evidence` | 证据链完整性、摘要区间、机械引用 |
| C | `pnpm check:dedupe` | 同一 key 并发 10 次只落 1 条 |
| C | `pnpm check:cooldown` | 3 次未回应 → 72h 冷却 → 回话解除 |
| C | `pnpm load:sse --concurrency=50` | 并发 SSE、首字节延迟、中断后半截落库 |

执行结果与已知限制见 **[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)**（含一次真实发现的 bug 修复记录）。

集成测试（Testcontainers + pgvector）仍未接入：Windows 无 Docker 的机器上会让 `pnpm install` 变慢。

## 8. 阶段状态

- **阶段 A 检索闭环**：已收尾。索引断言、评测脚本、`pg_trgm` 并联兜底就绪。
  指标目标（Recall@10 ≥ 0.80 / MRR ≥ 0.65）**需接真实 bge-m3 后复评**——本机只有词面 mock 向量，
  测出的 0.611 / 0.600 不代表链路质量，详见 `docs/ACCEPTANCE.md` §3。
- **阶段 B 反思与洞察**：已收尾。冲突下线（`superseded_by` + 迁移 0003）、证据链审计、机械引用审计就绪。
- **阶段 C 心跳与克制**：已收尾。dedupe 并发、退避冷却、50 并发 SSE、客户端中断均已自动化验证；
  期间修掉一个真实 bug（未回应计数按轮 +1 导致退避永远停在 6h）。
- **阶段 D**：ComfyUI 真实工作流 JSON（现在是占位 + 轮询 `/history`，没接 WS）。
- **阶段 E**：Caddy/HTTPS 上线、备份恢复演练、隐私政策与 AI 生成内容标识。
  危机话术已内置（`chat/safety.ts`），但热线号码与措辞仍需按地域人工确认。

## 9. 几个容易踩的坑

1. **迁移顺序**：`0000_extensions` 必须在 `0001_init` 之前，否则 `vector(1024)` 建不出来。
2. **`content_tokens` 是生成列的输入**：改了 `notes.content` 必须同步刷新 tokens，否则关键词路静默失效。
3. **SSE 被反代缓冲**：Caddy 用 `flush_interval -1`，Nginx 关 `proxy_buffering`，否则「流式」变一次性返回。
4. **订阅消息**：一次授权通常只能发一条；发送失败（43101 等）不要重试轰炸，直接降级 `in_app`。
5. **账号删除**：`DELETE /account` 依赖全表 `ON DELETE CASCADE`，新增表记得也加上。
6. **embedding 的 `encoding_format`**：OpenAI SDK 默认请求 `encoding_format: "base64"`。
   自建/代理的 embedding 服务如果不遵守这个参数、仍返回 float 数组，客户端会把 1024 个数按字节重解释成 **256 维**。
   自己写兼容层时务必处理（本项目 mock 就是这么修的）。
7. **便携版 PG 不进 git**：`var/` 已在 `.gitignore` 里，换机器需要重新下载（见 §3 路线 A）。
8. **语料小于 candidateLimit(40) 时评测会失真**：向量路会把全部笔记捞回来，
   「关键词独有命中」必然为 0。先 `pnpm corpus:distractors` 扩到 300+ 再评。
9. **`ts_rank_cd` 大量并列**：中文短查询常出现同分（都是 0.1），
   必须用 `similarity()` 做二次排序，否则 id 顺序会变成任意噪声并污染 RRF 融合。
