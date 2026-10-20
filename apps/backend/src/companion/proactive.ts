import type { Pool } from '../db/client.js';
import { hourSlot, isQuietHours, localDate, zonedParts } from '../lib/time.js';
import type { StateSnapshot } from './state.js';

/**
 * 「克制」是硬规则，不是让 LLM 自己决定。
 * 顺序永远是：先过硬规则 → 再问 LLM → 回来再过一遍硬规则。
 */

export const BACKOFF_HOURS = [0, 6, 24, 72, 168] as const;

export function backoffHours(consecutiveIgnored: number): number {
  if (consecutiveIgnored <= 0) return 0;
  return BACKOFF_HOURS[Math.min(consecutiveIgnored, BACKOFF_HOURS.length - 1)] ?? 168;
}

export interface ProactiveUser {
  id: number;
  timezone: string;
  quietStart: string;
  quietEnd: string;
  proactiveEnabled: boolean;
  dailyProactiveCap: number;
  subscriptionQuota: number;
}

export interface GateResult {
  allowed: boolean;
  /** 写日志用的结构化原因 */
  reason?:
    | 'proactive-disabled'
    | 'quiet-hours'
    | 'cooldown'
    | 'ignored-backoff'
    | 'daily-cap'
    | 'no-candidate';
}

export function dedupeKey(triggerType: string, timezone: string, now: Date): string {
  return `${triggerType}:${hourSlot(now, timezone)}`;
}

/**
 * 硬规则 1–4（§6.8 步骤 1–4）。LLM 只能在这个闸门之后再表达意见，不能绕过。
 */
export function hardGate(user: ProactiveUser, state: StateSnapshot, now: Date): GateResult {
  if (!user.proactiveEnabled) return { allowed: false, reason: 'proactive-disabled' };

  if (isQuietHours(now, user.timezone, user.quietStart, user.quietEnd)) {
    return { allowed: false, reason: 'quiet-hours' };
  }

  if (state.cooldownUntil && state.cooldownUntil.getTime() > now.getTime()) {
    return { allowed: false, reason: 'cooldown' };
  }

  if (state.consecutiveIgnored >= 3) {
    return { allowed: false, reason: 'ignored-backoff' };
  }

  const today = localDate(now, user.timezone);
  const usedToday = state.dailyCountDate === today ? state.dailyProactiveCount : 0;
  if (usedToday >= user.dailyProactiveCap) {
    return { allowed: false, reason: 'daily-cap' };
  }

  return { allowed: true };
}

export async function getProactiveUser(pool: Pool, userId: number): Promise<ProactiveUser | null> {
  const { rows } = await pool.query<{
    id: string;
    timezone: string;
    quiet_start: string;
    quiet_end: string;
    proactive_enabled: boolean;
    daily_proactive_cap: number;
    subscription_quota: number;
  }>(
    `select id, timezone, quiet_start::text as quiet_start, quiet_end::text as quiet_end,
            proactive_enabled, daily_proactive_cap, subscription_quota
     from users where id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    timezone: r.timezone,
    quietStart: r.quiet_start,
    quietEnd: r.quiet_end,
    proactiveEnabled: r.proactive_enabled,
    dailyProactiveCap: r.daily_proactive_cap,
    subscriptionQuota: r.subscription_quota,
  };
}

export interface CreateProactiveInput {
  userId: number;
  triggerType: 'note_triggered' | 'idle_checkin' | 'milestone';
  reason: string;
  message: string;
  urgency: 'low' | 'medium' | 'high';
  key: string;
}

/**
 * 写库即去重：UNIQUE(user_id, dedupe_key) + ON CONFLICT DO NOTHING。
 * 心跳重试 10 次也只会有一条 queued 记录。
 */
export async function createProactive(
  pool: Pool,
  input: CreateProactiveInput,
): Promise<{ id: number } | null> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into proactive_log (user_id, trigger_type, reason, message, urgency, status, dedupe_key)
     values ($1, $2, $3, $4, $5, 'queued', $6)
     on conflict (user_id, dedupe_key) do nothing
     returning id`,
    [input.userId, input.triggerType, input.reason, input.message, input.urgency, input.key],
  );
  const row = rows[0];
  return row ? { id: Number(row.id) } : null;
}

export interface TriggerCandidate {
  triggerType: 'note_triggered' | 'idle_checkin' | 'milestone';
  hint: string;
}

/** 候选触发：24h 内有新笔记 / 距上次对话 > 48h / 有新的里程碑洞察 */
export async function findCandidates(
  pool: Pool,
  userId: number,
  now: Date = new Date(),
): Promise<TriggerCandidate[]> {
  const out: TriggerCandidate[] = [];

  const noteRes = await pool.query<{ title: string; content: string }>(
    `select title, content from notes
     where user_id = $1 and created_at > now() - interval '24 hours'
     order by created_at desc limit 3`,
    [userId],
  );
  if (noteRes.rows.length > 0) {
    out.push({
      triggerType: 'note_triggered',
      hint: `对方 24 小时内写了 ${noteRes.rows.length} 条笔记：${noteRes.rows
        .map((n) => n.title || n.content.slice(0, 40))
        .join(' / ')}`,
    });
  }

  const convRes = await pool.query<{ last: Date | null }>(
    `select max(created_at) as last from conversations where user_id = $1`,
    [userId],
  );
  const last = convRes.rows[0]?.last ?? null;
  const idleHours = last ? (now.getTime() - new Date(last).getTime()) / 3_600_000 : 999;
  if (idleHours > 48) {
    out.push({
      triggerType: 'idle_checkin',
      hint: last ? `已经 ${Math.round(idleHours)} 小时没聊天了` : '还没有聊过天',
    });
  }

  const milestone = await pool.query<{ content: string }>(
    `select content from user_insights
     where user_id = $1 and is_active = true and insight_type = 'milestone'
       and created_at > now() - interval '3 days'
     order by created_at desc limit 1`,
    [userId],
  );
  const m = milestone.rows[0];
  if (m) out.push({ triggerType: 'milestone', hint: `最近的里程碑：${m.content}` });

  return out;
}

/** 根据距离上次对话的时长，粗略维护 energy / mood（占位模型，可替换） */
export function deriveEnergy(lastUserMessageAt: Date | null, now: Date = new Date()): number {
  if (!lastUserMessageAt) return 0.4;
  const hours = (now.getTime() - new Date(lastUserMessageAt).getTime()) / 3_600_000;
  const energy = 1 - Math.min(1, hours / 96) * 0.6;
  return Math.min(1, Math.max(0.2, energy));
}

export function currentMinutes(now: Date, timezone: string): number {
  return zonedParts(now, timezone).minutes;
}
