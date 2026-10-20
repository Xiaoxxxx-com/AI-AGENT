/**
 * 阶段 A 验收：索引与检索链路的硬断言。
 *
 *   pnpm check:indexes
 *
 * 断言项（任一失败退出码非 0）：
 *   1. pgvector / pg_trgm 扩展存在
 *   2. HNSW 索引存在且参数为 m=16, ef_construction=64
 *   3. 关掉 seqscan 后，向量排序真的走 idx_notes_embedding
 *   4. 关掉 seqscan 后，tsquery 检索真的走 idx_notes_tsvector
 *   5. 每条笔记的 content_tsvector 都非空（中文分词没写进 content_tokens 的回归点）
 *
 * 「走索引」用 SET enable_seqscan=off 来断言：小表时规划器本来就会选 Seq Scan，
 * 关掉之后如果还能选索引，说明索引可用且能被用上。
 */
import 'dotenv/config';
import { createPool } from '../apps/backend/src/db/client.js';
import { createEmbedderFromEnv, toSqlVector } from '../apps/backend/src/memory/embed.js';
import { toTsQuery } from '../apps/backend/src/memory/segment.js';
import { env } from '../apps/backend/src/config.js';

let failed = 0;
let skipped = 0;
const ok = (name: string, detail = '') => console.log(`  ok    ${name}${detail ? ` · ${detail}` : ''}`);
const bad = (name: string, detail: string) => {
  failed += 1;
  console.error(`  FAIL  ${name} · ${detail}`);
};
const skip = (name: string, why: string) => {
  skipped += 1;
  console.log(`  skip  ${name} · ${why}`);
};

const pool = createPool(env.DATABASE_URL, 4, 'check-indexes');

try {
  const ver = await pool.query<{ v: string }>(`select version() as v`);
  const versionText = ver.rows[0]?.v ?? '';
  // PGlite（WASM）能建 GIN/HNSW 索引，但规划器不实现这两种扫描；
  // 所以「是否走索引」只能在真实 PostgreSQL 上断言。
  const isWasm = /PGlite|wasm32/i.test(versionText);
  console.log(`${versionText.split(',')[0]}`);
  if (isWasm) console.log('（WASM 引擎：索引定义可验，执行计划断言将跳过）\n');
  else console.log('');

  // 1. 扩展
  const ext = await pool.query<{ extname: string; extversion: string }>(
    `select extname, extversion from pg_extension where extname in ('vector','pg_trgm') order by extname`,
  );
  const exts = new Map(ext.rows.map((r) => [r.extname, r.extversion]));
  exts.has('vector') ? ok('pgvector', exts.get('vector')) : bad('pgvector', '未安装');
  exts.has('pg_trgm') ? ok('pg_trgm', exts.get('pg_trgm')) : bad('pg_trgm', '未安装');

  // 2. 索引存在 + HNSW 参数
  const idx = await pool.query<{ indexname: string; indexdef: string }>(
    `select indexname, indexdef from pg_indexes
     where schemaname = 'public' and tablename = 'notes' order by indexname`,
  );
  const defs = new Map(idx.rows.map((r) => [r.indexname, r.indexdef]));
  for (const name of ['idx_notes_embedding', 'idx_notes_tsvector']) {
    defs.has(name) ? ok(`索引存在 ${name}`) : bad(`索引存在 ${name}`, '缺失');
  }

  const relopts = await pool.query<{ reloptions: string[] | null }>(
    `select reloptions from pg_class where relname = 'idx_notes_embedding'`,
  );
  const ro = (relopts.rows[0]?.reloptions ?? []).join(',');
  const hasM = /m=16/.test(ro);
  const hasEf = /ef_construction=64/.test(ro);
  hasM && hasEf ? ok('HNSW 参数', ro) : bad('HNSW 参数', `期望 m=16,ef_construction=64，实际 ${ro || '空'}`);

  // 3/4. 关掉 seqscan 后确实用上索引
  const userIdRes = await pool.query<{ id: string }>(
    `select id from users where wechat_openid = 'seed-openid-001'`,
  );
  const userId = Number(userIdRes.rows[0]?.id);
  if (!userId) throw new Error('找不到 seed 用户，先跑 pnpm db:seed');

  const [vec] = await createEmbedderFromEnv(env).embed(['最近工作压力大，天天加班']);
  if (!vec) throw new Error('embedding 返回为空');

  const client = await pool.connect();
  try {
    await client.query('ANALYZE notes');
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL hnsw.ef_search = 40');

    const planVec = await client.query<{ 'QUERY PLAN': string }>(
      `explain select id from notes where user_id = $1 and embedding is not null
       order by embedding <=> $2::vector limit 5`,
      [userId, toSqlVector(vec)],
    );
    const vecPlan = planVec.rows.map((r) => r['QUERY PLAN']).join('\n');

    const planKw = await client.query<{ 'QUERY PLAN': string }>(
      `explain select id from notes where user_id = $1 and content_tsvector @@ to_tsquery('simple', $2) limit 5`,
      [userId, toTsQuery('最近工作压力大')],
    );
    const kwPlan = planKw.rows.map((r) => r['QUERY PLAN']).join('\n');

    const vecUsed = /Index Scan using idx_notes_embedding/i.test(vecPlan);
    const kwUsed = /idx_notes_tsvector/i.test(kwPlan);

    if (isWasm) {
      skip('向量排序走 HNSW 索引', vecUsed ? '意外命中，可忽略' : 'WASM 引擎不实现 hnsw 扫描');
      skip('tsquery 检索走 GIN 索引', kwUsed ? '意外命中，可忽略' : 'WASM 引擎不实现 GIN 扫描');
    } else {
      vecUsed
        ? ok('向量排序走 HNSW 索引')
        : bad('向量排序走 HNSW 索引', vecPlan.split('\n').slice(0, 3).join(' / '));
      kwUsed
        ? ok('tsquery 检索走 GIN 索引')
        : bad('tsquery 检索走 GIN 索引', kwPlan.split('\n').slice(0, 3).join(' / '));
    }

    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  // 5. content_tsvector 覆盖率（中文分词的回归点）
  const cov = await pool.query<{ total: number; empty: number }>(
    `select count(*)::int as total,
            count(*) filter (where content_tsvector is null or content_tsvector = ''::tsvector)::int as empty
     from notes where user_id = $1`,
    [userId],
  );
  const { total, empty } = cov.rows[0] ?? { total: 0, empty: 0 };
  empty === 0
    ? ok('content_tsvector 覆盖率', `${total}/${total} 非空`)
    : bad('content_tsvector 覆盖率', `${empty}/${total} 为空（content_tokens 没写进去？）`);

  // 附：embedding 覆盖率
  const emb = await pool.query<{ total: number; done: number }>(
    `select count(*)::int as total, count(embedding)::int as done from notes where user_id = $1`,
    [userId],
  );
  const e = emb.rows[0];
  if (e) {
    e.done === e.total
      ? ok('embedding 覆盖率', `${e.done}/${e.total}`)
      : bad('embedding 覆盖率', `${e.done}/${e.total}，跑 pnpm backfill:embeddings`);
  }
} finally {
  await pool.end();
}

console.log(
  failed === 0
    ? `\n断言通过${skipped > 0 ? `（${skipped} 项因引擎限制跳过）` : ''}`
    : `\n${failed} 项断言失败`,
);
if (failed > 0) process.exit(1);
