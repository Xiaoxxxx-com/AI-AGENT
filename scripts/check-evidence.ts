/**
 * 阶段 B 验收：洞察证据链 + 摘要连续性 + 机械引用审计。
 *
 *   pnpm check:evidence
 *
 * 断言：
 *   1. 每条有效洞察的 source_note_ids 非空，且都能在本用户的 notes 里查到；
 *   2. evidence 里的 noteId 必须落在 source_note_ids 内（可回溯原文）；
 *   3. superseded_by 必须指向同一用户的真实洞察，且链不闭环；
 *   4. 每个会话的摘要区间递增、不重叠，且只有一条未被取代的头部；
 *   5. 助手回复里不出现「根据你的笔记第 N 条」这类机械引用。
 *
 * 脚本会先造 3 条合规洞察做正向验证，再造 1 条违规洞察确认审计能抓到，最后全部清理。
 */
import 'dotenv/config';
import { createPool } from '../apps/backend/src/db/client.js';
import { env } from '../apps/backend/src/config.js';

let failed = 0;
const ok = (name: string, detail = '') => console.log(`  ok    ${name}${detail ? ` · ${detail}` : ''}`);
const bad = (name: string, detail: string) => {
  failed += 1;
  console.error(`  FAIL  ${name} · ${detail}`);
};

const MECHANICAL_CITATION = [
  /根据你的笔记第\s*\d+\s*条/,
  /你的笔记第\s*\d+/,
  /根据(我的)?记录(显示)?/,
  /根据你的第\s*\d+\s*条/,
  /你在\s*\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.{0,6}记/,
];

interface Violation {
  kind: string;
  detail: string;
}

const pool = createPool(env.DATABASE_URL, 2, 'check-evidence');
const created: number[] = [];

async function auditInsights(userId: number): Promise<Violation[]> {
  const out: Violation[] = [];
  const { rows } = await pool.query<{
    id: string;
    content: string;
    source_note_ids: string[] | null;
    evidence: unknown;
    superseded_by: string | null;
    is_active: boolean;
  }>(
    `select id, content, source_note_ids, evidence, superseded_by, is_active
     from user_insights where user_id = $1 order by id`,
    [userId],
  );

  const ownNotes = await pool.query<{ id: string }>(`select id from notes where user_id = $1`, [userId]);
  const ownNoteIds = new Set(ownNotes.rows.map((r) => Number(r.id)));
  const insightIds = new Set(rows.map((r) => Number(r.id)));

  for (const row of rows) {
    const id = Number(row.id);
    const sourceIds = (row.source_note_ids ?? []).map(Number);

    if (row.is_active && sourceIds.length === 0) {
      out.push({ kind: 'missing-source', detail: `#${id} 有效洞察没有 source_note_ids` });
    }
    const stray = sourceIds.filter((n) => !ownNoteIds.has(n));
    if (stray.length > 0) {
      out.push({ kind: 'foreign-note', detail: `#${id} 引用了不属于该用户的笔记 ${stray.join(',')}` });
    }

    const evidence = Array.isArray(row.evidence) ? (row.evidence as { noteId?: number }[]) : [];
    const outside = evidence
      .map((e) => Number(e?.noteId))
      .filter((n) => Number.isFinite(n) && !sourceIds.includes(n));
    if (outside.length > 0) {
      out.push({ kind: 'evidence-mismatch', detail: `#${id} evidence 的 noteId ${outside.join(',')} 不在 source 里` });
    }

    if (row.superseded_by !== null) {
      const target = Number(row.superseded_by);
      if (!insightIds.has(target)) {
        out.push({ kind: 'dangling-supersede', detail: `#${id} superseded_by=${target} 不存在` });
      }
      if (target === id) {
        out.push({ kind: 'self-supersede', detail: `#${id} superseded_by 指向自己` });
      }
    }
  }

  // 链不闭环：沿 superseded_by 走，最多 20 步
  for (const row of rows) {
    let cursor: number | null = row.superseded_by ? Number(row.superseded_by) : null;
    let steps = 0;
    while (cursor !== null && steps < 20) {
      const next = rows.find((r) => Number(r.id) === cursor);
      cursor = next?.superseded_by ? Number(next.superseded_by) : null;
      steps += 1;
      if (steps === 20) out.push({ kind: 'supersede-cycle', detail: `#${Number(row.id)} 的取代链超过 20 步` });
    }
  }

  return out;
}

async function auditSummaries(userId: number): Promise<Violation[]> {
  const out: Violation[] = [];
  const { rows } = await pool.query<{
    session_id: string;
    id: string;
    covers_from_id: string;
    covers_to_id: string;
    superseded_by: string | null;
  }>(
    `select session_id, id, covers_from_id, covers_to_id, superseded_by
     from conversation_summaries where user_id = $1
     order by session_id, covers_to_id`,
    [userId],
  );

  const bySession = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = bySession.get(row.session_id) ?? [];
    list.push(row);
    bySession.set(row.session_id, list);
  }

  for (const [session, list] of bySession) {
    const heads = list.filter((r) => r.superseded_by === null);
    if (heads.length !== 1) {
      out.push({ kind: 'summary-head', detail: `${session.slice(0, 8)} 有 ${heads.length} 条未取代摘要` });
    }
    let prevTo = -1;
    for (const r of list) {
      const from = Number(r.covers_from_id);
      const to = Number(r.covers_to_id);
      if (from > to) out.push({ kind: 'summary-range', detail: `${session.slice(0, 8)} #${r.id} from>to` });
      if (to <= prevTo) {
        out.push({ kind: 'summary-overlap', detail: `${session.slice(0, 8)} #${r.id} 区间未递增` });
      }
      prevTo = Math.max(prevTo, to);
    }
  }

  return out;
}

async function auditCitations(userId: number): Promise<Violation[]> {
  const { rows } = await pool.query<{ content: string }>(
    `select content from conversations where user_id = $1 and role = 'assistant'
     order by id desc limit 200`,
    [userId],
  );
  const out: Violation[] = [];
  for (const row of rows) {
    for (const pattern of MECHANICAL_CITATION) {
      if (pattern.test(row.content)) {
        out.push({ kind: 'mechanical-citation', detail: row.content.slice(0, 40) });
        break;
      }
    }
  }
  return out;
}

try {
  const userRes = await pool.query<{ id: string }>(
    `select id from users where wechat_openid = 'seed-openid-001'`,
  );
  const userId = Number(userRes.rows[0]?.id);
  if (!userId) throw new Error('找不到 seed 用户，先跑 pnpm db:seed');

  const noteRes = await pool.query<{ id: string }>(`select id from notes where user_id = $1 limit 2`, [userId]);
  const noteIds = noteRes.rows.map((r) => Number(r.id));
  if (noteIds.length === 0) throw new Error('该用户没有笔记，无法验证证据链');

  // 正向：3 条合规洞察
  for (const [i, text] of ['最近工作强度明显偏高', '对养猫这件事持续有兴趣', '和母亲的联系频率在下降'].entries()) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into user_insights (user_id, insight_type, content, confidence, source_note_ids, evidence, last_validated_at)
       values ($1, 'pattern', $2, 0.7, $3::bigint[], $4::jsonb, now()) returning id`,
      [userId, text, noteIds.slice(0, 1), JSON.stringify(noteIds.slice(0, 1).map((n) => ({ noteId: n, quote: '验收' })))],
    );
    created.push(Number(rows[0]?.id));
    void i;
  }

  const cleanInsights = await auditInsights(userId);
  cleanInsights.length === 0
    ? ok('合规洞察通过审计', `3 条，noteIds=${noteIds.slice(0, 1).join(',')}`)
    : bad('合规洞察通过审计', JSON.stringify(cleanInsights));

  // 反向：造一条引用不存在笔记的洞察，审计必须抓到
  const badRow = await pool.query<{ id: string }>(
    `insert into user_insights (user_id, insight_type, content, confidence, source_note_ids, evidence)
     values ($1, 'pattern', '这条洞察引用了不存在的笔记', 0.5, '{999999}'::bigint[], '[]'::jsonb) returning id`,
    [userId],
  );
  created.push(Number(badRow.rows[0]?.id));
  const withBad = await auditInsights(userId);
  withBad.some((v) => v.kind === 'foreign-note' || v.kind === 'missing-source')
    ? ok('审计能抓到脏数据', withBad[0]?.detail ?? '')
    : bad('审计能抓到脏数据', '没有发现引用不存在的笔记');

  // 摘要与引用
  const summaryViolations = await auditSummaries(userId);
  summaryViolations.length === 0
    ? ok('摘要区间连续且只有一个头部')
    : bad('摘要区间连续且只有一个头部', JSON.stringify(summaryViolations.slice(0, 2)));

  const citationViolations = await auditCitations(userId);
  citationViolations.length === 0
    ? ok('无机械引用')
    : bad('无机械引用', citationViolations.slice(0, 2).map((v) => v.detail).join(' | '));
} finally {
  if (created.length > 0) {
    await pool.query(`delete from user_insights where id = any($1::bigint[])`, [created]).catch(() => undefined);
  }
  await pool.end();
}

console.log(failed === 0 ? '\n证据链审计通过' : `\n${failed} 项断言失败`);
if (failed > 0) process.exit(1);
