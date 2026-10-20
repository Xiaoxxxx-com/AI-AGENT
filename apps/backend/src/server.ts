import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { fastifySSE } from '@fastify/sse';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { env } from './config.js';
import { buildLoggerOptions } from './plugins/log.js';
import dbPlugin from './plugins/db.js';
import jobsPlugin from './plugins/jobs.js';
import authPlugin from './plugins/auth.js';
import { createEmbedderFromEnv } from './memory/embed.js';
import { registerWorkers } from './workers.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerNoteRoutes } from './routes/notes.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerProactiveRoutes } from './routes/proactive.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerChatRoutes } from './chat/stream.js';

/**
 * 启动顺序：校验 env → 建池 → 注册插件 → 注册路由 → 启动队列 → 注册 worker → listen
 * 关闭顺序反过来：停止收请求 → boss.stop() → pool.end()
 */
async function main(): Promise<void> {
  const app = Fastify({
    logger: buildLoggerOptions(),
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  app.decorate('config', env);
  app.decorate('embedder', createEmbedderFromEnv(env));

  await app.register(fastifySSE, { heartbeatInterval: 15_000 });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.corsOrigins.length > 0 ? env.corsOrigins : false,
    credentials: false,
  });
  // 全局兜底限流；登录/聊天在路由上单独收紧
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  await app.register(dbPlugin);
  await app.register(jobsPlugin);
  await app.register(authPlugin);

  // ComfyUI 产出的图片走本地目录；目录不存在时也建出来，避免启动失败
  const imageDir = path.resolve(env.STORAGE_DIR, 'images');
  await mkdir(imageDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: imageDir,
    prefix: '/static/images/',
    maxAge: '7d',
    decorateReply: false,
  });

  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerNoteRoutes(app);
  await registerMemoryRoutes(app);
  await registerProactiveRoutes(app);
  await registerAccountRoutes(app);
  await registerChatRoutes(app);

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err, url: req.url }, '[http] 未处理错误');
    }
    reply.code(status).send({
      error: status >= 500 ? 'internal-error' : (err.code ?? 'request-error'),
      message: status >= 500 && env.isProd ? '服务暂时不可用' : err.message,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'not-found', path: req.url });
  });

  await registerWorkers({
    pool: app.pool,
    boss: app.boss,
    log: app.log,
    embedder: app.embedder,
  });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      model: env.DEEPSEEK_MODEL,
      embedding: `${env.EMBEDDING_MODEL}@${env.EMBEDDING_DIM}`,
      comfyui: env.COMFYUI_ENABLED,
    },
    'companion-api ready',
  );

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('启动失败：', err);
  process.exit(1);
});
