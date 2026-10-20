import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { jscode2session } from '../auth/wechat.js';
import { ensureState } from '../companion/state.js';

const loginInput = z.object({ code: z.string().min(1).max(200) });

/**
 * 微信登录：code → openid → upsert users → 签发 JWT。
 * session_key 不落库、不返回。
 */
export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/auth/wechat',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = loginInput.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'bad-request', message: '缺少 code' });
      }

      if (!app.config.wechatEnabled) {
        return reply.code(503).send({
          error: 'wechat-not-configured',
          message: '服务端未配置 WECHAT_APPID / WECHAT_SECRET；本地开发可用 POST /auth/dev',
        });
      }

      let session;
      try {
        session = await jscode2session(parsed.data.code);
      } catch (err) {
        req.log.warn({ err }, '[auth] jscode2session 失败');
        return reply.code(401).send({ error: 'wechat-auth-failed', message: '微信登录失败' });
      }

      const { rows } = await app.pool.query<{ id: string }>(
        `insert into users (wechat_openid, unionid)
         values ($1, $2)
         on conflict (wechat_openid) do update set unionid = coalesce(excluded.unionid, users.unionid)
         returning id`,
        [session.openid, session.unionid ?? null],
      );

      const userId = Number(rows[0]?.id);
      await ensureState(app.pool, userId);
      const token = await app.signToken(userId);
      return { token, userId };
    },
  );

  /**
   * 本地开发登录：只在非生产环境注册，用来在没有小程序的情况下跑通链路。
   * 生产环境该路由不存在。
   */
  if (!app.config.isProd) {
    app.post('/auth/dev', async (req) => {
      const body = z.object({ openid: z.string().default('dev-openid-001') }).safeParse(req.body ?? {});
      const openid = body.success ? body.data.openid : 'dev-openid-001';
      const { rows } = await app.pool.query<{ id: string }>(
        `insert into users (wechat_openid) values ($1)
         on conflict (wechat_openid) do update set updated_at = now()
         returning id`,
        [openid],
      );
      const userId = Number(rows[0]?.id);
      await ensureState(app.pool, userId);
      return { token: await app.signToken(userId), userId, openid };
    });
  }
}
