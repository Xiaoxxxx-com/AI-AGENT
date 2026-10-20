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
| SSE 流式对话（abort、半截落库） | `src/chat/stream.ts` | ✅ |
| 危机内容识别 + 固定安全指令 | `src/chat/safety.ts` | ✅ |
| ComfyUI 可降级 + 图片静态服务 | `src/vision/comfyui.ts`, `src/server.ts` | ✅ 默认关闭 |
| 数据导出 / 删除（隐私合规） | `src/routes/account.ts` | ✅ |
| 小程序（登录 / SSE 分块 / 主动消息 / 记忆页） | `apps/miniprogram/` | ✅ |
| 单元测试（分词 / token / 状态机 / 危机识别） | `apps/backend/tests/` | ✅ |
| 本地 mock LLM（免 Key 跑全链路） | `scripts/mock-openai-server.ts` | ✅ |
| 检索评测（Recall@10 / MRR / 关键词独有占比） | `scripts/eval-retrieval.ts` | ✅ |
| 便携版 PostgreSQL 控制脚本 | `scripts/pg.ts` | ✅ 免管理员 |

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

> 注：方案原文用 `z.coerce.boolean()` 解析 `COMFYUI_ENABLED`，它会把字符串 `"false"` 判成 `true`。
> 这里换成了显式白名单解析（`src/config.ts`）。

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
- `eval:retrieval` 输出 hybrid 与纯向量的 Recall@10、MRR、关键词路独有命中占比，
  低于阈值会直接提示「先查 `content_tsvector` 是否为空」。
- 集成测试（Testcontainers + pgvector）尚未接入：Windows 无 Docker 的机器上会让 `pnpm install` 变慢。
  接了 Docker 之后按方案 §8.1 补：起容器 → 迁移 → 种子 → 断言。

## 8. 还没做的（按阶段）

- **阶段 A 收尾**：`EXPLAIN` 走索引的自动断言（现在靠 eval + 手工 `EXPLAIN`）。
- **阶段 B 收尾**：洞察冲突下线（现在只做新增 + 向量去重，不做「旧洞察被推翻」）。
- **阶段 C 收尾**：压测（50 并发 SSE）、`dedupe_key` 重试 10 次只发 1 条的自动化验证。
- **阶段 D**：ComfyUI 真实工作流 JSON（现在是占位 + 轮询 `/history`，没接 WS）。
- **阶段 E**：Caddy/HTTPS 上线、备份恢复演练、隐私政策与 AI 生成内容标识。危机话术已内置（`chat/safety.ts`），但仍需人工review 话术与热线号码的地域适配。

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
