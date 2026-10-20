/**
 * 本地验收用的 PostgreSQL（PGlite：真 PostgreSQL 17 编译成 WASM，带 pgvector 0.8.7）。
 *
 * 适用场景：机器上装不了 PostgreSQL（无 Docker / WSL 被策略禁用 / initdb 被拦），
 * 但仍要跑迁移、种子、检索评测、索引断言、并发 SSE 验收。
 *
 *   pnpm pg:wasm                       # 监听 127.0.0.1:5433
 *   DATABASE_URL=postgres://companion:companion_dev@127.0.0.1:5433/companion pnpm db:migrate
 *
 * 限制（务必知道）：
 * - 单实例单进程，查询串行队列，**不能**用来测吞吐上限，只能测逻辑与延迟量级；
 * - 不支持 pg-boss 依赖的 advisory lock + NOTIFY 组合，所以起服务时要 JOBS_ENABLED=false；
 * - 数据落盘在 var/pglite-data，可以直接删掉重来。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.resolve(ROOT, process.env.PGLITE_DIR ?? 'var/pglite-data');
const PORT = Number(process.env.PGLITE_PORT ?? 5433);
const HOST = '127.0.0.1';

mkdirSync(DATA_DIR, { recursive: true });

const db = await PGlite.create({ dataDir: DATA_DIR, extensions: { vector, pg_trgm } });

await db.exec('CREATE EXTENSION IF NOT EXISTS vector');
await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm');
const ver = await db.query<{ extversion: string }>(
  `select extversion from pg_extension where extname = 'vector'`,
);

// PGlite 是单进程串行队列：连接数开大只是为了让 50 并发压测不被连接数卡住，
// 真正决定吞吐的仍是 WASM 里的串行执行。
const server = new PGLiteSocketServer({
  db,
  port: PORT,
  host: HOST,
  maxConnections: Number(process.env.PGLITE_MAX_CONN ?? 80),
});
await server.start();

console.log(`[pglite] PostgreSQL(WASM) + pgvector ${ver.rows[0]?.extversion ?? '?'} 监听 ${HOST}:${PORT}`);
console.log(`[pglite] data=${DATA_DIR}`);
console.log(`[pglite] DATABASE_URL=postgres://companion:companion_dev@${HOST}:${PORT}/companion`);

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`[pglite] ${signal} → 关闭`);
  try {
    await server.stop();
    await db.close();
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
