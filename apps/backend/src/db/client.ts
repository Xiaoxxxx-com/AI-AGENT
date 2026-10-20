import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const { Pool } = pg;

export type Pool = pg.Pool;

/**
 * 连接池与 pg-boss 各自持有独立池，但都指向同一个库。
 * 注意：application_name 便于在 pg_stat_activity 里区分长连接（SSE）与后台任务。
 */
export function createPool(connectionString: string, max: number, label: string): Pool {
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: `companion:${label}`,
    statement_timeout: 30_000,
  });

  pool.on('error', (err) => {
    // 空闲连接被数据库踢掉时不要让进程崩掉
    // eslint-disable-next-line no-console
    console.error('[db] idle client error', err.message);
  });

  return pool;
}

export function createDb(pool: Pool) {
  return drizzle(pool, { schema, logger: false });
}

export type Database = ReturnType<typeof createDb>;

export { schema };
