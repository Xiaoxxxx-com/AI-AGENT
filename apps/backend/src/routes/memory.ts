import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hybridSearch } from '../memory/hybrid-search.js';
import { toTsQuery } from '../memory/segment.js';

const searchQuery = z.object({
  q: z.string().min(1).max(500),
  topK: z.coerce.number().int().min(1).max(50).default(12),
});

/** 记忆检索的验收入口：能直接看到 RRF 融合结果与命中来源 */
export async function registerMemoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/memory/search', { preHandler: app.authenticate }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    const parsed = searchQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad-request', message: '缺少 q 参数' });
    }
    const { q, topK } = parsed.data;

    let vec: number[] | null = null;
    let degraded: string | null = null;
    try {
      const [v] = await app.embedder.embed([q]);
      vec = v ?? null;
    } catch (err) {
      degraded = 'embedding-unavailable';
      req.log.warn({ err }, '[memory] embedding 失败，退化为关键词检索');
    }

    const started = Date.now();
    const items = await hybridSearch(app.pool, { userId, query: q, queryVec: vec, topK });
    const costMs = Date.now() - started;

    // 便于排查“关键词路是不是空的”：分词结果直接回显
    return {
      items,
      meta: {
        topK,
        costMs,
        degraded,
        tokens: toTsQuery(q),
        vectorUsed: vec !== null,
      },
    };
  });
}
