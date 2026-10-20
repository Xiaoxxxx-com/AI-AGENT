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

  /**
   * 洞察列表（只读）。
   * B 阶段产出的东西本来只喂进 prompt，人看不到；这里给界面一个入口，
   * 顺带把「被谁取代」的溯源一起返回。
   */
  app.get('/insights', { preHandler: app.authenticate }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    const q = req.query as { limit?: string; includeSuperseded?: string };
    const limit = Math.min(100, Number(q.limit ?? 30) || 30);
    const includeSuperseded = q.includeSuperseded === '1' || q.includeSuperseded === 'true';

    // 用 type 而不是 interface：interface 没有隐式索引签名，
    // 不满足 pg 的 QueryResultRow 约束，泛型会退化成 any
    type InsightRow = {
      id: string;
      insight_type: string;
      content: string;
      confidence: number;
      source_note_ids: string[] | null;
      is_active: boolean;
      superseded_by: string | null;
      superseded_reason: string | null;
      created_at: Date;
      updated_at: Date;
    };

    const { rows } = await app.pool.query<InsightRow>(
      `select id, insight_type, content, confidence, source_note_ids,
              is_active, superseded_by, superseded_reason, created_at, updated_at
       from user_insights
       where user_id = $1 and ($2::boolean or is_active = true)
       order by is_active desc, confidence desc, id desc
       limit $3`,
      [userId, includeSuperseded, limit],
    );

    return {
      items: rows.map((r: InsightRow) => ({
        id: Number(r.id),
        type: r.insight_type,
        content: r.content,
        confidence: r.confidence,
        noteIds: (r.source_note_ids ?? []).map(Number),
        isActive: r.is_active,
        supersededBy: r.superseded_by ? Number(r.superseded_by) : null,
        supersededReason: r.superseded_reason,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      meta: { limit, includeSuperseded },
    };
  });
}
