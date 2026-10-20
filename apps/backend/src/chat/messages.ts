import type { Pool } from '../db/client.js';
import { estimateTokens } from '../lib/tokens.js';
import { resetOnUserMessage } from '../companion/state.js';

export interface SaveMessageInput {
  userId: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sessionId: string;
  model?: string;
  traceId?: string;
}

export async function saveMessage(pool: Pool, input: SaveMessageInput): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into conversations (user_id, role, content, session_id, token_count, model, trace_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      input.userId,
      input.role,
      input.content,
      input.sessionId,
      estimateTokens(input.content),
      input.model ?? null,
      input.traceId ?? null,
    ],
  );
  return Number(rows[0]?.id ?? 0);
}

/** 用户发消息时同步状态：清冷却、清未回应、更新 energy/时间戳 */
export async function onUserMessage(pool: Pool, userId: number): Promise<void> {
  await resetOnUserMessage(pool, userId);
  await pool.query(
    `update companion_state set energy = least(1, energy + 0.05) where user_id = $1`,
    [userId],
  );
}
