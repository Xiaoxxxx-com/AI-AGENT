import type { FastifyBaseLogger } from 'fastify';
import type PgBoss from 'pg-boss';
import type { Pool } from './db/client.js';
import type { Embedder } from './memory/embed.js';
import { QUEUE, type HeartbeatUserJob, type NoteIndexJob, type ReflectUserJob, type SummarizeJob, type DeliverJob } from './queue.js';
import { handleHeartbeatUser } from './companion/heartbeat.js';
import { deliverProactive } from './companion/delivery.js';
import { reflectUser } from './companion/reflection.js';
import { backoffHours } from './companion/proactive.js';
import { claimDueUsers, getState, markStaleProactive, setCooldown } from './companion/state.js';
import { summarizeSession } from './memory/summarize.js';
import { embedNote } from './memory/index-note.js';

export interface WorkerDeps {
  pool: Pool;
  boss: PgBoss;
  log: FastifyBaseLogger;
  embedder: Embedder;
}

/**
 * pg-boss v10 的三个硬约束：
 * 1. handler 收到的是数组 `jobs`；
 * 2. 队列必须先 createQueue（在 plugins/jobs.ts 做）；
 * 3. schedule 也是绑在队列上的，队列不存在会失败。
 *
 * 调度用「tick + 每用户任务」两级，不要给每个用户建一条 cron。
 */
export async function registerWorkers(deps: WorkerDeps): Promise<void> {
  const { pool, boss, log, embedder } = deps;
  const heartbeatMinutes = 30;

  // ---- 心跳 tick：领取到期用户，扇出成单用户任务 ----
  await boss.work(QUEUE.heartbeatTick, async () => {
    const due = await claimDueUsers(pool, 50, heartbeatMinutes);
    log.debug({ count: due.length }, '[jobs] heartbeat tick');
    for (const u of due) {
      await boss.send(
        QUEUE.heartbeatUser,
        { userId: u.userId } satisfies HeartbeatUserJob,
        { singletonKey: `hb:${u.userId}` },
      );
    }
  });

  await boss.work<HeartbeatUserJob>(QUEUE.heartbeatUser, async ([job]) => {
    if (!job) return;
    const result = await handleHeartbeatUser({ pool, boss, log }, job.data.userId);
    log.debug({ userId: job.data.userId, ...result }, '[jobs] heartbeat.user done');
  });

  // ---- 摘要 ----
  await boss.work<SummarizeJob>(QUEUE.memorySummarize, async ([job]) => {
    if (!job) return;
    const { userId, sessionId } = job.data;
    const result = await summarizeSession(pool, userId, sessionId);
    log.debug({ userId, ...result }, '[jobs] summarize done');
  });

  // ---- 每日反思：tick 扇出 ----
  await boss.work(QUEUE.insightReflect, async () => {
    const { rows } = await pool.query<{ id: string }>(
      `select distinct u.id
       from users u
       join notes n on n.user_id = u.id
       where n.created_at > now() - interval '7 days'
       limit 200`,
    );
    log.info({ users: rows.length }, '[jobs] reflect tick');
    for (const r of rows) {
      await boss.send(
        QUEUE.insightReflectUser,
        { userId: Number(r.id) } satisfies ReflectUserJob,
        { singletonKey: `reflect:${r.id}` },
      );
    }
  });

  await boss.work<ReflectUserJob>(QUEUE.insightReflectUser, async ([job]) => {
    if (!job) return;
    const result = await reflectUser(pool, embedder, job.data.userId);
    log.info({ userId: job.data.userId, ...result }, '[jobs] reflect done');
  });

  // ---- 投递 ----
  await boss.work<DeliverJob>(QUEUE.proactiveDeliver, async ([job]) => {
    if (!job) return;
    await deliverProactive({ pool, log }, job.data.proactiveId);
  });

  // ---- 笔记向量化 ----
  await boss.work<NoteIndexJob>(QUEUE.noteIndex, async ([job]) => {
    if (!job) return;
    const ok = await embedNote(pool, embedder, job.data.noteId, job.data.userId);
    if (!ok) log.warn({ noteId: job.data.noteId }, '[jobs] 笔记向量化跳过');
  });

  // ---- 每小时：标记 6 小时未回应的主动消息，按退避设冷却 ----
  await boss.work(QUEUE.staleSweep, async () => {
    const userIds = await markStaleProactive(pool);
    for (const userId of userIds) {
      const state = await getState(pool, userId);
      if (!state) continue;
      const hours = backoffHours(state.consecutiveIgnored);
      if (hours > 0) await setCooldown(pool, userId, hours);
      log.info({ userId, ignored: state.consecutiveIgnored, cooldownHours: hours }, '[jobs] 未回应，进入冷却');
    }
  });

  // ---- 定时任务 ----
  await boss.schedule(QUEUE.heartbeatTick, '*/5 * * * *', {}, { tz: 'Asia/Shanghai' });
  await boss.schedule(QUEUE.insightReflect, '0 3 * * *', {}, { tz: 'Asia/Shanghai' });
  await boss.schedule(QUEUE.staleSweep, '20 * * * *', {}, { tz: 'Asia/Shanghai' });

  log.info('[jobs] workers registered');
}
