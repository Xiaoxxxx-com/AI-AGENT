import fp from 'fastify-plugin';
import { SignJWT, jwtVerify } from 'jose';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * JWT 鉴权。业务里 user_id 只从 token 的 sub 取，绝不相信请求体。
 * 用 jose 而不是 @fastify/jwt：更轻，且 ESM 下没有 CJS 互操作问题。
 */
export default fp(
  async (app: FastifyInstance) => {
    const secret = new TextEncoder().encode(app.config.JWT_SECRET);

    app.decorateRequest('user', null);

    app.decorate('signToken', async (userId: number): Promise<string> =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(String(userId))
        .setIssuedAt()
        .setExpirationTime(app.config.JWT_TTL)
        .sign(secret),
    );

    app.decorate(
      'authenticate',
      async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) {
          await reply.code(401).send({ error: 'unauthorized', message: '缺少 Bearer token' });
          return;
        }
        try {
          const { payload } = await jwtVerify(header.slice(7), secret, { algorithms: ['HS256'] });
          const sub = Number(payload.sub);
          if (!Number.isInteger(sub) || sub <= 0) throw new Error('bad sub');
          req.user = { sub };
        } catch {
          await reply.code(401).send({ error: 'unauthorized', message: 'token 无效或已过期' });
        }
      },
    );
  },
  { name: 'auth' },
);
