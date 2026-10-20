import fp from 'fastify-plugin';
import PgBoss from 'pg-boss';
import type { FastifyInstance } from 'fastify';
import { ALL_QUEUES } from '../queue.js';

/**
 * pg-boss v10 的两个坑（都踩过）：
 * 1. 必须先 createQueue，才能 work/schedule；
 * 2. handler 收到的是 **数组**，不是单个 job。
 */
export default fp(
  async (app: FastifyInstance) => {
    // HTTP-only 模式：不启 pg-boss，路由里的 boss.send 变成空操作。
    // 用于本地验收（PGlite 不支持 pg-boss 需要的 advisory lock/NOTIFY 组合）与只读调试。
    if (!app.config.JOBS_ENABLED) {
      const noop = {
        send: async () => null,
        work: async () => '',
        schedule: async () => undefined,
        unschedule: async () => undefined,
        createQueue: async () => undefined,
        start: async () => undefined,
        stop: async () => undefined,
        getQueues: async () => [],
      };
      app.decorate('boss', noop as unknown as PgBoss);
      app.log.warn('[jobs] JOBS_ENABLED=false：队列为 no-op，不执行心跳/摘要/反思');
      return;
    }

    const boss = new PgBoss({
      connectionString: app.config.DATABASE_URL,
      max: app.config.JOB_CONCURRENCY,
      application_name: 'companion:worker',
      retentionDays: 14,
      // 后台任务不需要秒级轮询
      monitorStateIntervalSeconds: 30,
    });

    boss.on('error', (err: unknown) => {
      app.log.error({ err }, '[jobs] pg-boss error');
    });

    await boss.start();
    for (const name of ALL_QUEUES) {
      await boss.createQueue(name);
    }
    app.log.info({ queues: ALL_QUEUES.length }, '[jobs] queues ready');

    app.decorate('boss', boss);

    app.addHook('onClose', async () => {
      app.log.info('[jobs] stopping pg-boss');
      await boss.stop({ graceful: true, timeout: 10_000 });
    });
  },
  { name: 'jobs' },
);
