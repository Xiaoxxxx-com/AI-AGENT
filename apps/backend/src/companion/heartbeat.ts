import type { FastifyBaseLogger } from 'fastify';
import type PgBoss from 'pg-boss';
import type { Pool } from '../db/client.js';
import type { ChatMessage } from '../chat/deepseek.js';
import { chatText, shouldReachOut } from '../chat/deepseek.js';
import { QUEUE } from '../queue.js';
import { localDate } from '../lib/time.js';
import {
  createProactive,
  dedupeKey,
  deriveEnergy,
  findCandidates,
  getProactiveUser,
  hardGate,
} from './proactive.js';
import { ensureState, getState, incrementDailyCount, updateEnergy } from './state.js';

export interface HeartbeatDeps {
  pool: Pool;
  boss: PgBoss;
  log: FastifyBaseLogger;
}

export interface HeartbeatResult {
  sent: boolean;
  reason?: string;
}

const DECISION_SYSTEM = `你在决定"此刻要不要主动联系对方"。

背景：你是长期陪伴者，不是推送机器人。对方没有在等你回话。

判断原则（按重要性排序）：
1. 有具体由头才联系：他刚写了新笔记、你们的对话停了很久、或有个明显的节点。没有由头就说不。
2. 宁可少打扰。多数时候正确答案是 false。
3. 如果是深夜、他最近情绪低落又没主动找过你，不要用"怎么还不睡"这类催促语气。
4. reason 写一句诚实的判断依据；suggested_angle 写最自然的切入角度（不要写成完整消息）。

只调用 should_reach_out 工具，不要输出其他内容。`;

const MESSAGE_SYSTEM = `你在写一条主动消息，对方此刻没有在等你说话。

要求：
1. 一到两句，40 字以内，像随口说的，不要开场白。
2. 必须有具体由头（提到那件事/那个东西），不要空泛的"最近怎么样"。
3. 不催促、不说教、不连环提问，最多一个轻问句。
4. 不要提"我注意到你的笔记""根据记录"这类暴露系统感的话。
5. 不要用 emoji 堆砌，最多一个。
直接输出消息正文，不要加引号。`;

/**
 * 单用户心跳。顺序是固定的：先硬规则 → 再 LLM → 回来再过一遍硬规则。
 * LLM 永远没有"绕过冷却"的权限。
 */
export async function handleHeartbeatUser(
  deps: HeartbeatDeps,
  userId: number,
  now: Date = new Date(),
): Promise<HeartbeatResult> {
  const { pool, boss, log } = deps;

  await ensureState(pool, userId);
  const [user, state] = await Promise.all([getProactiveUser(pool, userId), getState(pool, userId)]);
  if (!user || !state) return { sent: false, reason: 'user-missing' };

  const energy = deriveEnergy(state.lastUserMessageAt, now);

  // 步骤 1–4
  const gate = hardGate(user, state, now);
  if (!gate.allowed) {
    await updateEnergy(pool, userId, energy);
    return { sent: false, reason: gate.reason };
  }

  // 步骤 5
  const candidates = await findCandidates(pool, userId, now);
  if (candidates.length === 0) {
    await updateEnergy(pool, userId, energy);
    return { sent: false, reason: 'no-candidate' };
  }
  const primary = candidates[0];
  if (!primary) return { sent: false, reason: 'no-candidate' };

  // 步骤 7
  const decisionMessages: ChatMessage[] = [
    { role: 'system', content: DECISION_SYSTEM },
    {
      role: 'user',
      content: [
        `现在是对方本地时间 ${now.toLocaleString('zh-CN', { timeZone: user.timezone })}。`,
        `对方的 energy 估计 ${energy.toFixed(2)}，连续未回应 ${state.consecutiveIgnored} 次。`,
        `候选由头：\n${candidates.map((c) => `- [${c.triggerType}] ${c.hint}`).join('\n')}`,
      ].join('\n'),
    },
  ];

  let decision;
  try {
    decision = await shouldReachOut(decisionMessages);
  } catch (err) {
    log.warn({ err, userId }, '[heartbeat] 决策失败，本轮放弃');
    await updateEnergy(pool, userId, energy);
    return { sent: false, reason: 'llm-error' };
  }

  if (!decision.decision) {
    await updateEnergy(pool, userId, energy);
    return { sent: false, reason: `llm-declined:${decision.reason}` };
  }

  // 步骤 8：再过一遍硬规则（防止长时间 LLM 调用期间状态变化）
  const freshState = await getState(pool, userId);
  if (!freshState) return { sent: false, reason: 'state-missing' };
  const recheck = hardGate(user, freshState, new Date());
  if (!recheck.allowed) {
    await updateEnergy(pool, userId, energy);
    return { sent: false, reason: `recheck:${recheck.reason}` };
  }

  // 步骤 9
  const message = await chatText(
    [
      { role: 'system', content: MESSAGE_SYSTEM },
      {
        role: 'user',
        content: `由头和切入角度：${primary.hint}。建议角度：${decision.suggested_angle}。请写这条消息。`,
      },
    ],
    { maxTokens: 200, temperature: 0.85 },
  );
  if (!message) return { sent: false, reason: 'empty-message' };

  const key = dedupeKey(primary.triggerType, user.timezone, now);
  const created = await createProactive(pool, {
    userId,
    triggerType: primary.triggerType,
    reason: decision.reason,
    message,
    urgency: decision.urgency,
    key,
  });

  if (!created) {
    log.info({ userId, key }, '[heartbeat] 去重命中，跳过');
    return { sent: false, reason: 'duplicate' };
  }

  await incrementDailyCount(pool, userId, localDate(now, user.timezone));
  await updateEnergy(pool, userId, Math.min(1, energy + 0.15));
  await boss.send(QUEUE.proactiveDeliver, { proactiveId: created.id }, { singletonKey: `deliver:${created.id}` });

  log.info({ userId, proactiveId: created.id, trigger: primary.triggerType }, '[heartbeat] 已排队投递');
  return { sent: true };
}
