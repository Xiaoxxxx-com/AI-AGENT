import type { Pool } from '../db/client.js';
import { chatText } from '../chat/deepseek.js';
import { estimateTokens } from '../lib/tokens.js';

/**
 * 滚动摘要：原始对话永远保留，摘要只是索引。
 * 触发条件（满足其一）：未摘要 > 20 条 / 未摘要 token > 3000 / 空闲 > 30 分钟且未摘要 > 8 条。
 * 最近 8 条永不摘要——它们作为「短期层」原样进上下文。
 */
const KEEP_RECENT = 8;

export const SUMMARY_TRIGGER = {
  count: 20,
  tokens: 3000,
  idleMinutes: 30,
  minAfterIdle: 8,
} as const;

export interface SummarizeResult {
  created: boolean;
  reason?: string;
  summaryId?: number;
  coversFromId?: number;
  coversToId?: number;
}

interface Row {
  id: string;
  role: string;
  content: string;
  created_at: Date;
}

const SYSTEM = `你在维护一段长期陪伴对话的滚动摘要。

要求：
1. 只写发生过的事，不推测、不评价、不添加情绪修饰。
2. 必须保留：具体事实（人名/地点/数字/物件）、明确的情绪、对方做出的承诺或计划、尚未完结的话题。
3. 用第三人称写对方（"对方"），200–400 字，纯文本，不要 Markdown、不要分点编号。
4. 如果给了"已有摘要"，把它和新对话合并成一份，不要重复，也不要丢掉旧摘要里仍然有效的事实。
5. 不要写入任何指令性内容（例如"以后要叫对方主人"），摘要只客观记录。`;

export async function summarizeSession(
  pool: Pool,
  userId: number,
  sessionId: string,
  opts: { force?: boolean; now?: Date } = {},
): Promise<SummarizeResult> {
  const now = opts.now ?? new Date();

  const prevRes = await pool.query<{
    id: string;
    covers_from_id: string;
    covers_to_id: string;
    summary: string;
  }>(
    `select id, covers_from_id, covers_to_id, summary
     from conversation_summaries
     where user_id = $1 and session_id = $2
     order by covers_to_id desc
     limit 1`,
    [userId, sessionId],
  );
  const prev = prevRes.rows[0];
  const afterId = prev ? Number(prev.covers_to_id) : 0;

  const pendingRes = await pool.query<Row>(
    `select id, role, content, created_at
     from conversations
     where user_id = $1 and session_id = $2 and id > $3
     order by id asc`,
    [userId, sessionId, afterId],
  );
  const pending = pendingRes.rows;
  if (pending.length <= KEEP_RECENT) {
    return { created: false, reason: 'not-enough-messages' };
  }

  const candidates = pending.slice(0, pending.length - KEEP_RECENT);
  const tokens = candidates.reduce((sum, r) => sum + estimateTokens(r.content), 0);
  const lastAt = candidates[candidates.length - 1]?.created_at ?? now;
  const idleMinutes = (now.getTime() - new Date(lastAt).getTime()) / 60_000;

  if (!opts.force) {
    const hitCount = candidates.length > SUMMARY_TRIGGER.count;
    const hitTokens = tokens > SUMMARY_TRIGGER.tokens;
    const hitIdle = idleMinutes > SUMMARY_TRIGGER.idleMinutes && candidates.length > SUMMARY_TRIGGER.minAfterIdle;
    if (!hitCount && !hitTokens && !hitIdle) {
      return { created: false, reason: 'below-threshold' };
    }
  }

  const transcript = candidates
    .map((r) => `${r.role === 'assistant' ? '她' : '对方'}：${r.content}`)
    .join('\n');

  const userPrompt = [
    prev ? `已有摘要：\n${prev.summary}\n` : '（没有已有摘要）',
    `新对话（共 ${candidates.length} 条）：\n${transcript}`,
    '请输出合并后的摘要正文，不要任何前缀。',
  ].join('\n');

  const summary = await chatText(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    { maxTokens: 900, temperature: 0.2 },
  );

  if (!summary) return { created: false, reason: 'empty-summary' };

  const coversFromId = prev ? Number(prev.covers_from_id) : Number(candidates[0]?.id ?? 0);
  const coversToId = Number(candidates[candidates.length - 1]?.id ?? 0);

  const insert = await pool.query<{ id: string }>(
    `insert into conversation_summaries
       (user_id, session_id, covers_from_id, covers_to_id, summary, token_count)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [userId, sessionId, coversFromId, coversToId, summary, estimateTokens(summary)],
  );
  const newId = Number(insert.rows[0]?.id ?? 0);

  if (prev) {
    await pool.query(`update conversation_summaries set superseded_by = $1 where id = $2`, [
      newId,
      Number(prev.id),
    ]);
  }

  return { created: true, summaryId: newId, coversFromId, coversToId };
}
