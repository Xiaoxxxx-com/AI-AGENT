import type { FastifyInstance } from 'fastify';
import { comfyuiHealthy } from '../vision/comfyui.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  /** 同时检查 DB + 队列 + pgvector，不只是进程活着 */
  app.get('/healthz', async (_req, reply) => {
    const checks: Record<string, unknown> = {};

    let ok = true;

    try {
      const { rows } = await app.pool.query<{ vector: string | null; trgm: string | null }>(
        `select
           (select extversion from pg_extension where extname = 'vector') as vector,
           (select extversion from pg_extension where extname = 'pg_trgm') as trgm`,
      );
      const row = rows[0];
      checks.db = { ok: true, pgvector: row?.vector ?? null, pgTrgm: row?.trgm ?? null };
      if (!row?.vector) {
        ok = false;
        checks.vector = 'missing';
      }
    } catch (err) {
      ok = false;
      checks.db = { ok: false, error: err instanceof Error ? err.message : 'unknown' };
    }

    try {
      const queues = await app.boss.getQueues();
      checks.queue = { ok: true, count: queues.length };
    } catch (err) {
      ok = false;
      checks.queue = { ok: false, error: err instanceof Error ? err.message : 'unknown' };
    }

    checks.vision = { enabled: app.config.COMFYUI_ENABLED, healthy: await comfyuiHealthy() };
    // 主动触达是否配好直推通道；自用场景没有它就只能靠订阅消息额度
    checks.push = { kind: app.config.PUSH_KIND, configured: app.config.pushEnabled };

    return reply.code(ok ? 200 : 503).send({
      ok,
      service: 'companion-api',
      model: app.config.DEEPSEEK_MODEL,
      embedding: { model: app.config.EMBEDDING_MODEL, dim: app.config.EMBEDDING_DIM },
      checks,
      ts: new Date().toISOString(),
    });
  });
}
