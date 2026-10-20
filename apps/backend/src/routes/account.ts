import type { FastifyInstance } from 'fastify';

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', { preHandler: app.authenticate }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    const { rows } = await app.pool.query<{
      id: string;
      nickname: string | null;
      timezone: string;
      quiet_start: string;
      quiet_end: string;
      proactive_enabled: boolean;
      daily_proactive_cap: number;
      subscription_quota: number;
      created_at: Date;
    }>(
      `select id, nickname, timezone, quiet_start::text as quiet_start, quiet_end::text as quiet_end,
              proactive_enabled, daily_proactive_cap, subscription_quota, created_at
       from users where id = $1`,
      [userId],
    );
    const user = rows[0];
    if (!user) return reply.code(404).send({ error: 'not-found' });

    const state = await app.pool.query<{
      current_mood: string;
      energy: number;
      consecutive_ignored: number;
      cooldown_until: Date | null;
      daily_proactive_count: number;
    }>(
      `select current_mood, energy, consecutive_ignored, cooldown_until, daily_proactive_count
       from companion_state where user_id = $1`,
      [userId],
    );

    return {
      user: {
        id: Number(user.id),
        nickname: user.nickname,
        timezone: user.timezone,
        quietStart: user.quiet_start,
        quietEnd: user.quiet_end,
        proactiveEnabled: user.proactive_enabled,
        dailyProactiveCap: user.daily_proactive_cap,
        subscriptionQuota: user.subscription_quota,
        createdAt: user.created_at,
      },
      state: state.rows[0] ?? null,
    };
  });

  /** 数据删除权：级联删除 notes/conversations/insights/state/proactive */
  app.delete('/account', { preHandler: app.authenticate }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    await app.pool.query(`delete from users where id = $1`, [userId]);
    req.log.info({ userId }, '[account] deleted');
    return { ok: true };
  });
}
