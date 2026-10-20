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
| ComfyUI 可降级 | `src/vision/comfyui.ts` | ✅ 默认关闭 |
| 小程序（登录 / SSE 分块 / 主动消息 / 记忆页） | `apps/miniprogram/` | ✅ |
| 单测（分词 / token / 状态机） | `apps/backend/tests/` | ✅（见 §7 说明） |

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

## 3. 快速开始

```powershell
# 1) 依赖
pnpm install

# 2) 起数据库（Windows 需要 Docker Desktop + WSL2）
docker compose up -d
docker compose ps
docker exec -it companion-db psql -U companion -d companion -c "SELECT extname, extversion FROM pg_extension;"
#   期望看到 vector 与 pg_trgm

# 3) 环境变量
copy .env.example .env      # 至少填 DEEPSEEK_API_KEY；EMBEDDING_* 指向本地 Ollama 或任意 OpenAI 兼容服务

# 4) 迁移（三条，顺序固定：扩展必须在建表之前）
pnpm db:migrate

# 5) 启动
pnpm dev
# 另开窗口：
curl http://127.0.0.1:3000/healthz
```

`/healthz` 会同时检查 **DB + pgvector + 队列**，返回 503 说明其中一项没起来。

灌点中文种子数据，验证检索闭环：

```powershell
pnpm db:seed
pnpm backfill:embeddings          # 需要 embedding 服务在线；没有也能只跑关键词路

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

## 7. 测试

```powershell
pnpm test          # vitest：分词、token 估算、退避表、硬规则闸门、跨午夜安静时段
pnpm selftest      # 同一批断言的纯 node 版本，不依赖 vite/临时目录，CI 或受限环境可用
pnpm typecheck     # tsc --noEmit（strict）
```

集成测试需要 Docker（Testcontainers 跑 `pgvector/pgvector:pg17`），当前未接入——
`@testcontainers/postgresql` 已列入计划但未安装，避免无 Docker 环境下 `pnpm install` 变慢。
接的时候按方案 §8.1：起容器 → 跑迁移 → 种子 → 断言。

## 8. 还没做的（按阶段）

- **阶段 A 收尾**：检索评测集（30–50 条查询，Recall@10 ≥ 0.80）脚本；`EXPLAIN` 走索引的断言。
- **阶段 B 收尾**：7 天摘要抽检脚本；洞察 `superseded_by` 的冲突判定（目前只做新增+去重，不做冲突下线）。
- **阶段 C 收尾**：压测（50 并发 SSE）、`dedupe_key` 重试验证脚本。
- **阶段 D**：ComfyUI 真实工作流 JSON（现在是占位 + 轮询 `/history`，没接 WS）。
- **阶段 E**：Caddy/HTTPS、备份演练、隐私政策、AI 生成内容标识、危机干预话术表。

## 9. 几个容易踩的坑

1. **迁移顺序**：`0000_extensions` 必须在 `0001_init` 之前，否则 `vector(1024)` 建不出来。
2. **`content_tokens` 是生成列的输入**：改了 `notes.content` 必须同步刷新 tokens，否则关键词路静默失效。
3. **SSE 被反代缓冲**：Caddy 用 `flush_interval -1`，Nginx 关 `proxy_buffering`，否则「流式」变一次性返回。
4. **订阅消息**：一次授权通常只能发一条；发送失败（43101 等）不要重试轰炸，直接降级 `in_app`。
5. **更新账号删除**：`DELETE /account` 依赖全表 `ON DELETE CASCADE`，新增表记得也加上。
