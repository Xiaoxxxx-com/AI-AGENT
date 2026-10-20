# 阶段 A / B / C 验收记录

> 执行时间：2026-10-20
> 执行环境：Windows 11 + Node 22.22.2，数据库为 **PGlite 0.5.10（PostgreSQL 18.6 编译为 WASM）+ pgvector 0.8.7 + pg_trgm 1.6**
> 原因：本机未装 Docker、WSL 被安全策略禁用、`initdb` 被拦，无法启动原生 PostgreSQL。
> 影响：**逻辑、约束、SQL、协议层全部为真实执行**；性能数字受 WASM 串行执行限制，不代表生产。
> 迁移到真实 PostgreSQL 只需 `pnpm pg:setup && pnpm db:migrate && pnpm db:seed`，脚本无需改动。

---

## 1. 总览

| 阶段 | 验收项 | 命令 | 结果 |
| ---- | ------ | ---- | ---- |
| A | 迁移可重复执行 | `pnpm db:migrate` | ✅ 4 个迁移全部应用（含 HNSW / GIN / trigram） |
| A | 索引与覆盖率断言 | `pnpm check:indexes` | ✅ 7 通过 / 2 跳过（引擎不支持索引扫描，见 §4） |
| A | 检索指标报告 | `pnpm eval:retrieval` | ⚠️ 见 §3：链路正确，指标受 mock embedder 限制 |
| B | 洞察冲突下线 | `pnpm check:insights` | ✅ 5 项通过 |
| B | 证据链 / 摘要 / 引用审计 | `pnpm check:evidence` | ✅ 4 项通过 |
| C | dedupe 重试 10 次只发 1 条 | `pnpm check:dedupe` | ✅ 3 项通过 |
| C | 3 次未回应 → 72h 冷却 | `pnpm check:cooldown` | ✅ 5 项通过 |
| C | 50 并发 SSE + 中断 | `pnpm load:sse` | ✅ 通过（49/50，1 例为 WASM socket 限制） |

---

## 2. 阶段 A：检索闭环

### 2.1 索引与数据完整性

```text
PostgreSQL 18.6 (PGlite 0.5.10) on wasm32-unknown-emscripten
  ok    pgvector · 0.8.7
  ok    pg_trgm · 1.6
  ok    索引存在 idx_notes_embedding
  ok    索引存在 idx_notes_tsvector
  ok    HNSW 参数 · m=16,ef_construction=64
  skip  向量排序走 HNSW 索引 · WASM 引擎不实现 hnsw 扫描
  skip  tsquery 检索走 GIN 索引 · WASM 引擎不实现 GIN 扫描
  ok    content_tsvector 覆盖率 · 330/330 非空
  ok    embedding 覆盖率 · 330/330
```

`content_tsvector 330/330 非空` 是方案 §0 第 2 条那个回归点的直接断言：
只要中文分词没写进 `content_tokens`，这条立刻变红。

### 2.2 端到端检索（真实 HTTP）

```text
GET /memory/search?q=最近工作压力大&topK=5      → 17ms
tokens: 最近 | 工作 | 压力 | 大
  #3   both    睡眠    最近总是两点才能睡着…
  #20  both    焦虑    半夜会突然心慌…想的都是工作的事
  #25  vector  加班费  HR 说加班费按调休算…

GET /memory/search?q=想养猫&topK=5             → 21ms
tokens: 想 | 养猫
  #14  both    想养猫  又去看了一次领养信息…
  #2   both    豆豆    楼下那只橘猫今天蹭我腿…
```

`source` 字段能直接看出两路贡献：`both` 表示向量路与关键词路都命中。
用户隔离也顺带验证了：用 `dev-openid-001` 的 token 查不到 `seed-openid-001` 的笔记。

---

## 3. 阶段 A 的指标：为什么没达标，以及怎么才算达标

```text
样例 12 条 · 语料 330 条 · topK=10 · 模型 bge-m3@1024（实际为本地 mock）

  Recall@10 (hybrid)         0.611   目标 ≥ 0.80   ← 未达标
  Recall@10 (vector-only)    0.611
  Recall@10 (keyword-only)   0.639
  MRR (hybrid)               0.600   目标 ≥ 0.65   ← 未达标
  MRR (vector-only)          0.653
  关键词路独有命中占比          0.000   目标 ≥ 0.15   ← 未达标
  关键词路取数方式：tsquery 12 次 / trigram 兜底 0 次 / 无命中 0 次
```

**结论：这三个未达标项都不是链路缺陷，而是「没有语义模型」的必然结果。**

1. 本机没有 Ollama / bge-m3，验收用的是 `scripts/mock-openai-server.ts` 里的**词面哈希向量**——
   它只反映字词重叠，不理解"压力大"≈"加班到十点"。
2. 因为向量路本身就是模糊词面匹配，两路高度重合，`关键词路独有命中` 恒为 0。
   这个指标只有在**语义向量**（会漏掉罕见专名）时才体现价值。
3. `Recall@10 (keyword-only) = 0.639` 才是关键词路健康与否的稳定信号，
   说明 jieba 分词 + `content_tsvector` + GIN 这条路是通的。

**达标方式**：接上真实 embedding 后，同一条命令即可复评。

```powershell
# 启动 bge-m3（或其他 OpenAI 兼容 embedding 服务），把 .env 指向它
ollama pull bge-m3
pnpm backfill:embeddings --force
pnpm eval:retrieval
```

阈值写在 `scripts/eval-retrieval.ts` 的 `THRESHOLD` 里，未达标会显式标红并给出下一步提示。

---

## 4. 被跳过的两项（诚实说明）

`check:indexes` 里的两条执行计划断言在 WASM 引擎上跳过：

```text
skip  向量排序走 HNSW 索引 · WASM 引擎不实现 hnsw 扫描
skip  tsquery 检索走 GIN 索引 · WASM 引擎不实现 GIN 扫描
```

PGlite 能**创建** GIN / HNSW 索引（`pg_am` 里也能看到 `gin`/`hnsw`），
但规划器不会选择它们——即使 `SET enable_seqscan=off` 也仍然走 Seq Scan / btree。

在真实 PostgreSQL 上这两条会变成硬断言，判定方式是
`EXPLAIN` 文本里出现 `Index Scan using idx_notes_embedding` / `idx_notes_tsvector`。
脚本已按引擎自动区分（`/PGlite|wasm32/` 匹配），不需要改代码。

---

## 5. 阶段 B：反思与洞察

### 5.1 冲突下线（本次新增）

旧洞察「对方最近一直在为转岗面试焦虑」被新洞察「已经拿到内部转岗机会，焦虑明显缓解」取代：

```text
  ok    旧洞察下线并溯源 · superseded_by=39
  ok    重复调用幂等 · 第二次影响 0 行
  ok    跨用户不可下线 · 影响 0 行
  ok    组装层已过滤被取代洞察
  ok    新洞察可见
```

实现要点：
- `user_insights` 新增 `superseded_by` / `superseded_reason`（迁移 `0003_insight_supersede`）；
- LLM 只被允许在 `supersedes` 里填**该用户已有且仍有效**的洞察 id，其余一律丢弃；
- 下线用 `where user_id = $1 and id = any($2) and is_active = true and id <> $3`，
  三个条件缺一不可（越权、重复、自指都会被拦）；
- 组装上下文只取 `is_active = true`，被取代的不会再进 prompt。

### 5.2 证据链审计

```text
  ok    合规洞察通过审计 · 3 条，noteIds=5
  ok    审计能抓到脏数据 · #44 引用了不属于该用户的笔记 999999
  ok    摘要区间连续且只有一个头部
  ok    无机械引用
```

审计覆盖四类问题：`source_note_ids` 为空 / 引用他人或不存在的笔记 / `evidence.noteId` 不在 source 内 /
`superseded_by` 悬空或成环；另外检查摘要区间递增不重叠、每个会话只有一个未取代头部，
以及助手回复里是否出现「根据你的笔记第 N 条」这类机械引用。

---

## 6. 阶段 C：心跳与克制

### 6.1 去重（并发）

```text
  ok    10 次并发只落 1 条 · 成功返回 1 次，库中 1 行
  ok    再次重试仍只有 1 条 · 返回全为 null，库中 1 行
  ok    不同 dedupe_key 正常写入
```

靠的是 `UNIQUE(user_id, dedupe_key)` + `ON CONFLICT DO NOTHING`，不是内存状态——
多 worker / 多个 tick 同时跑也只会有一条。

### 6.2 退避与冷却 **（发现并修复一个真实 bug）**

```text
  ok    未回应计数累加 · consecutive_ignored=3
  ok    退避表 3 次 → 72h
  ok    冷却时间写入 · 72.0h
  ok    冷却期内不发 · reason=cooldown
  ok    用户回话后解除冷却
```

修复内容：`markStaleProactive` 原实现按「每用户每轮 +1」累加，
3 条消息未回应只记 1 次，冷却永远停在 6h，§8.5 的「3 次未回 → 72h」永远达不到。
已改为按条数累加（`select user_id, count(*) group by user_id`）。

### 6.3 50 并发 SSE

```text
轮次 1: 成功 49/50，p95 首字节 1005ms
  ok    完整流成功率 · 49/50（错误率 2%，WASM 引擎容差内）
  ok    首字节延迟 p95 · 1005ms
  首字节 p50 991ms · p95 1005ms
  单条完成 p50 2990ms · 平均字数 60
  ok    中断后半截落库 · 首 token 52ms 后中断，落库 1 字
```

- 那个 500 是 PGlite socket 层的 `portal "" does not exist`（并发下协议实现缺陷），
  日志里能定位到 `DatabaseError / code 34000`，不是应用逻辑问题；脚本对 WASM 给了 5% 容差，
  在真实 PG 上是零容忍。**这一点必须在真机上复测。**
- 首字节 ~1s 也是 WASM 串行队列的结果（mock 每字 25ms，50 并发排队），不代表生产延迟。
- **中断用例**：收到第一个 token 后立刻 abort，服务端只落库 1 个字。
  说明上游 LLM 循环被及时终止、`finally` 正常执行——这正是 §8.5 要的「退出 SSE 后上游被 abort」。

---

## 7. 复现整套验收

```powershell
# 终端 1：数据库（真实 PG 用 pnpm pg:setup 起，这里用 WASM 版）
pnpm pg:wasm

# 终端 2：mock LLM（没 Key 时）
pnpm mock:llm

# 终端 3：准备数据
$env:DATABASE_URL="postgres://companion:companion_dev@127.0.0.1:5433/companion"
$env:EMBEDDING_BASE_URL="http://127.0.0.1:4010/v1"
$env:EMBEDDING_API_KEY="mock-key"
pnpm db:migrate
pnpm db:seed
pnpm corpus:distractors --count=300
pnpm backfill:embeddings

# 纯数据库断言
pnpm check:indexes
pnpm eval:retrieval
pnpm check:insights
pnpm check:evidence
pnpm check:dedupe
pnpm check:cooldown

# HTTP 压测（需要服务已启动）
$env:JOBS_ENABLED="false"      # WASM 环境不支持 pg-boss；真实 PG 去掉这行
pnpm dev
pnpm load:sse --concurrency=50 --rounds=1
```

---

## 8. 剩余风险 / 未覆盖

| 项 | 说明 |
| -- | ---- |
| 真机 EXPLAIN | 需在原生 PG 上跑 `pnpm check:indexes`，确认两条计划断言转绿 |
| 真实吞吐 | 50 并发 5 分钟长压测需真机；WASM 数字不可用于容量规划 |
| 真实检索指标 | 换 bge-m3 后重跑 `eval:retrieval`，目标 Recall@10 ≥ 0.80、MRR ≥ 0.65 |
| pg-boss 端到端 | WASM 不支持，心跳/摘要/反思 job 的真实调度需真机验证 |
| 微信订阅消息 | 需真实 appid / 模板 id，当前用 mock 与降级路径覆盖 |
| ComfyUI | 工作流为占位，阶段 D 范围 |
