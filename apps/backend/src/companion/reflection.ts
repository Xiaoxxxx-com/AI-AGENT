import { z } from 'zod';
import type { Pool } from '../db/client.js';
import { chatJson } from '../chat/deepseek.js';
import { cosineSimilarity, toSqlVector, type Embedder } from '../memory/embed.js';

/**
 * 每日反思：把过去 7 天的笔记 + 对话压成几条可追溯的洞察。
 * 三条硬规则：
 * 1. noteIds 必须属于该用户且真实存在，否则整条丢弃（幻觉记忆的源头就在这里）；
 * 2. confidence 夹到 [0,1]；
 * 3. 内容去重（embedding 相似度 > 0.92 视为同一条）。
 */

const InsightItem = z.object({
  type: z.enum(['pattern', 'preference', 'concern', 'milestone']),
  content: z.string().min(2).max(200),
  confidence: z.number().default(0.5),
  noteIds: z.array(z.number().int()).default([]),
  quote: z.string().max(300).default(''),
  /** 这条新理解取代了哪些**已存在**的洞察 id（冲突下线） */
  supersedes: z.array(z.number().int()).default([]),
});

const ReflectionResult = z.object({
  insights: z.array(InsightItem).max(8).default([]),
});

const DEDUPE_THRESHOLD = 0.92;

const SYSTEM = `你在做一次克制的自我整理：把对方最近的记录与对话，归纳成几条真正有用的长期理解。

规则：
1. 只归纳有据可查的内容，不要脑补动机、不要心理学诊断。
2. 每条 20–60 字，写成陈述句，例如"最近在准备转岗面试，压力主要来自时间不够"。
3. type 只能是 pattern（反复出现的模式）/ preference（明确偏好）/ concern（持续的担忧）/ milestone（重要的节点或决定）。
4. noteIds 只能从给定笔记里选，至少一条；找不到依据就不要输出这条。
5. confidence 0–1：多条证据互相印证才给 0.8 以上。
6. 最多 5 条。宁可少，不要凑数。
7. 如果给了"已有洞察"，只有当新证据**推翻或明显改写**了某条旧洞察时，才在 supersedes 里填它的 id。
   仅仅是补充细节、或只是措辞不同，不要填 supersedes。
8. 输出 JSON：
{"insights":[{"type":"pattern","content":"...","confidence":0.8,"noteIds":[12],"quote":"原文片段","supersedes":[]}]}`;

export interface ReflectResult {
  created: number;
  skipped: number;
  superseded: number;
  reason?: string;
}

/**
 * 冲突下线：新洞察生效，旧洞察 is_active=false 并留下溯源。
 * 单独抽出来，便于脚本与集成测试直接验证（不依赖 LLM）。
 */
export async function applySupersede(
  pool: Pool,
  userId: number,
  newInsightId: number,
  supersededIds: number[],
  reason: string,
): Promise<number> {
  if (supersededIds.length === 0) return 0;
  const { rowCount } = await pool.query(
    `update user_insights
     set is_active = false,
         superseded_by = $3,
         superseded_reason = $4,
         updated_at = now()
     where user_id = $1
       and id = any($2::bigint[])
       and is_active = true
       and id <> $3`,
    [userId, supersededIds, newInsightId, reason],
  );
  return rowCount ?? 0;
}

function parseVector(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value !== 'string') return null;
  const inner = value.replace(/^\[|\]$/g, '');
  if (!inner) return null;
  return inner.split(',').map(Number);
}

export async function reflectUser(
  pool: Pool,
  embedder: Embedder | null,
  userId: number,
): Promise<ReflectResult> {
  const notesRes = await pool.query<{ id: string; title: string; content: string }>(
    `select id, title, content from notes
     where user_id = $1 and created_at > now() - interval '7 days'
     order by created_at desc
     limit 50`,
    [userId],
  );
  if (notesRes.rows.length === 0) return { created: 0, skipped: 0, superseded: 0, reason: 'no-notes' };

  const convRes = await pool.query<{ role: string; content: string }>(
    `select role, content from conversations
     where user_id = $1 order by id desc limit 20`,
    [userId],
  );
  const summaryRes = await pool.query<{ summary: string }>(
    `select summary from conversation_summaries
     where user_id = $1 and superseded_by is null
     order by covers_to_id desc limit 1`,
    [userId],
  );

  const validNoteIds = new Set(notesRes.rows.map((r) => Number(r.id)));
  const notesBlock = notesRes.rows
    .map((r) => `#${r.id} [${r.title || '无标题'}] ${r.content.slice(0, 300)}`)
    .join('\n');
  const convBlock = convRes.rows
    .reverse()
    .map((r) => `${r.role === 'assistant' ? '她' : '对方'}：${r.content.slice(0, 200)}`)
    .join('\n');

  // 已有洞察要在调用前取出：既用于提示词里让模型判断冲突，也用于去重
  const existing = await pool.query<{ id: string; content: string; embedding: unknown }>(
    `select id, content, embedding from user_insights
     where user_id = $1 and is_active = true and superseded_by is null`,
    [userId],
  );
  const activeIds = new Set(existing.rows.map((r) => Number(r.id)));
  const existingBlock =
    existing.rows.length > 0
      ? existing.rows.map((r) => `#${r.id} ${r.content}`).join('\n')
      : '（暂无）';

  const result = await chatJson(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          summaryRes.rows[0] ? `已有对话摘要：${summaryRes.rows[0].summary}` : '',
          `最近的笔记（仅这些 id 可用）：\n${notesBlock}`,
          convBlock ? `最近的对话：\n${convBlock}` : '',
          `已有洞察（supersedes 只能用这些 id）：\n${existingBlock}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    ReflectionResult,
    { maxTokens: 1200, temperature: 0.3 },
  );

  const existingTexts = new Set(existing.rows.map((r) => r.content.trim()));
  const existingVecs = existing.rows
    .map((r) => parseVector(r.embedding))
    .filter((v): v is number[] => Array.isArray(v));

  const candidates = result.insights
    .map((item) => ({
      ...item,
      confidence: Math.min(1, Math.max(0, item.confidence)),
      noteIds: item.noteIds.filter((id) => validNoteIds.has(id)),
      // 只允许引用该用户真实存在、且仍然有效的旧洞察
      supersedes: item.supersedes.filter((id) => activeIds.has(id)),
    }))
    .filter((item) => item.noteIds.length > 0 && !existingTexts.has(item.content.trim()));

  if (candidates.length === 0) {
    return { created: 0, skipped: result.insights.length, superseded: 0, reason: 'no-valid' };
  }

  let vectors: (number[] | null)[] = candidates.map(() => null);
  if (embedder) {
    try {
      vectors = await embedder.embed(candidates.map((c) => c.content));
    } catch {
      vectors = candidates.map(() => null);
    }
  }

  let created = 0;
  let skipped = 0;
  let superseded = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const item = candidates[i];
    if (!item) continue;
    const vec = vectors[i] ?? null;

    const duplicated =
      vec !== null && existingVecs.some((old) => cosineSimilarity(vec, old) > DEDUPE_THRESHOLD);
    if (duplicated) {
      skipped += 1;
      continue;
    }

    const evidence = item.noteIds.map((noteId) => ({ noteId, quote: item.quote }));

    const inserted = await pool.query<{ id: string }>(
      `insert into user_insights
         (user_id, insight_type, content, confidence, source_note_ids, evidence, embedding, last_validated_at)
       values ($1, $2, $3, $4, $5::bigint[], $6::jsonb, $7::vector, now())
       returning id`,
      [
        userId,
        item.type,
        item.content,
        item.confidence,
        item.noteIds,
        JSON.stringify(evidence),
        vec ? toSqlVector(vec) : null,
      ],
    );
    const newId = Number(inserted.rows[0]?.id ?? 0);
    created += 1;

    if (newId && item.supersedes.length > 0) {
      superseded += await applySupersede(
        pool,
        userId,
        newId,
        item.supersedes,
        `被 #${newId} 的更新理解取代`,
      );
      // 旧洞察下线后不再参与后续去重比对
      for (const id of item.supersedes) activeIds.delete(id);
    }

    if (vec) existingVecs.push(vec);
    existingTexts.add(item.content.trim());
  }

  return { created, skipped, superseded };
}
