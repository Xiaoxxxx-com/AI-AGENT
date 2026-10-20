import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { createDb, createPool } from '../db/client.js';

/** 挂载 pg.Pool + drizzle 实例，随服务关闭一起释放。 */
export default fp(
  async (app: FastifyInstance) => {
    const pool = createPool(app.config.DATABASE_URL, app.config.PG_POOL_MAX, 'api');
    const db = createDb(pool);

    app.decorate('pool', pool);
    app.decorate('db', db);

    app.addHook('onClose', async () => {
      app.log.info('[db] closing pool');
      await pool.end();
    });

    // 启动即探活，别等第一个请求才发现连不上数据库
    try {
      const { rows } = await pool.query<{ ok: number }>('select 1 as ok');
      if (rows[0]?.ok !== 1) throw new Error('unexpected probe result');
      app.log.info('[db] connected');
    } catch (err) {
      app.log.error({ err }, '[db] connection failed');
      throw err;
    }
  },
  { name: 'db' },
);
