import type { Pool } from '../db/client.js';

/**
 * companion_state 的读写都在这里，全用参数化 SQL：
 * - claimDueUsers 用 FOR UPDATE SKIP LOCKED，多个 tick 并发也不会重复领同一个用户
 * - 所有更新都带 version + 1，避免心跳与对话互相覆盖
 */

export interface DueUser {
  userId: number;
}

export interface StateSnapshot {
  userId: number;
  currentMood: string;
  energy: number;
  consecutiveIgnored: number;
  cooldownUntil: Date | null;
  lastUserMessageAt: Date | null;
  lastProactiveAt: Date | null;
  dailyProactiveCount: number;
  dailyCountDate: string;
  version: number;
}

export async function ensureState(pool: Pool, userId: number): Promise<void> {
  await pool.query(
    `insert into companion_state (user_id) values ($1)
     on conflict (user_id) do nothing`,
    [userId],
  );
}

export async function getState(pool: Pool, userId: number): Promise<StateSnapshot | null> {
  const { rows } = await pool.query<{
    user_id: string;
    current_mood: string;
    energy: number;
    consecutive_ignored: number;
    cooldown_until: Date | null;
    last_user_message_at: Date | null;
    last_proactive_at: Date | null;
    daily_proactive_count: number;
    daily_count_date: string;
    version: number;
  }>(
    `select user_id, current_mood, energy, consecutive_ignored, cooldown_until,
            last_user_message_at, last_proactive_at, daily_proactive_count,
            daily_count_date::text as daily_count_date, version
     from companion_state where user_id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    userId: Number(r.user_id),
    currentMood: r.current_mood,
    energy: Number(r.energy),
    consecutiveIgnored: r.consecutive_ignored,
    cooldownUntil: r.cooldown_until,
    lastUserMessageAt: r.last_user_message_at,
    lastProactiveAt: r.last_proactive_at,
    dailyProactiveCount: r.daily_proactive_count,
    dailyCountDate: r.daily_count_date,
    version: r.version,
  };
}

/** tick + 每用户任务的两级调度：先原子领取到期用户，再把 next_heartbeat_at 往后推 */
export async function claimDueUsers(
  pool: Pool,
  limit: number,
  intervalMinutes: number,
): Promise<DueUser[]> {
  const { rows } = await pool.query<{ user_id: string }>(
    `with due as (
       select user_id
       from companion_state
       where next_heartbeat_at <= now()
       order by next_heartbeat_at
       limit $1
       for update skip locked
     )
     update companion_state s
     set next_heartbeat_at = now() + ($2 || ' minutes')::interval,
         updated_at = now(),
         version = s.version + 1
     from due
     where s.user_id = due.user_id
     returning s.user_id`,
    [limit, String(intervalMinutes)],
  );
  return rows.map((r) => ({ userId: Number(r.user_id) }));
}

export async function updateEnergy(pool: Pool, userId: number, energy: number): Promise<void> {
  const clamped = Math.min(1, Math.max(0, energy));
  await pool.query(
    `update companion_state
     set energy = $2, updated_at = now(), version = version + 1
     where user_id = $1`,
    [userId, clamped],
  );
}

/** 用户任意消息到达：清冷却、清未回应计数、顺带把最近一条主动消息标记为已回应 */
export async function resetOnUserMessage(pool: Pool, userId: number): Promise<void> {
  await pool.query(
    `update companion_state
     set consecutive_ignored = 0,
         cooldown_until = null,
         last_user_message_at = now(),
         updated_at = now(),
         version = version + 1
     where user_id = $1`,
    [userId],
  );
  await pool.query(
    `update proactive_log
     set user_replied = true
     where id = (
       select id from proactive_log
       where user_id = $1 and user_replied is null
       order by created_at desc
       limit 1
     )`,
    [userId],
  );
}

export async function setCooldown(pool: Pool, userId: number, hours: number): Promise<void> {
  await pool.query(
    `update companion_state
     set cooldown_until = now() + ($2 || ' hours')::interval,
         updated_at = now(),
         version = version + 1
     where user_id = $1`,
    [userId, String(hours)],
  );
}

/**
 * 投递后 6 小时仍未回应的，标记 user_replied = false 并累加 consecutive_ignored。
 * 这个判断必须由数据库任务维护，不能交给 LLM。
 */
export async function markStaleProactive(pool: Pool): Promise<number[]> {
  const { rows } = await pool.query<{ user_id: string }>(
    `with stale as (
       select id, user_id from proactive_log
       where status in ('sent') and user_replied is null
         and created_at < now() - interval '6 hours'
       for update skip locked
     )
     update proactive_log p
     set user_replied = false
     from stale s
     where p.id = s.id
     returning p.user_id`,
    [],
  );

  const userIds = [...new Set(rows.map((r) => Number(r.user_id)))];
  for (const userId of userIds) {
    await pool.query(
      `update companion_state
       set consecutive_ignored = consecutive_ignored + 1,
           updated_at = now(),
           version = version + 1
       where user_id = $1`,
      [userId],
    );
  }
  return userIds;
}

/**
 * 今日主动数 +1，跨天自动归零。
 * 条件更新（daily_count_date = 今天）保证并发安全。
 */
export async function incrementDailyCount(pool: Pool, userId: number, localDate: string): Promise<void> {
  await pool.query(
    `update companion_state
     set daily_proactive_count = case when daily_count_date = $2::date then daily_proactive_count + 1 else 1 end,
         daily_count_date = $2::date,
         last_proactive_at = now(),
         updated_at = now(),
         version = version + 1
     where user_id = $1`,
    [userId, localDate],
  );
}

export async function setMood(pool: Pool, userId: number, mood: string): Promise<void> {
  await pool.query(
    `update companion_state set current_mood = $2, updated_at = now(), version = version + 1
     where user_id = $1`,
    [userId, mood],
  );
}

