import type { FastifyInstance } from 'fastify';
import { markProactiveRead, takePendingProactive } from '../companion/delivery.js';

export async function registerProactiveRoutes(app: FastifyInstance): Promise<void> {
  /** 小程序进入聊天页时拉取：正文只从这里读，订阅消息里只有"她给你留了一句话" */
  app.get('/proactive/pending', { preHandler: app.authenticate }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const items = await takePendingProactive(app.pool, userId);
    return { items };
  });

  app.post('/proactive/:id/read', { preHandler: app.authenticate }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad-request' });

    const ok = await markProactiveRead(app.pool, userId, id);
    return { ok };
  });

  /**
   * 订阅授权记账。前端在 wx.requestSubscribeMessage 返回 accept 后调用。
   * 一次授权只能发一条，所以这里 +1 而不是 +N。
   */
  app.post('/proactive/subscribe', { preHandler: app.authenticate }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    const { rows } = await app.pool.query<{ subscription_quota: number }>(
      `update users set subscription_quota = subscription_quota + 1, updated_at = now()
       where id = $1 returning subscription_quota`,
      [userId],
    );
    return { quota: rows[0]?.subscription_quota ?? 0 };
  });

  /** 主动关怀开关（随时可关，合规要求） */
  app.post('/proactive/toggle', { preHandler: app.authenticate }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const enabled = Boolean((req.body as { enabled?: boolean } | undefined)?.enabled);

    const { rows } = await app.pool.query<{ proactive_enabled: boolean }>(
      `update users set proactive_enabled = $2, updated_at = now()
       where id = $1 returning proactive_enabled`,
      [userId, enabled],
    );
    return { proactiveEnabled: rows[0]?.proactive_enabled ?? enabled };
  });
}
