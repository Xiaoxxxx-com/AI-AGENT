import type PgBoss from 'pg-boss';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database, Pool } from './db/client.js';
import type { Embedder } from './memory/embed.js';
import type { env as appEnv } from './config.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: typeof appEnv;
    pool: Pool;
    db: Database;
    boss: PgBoss;
    embedder: Embedder;
    /** 签发 JWT（auth 插件注入） */
    signToken(userId: number): Promise<string>;
    /** preHandler 鉴权钩子（auth 插件注入） */
    authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void>;
  }

  interface FastifyRequest {
    /** 由 auth 插件注入；所有业务查询的 user_id 只能取这里 */
    user: { sub: number } | null;
  }
}

export type AuthedRequest = FastifyRequest & { user: { sub: number } };
