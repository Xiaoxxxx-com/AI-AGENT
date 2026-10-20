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
      last_user_message_at: Date | null;
      last_proactive_at: Date | null;
      next_heartbeat_at: Date | null;
    }>(
      `select current_mood, energy, consecutive_ignored, cooldown_until, daily_proactive_count,
              last_user_message_at, last_proactive_at, next_heartbeat_at
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

  /**
   * 数据导出（隐私合规：用户有权带走自己的全部数据）。
   * 返回一个 JSON，包含笔记、对话、洞察、摘要、主动消息，不含 session_key 等凭证。
   */
  app.get('/account/export', { preHandler: app.authenticate }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    const [u, notes, convs, insights, summaries, proactive] = await Promise.all([
      app.pool.query(`select id, nickname, timezone, proactive_enabled, created_at from users where id = $1`, [userId]),
      app.pool.query(`select id, title, content, created_at from notes where user_id = $1 order by id`, [userId]),
      app.pool.query(
        `select id, role, content, session_id, created_at from conversations where user_id = $1 order by id`,
        [userId],
      ),
      app.pool.query(
        `select id, insight_type, content, confidence, source_note_ids, created_at from user_insights where user_id = $1 order by id`,
        [userId],
      ),
      app.pool.query(
        `select id, session_id, summary, covers_from_id, covers_to_id, created_at from conversation_summaries where user_id = $1 order by id`,
        [userId],
      ),
      app.pool.query(
        `select id, trigger_type, message, status, channel, created_at from proactive_log where user_id = $1 order by id`,
        [userId],
      ),
    ]);

    if (!u.rows[0]) return reply.code(404).send({ error: 'not-found' });

    reply.header('content-disposition', `attachment; filename="companion-export-${userId}.json"`);
    return {
      exportedAt: new Date().toISOString(),
      user: u.rows[0],
      notes: notes.rows,
      conversations: convs.rows,
      insights: insights.rows,
      summaries: summaries.rows,
      proactive: proactive.rows,
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
