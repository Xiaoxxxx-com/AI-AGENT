/**
 * 阶段 B 验收：洞察冲突下线（supersede）。
 *
 *   pnpm check:insights
 *
 * 场景：旧洞察「对方在为转岗焦虑」被新洞察「已经拿到 offer，不再焦虑」取代。
 * 断言：
 *   1. 旧洞察 is_active=false 且 superseded_by 指向新洞察；
 *   2. 第二次调用幂等（不会重复改）；
 *   3. 跨用户 id 无法被下线（越权保护）；
 *   4. 组装上下文用的 topInsights 查询不再返回被取代的洞察。
 * 脚本自带清理，跑完不留测试数据。
 */
import 'dotenv/config';
import { createPool } from '../apps/backend/src/db/client.js';
import { createEmbedderFromEnv, toSqlVector } from '../apps/backend/src/memory/embed.js';
import { applySupersede } from '../apps/backend/src/companion/reflection.js';
import { env } from '../apps/backend/src/config.js';

let failed = 0;
const ok = (name: string, detail = '') => console.log(`  ok    ${name}${detail ? ` · ${detail}` : ''}`);
const bad = (name: string, detail: string) => {
  failed += 1;
  console.error(`  FAIL  ${name} · ${detail}`);
};

const pool = createPool(env.DATABASE_URL, 4, 'check-insights');
const embedder = createEmbedderFromEnv(env);

async function insertInsight(userId: number, content: string, type: string, noteId: number) {
  const [vec] = await embedder.embed([content]);
  const { rows } = await pool.query<{ id: string }>(
    `insert into user_insights
       (user_id, insight_type, content, confidence, source_note_ids, evidence, embedding, last_validated_at)
     values ($1, $2, $3, 0.7, $4::bigint[], $5::jsonb, $6::vector, now())
     returning id`,
    [userId, type, content, [noteId], JSON.stringify([{ noteId, quote: '验收数据' }]), vec ? toSqlVector(vec) : null],
  );
  return Number(rows[0]?.id);
}

const created: number[] = [];

try {
  const userRes = await pool.query<{ id: string }>(
    `select id from users where wechat_openid = 'seed-openid-001'`,
  );
  const userId = Number(userRes.rows[0]?.id);
  if (!userId) throw new Error('找不到 seed 用户，先跑 pnpm db:seed');

  const noteRes = await pool.query<{ id: string }>(`select id from notes where user_id = $1 limit 1`, [userId]);
  const noteId = Number(noteRes.rows[0]?.id);

  const oldId = await insertInsight(userId, '对方最近一直在为转岗面试焦虑，睡眠也受影响', 'concern', noteId);
  created.push(oldId);
  const newId = await insertInsight(userId, '对方已经拿到内部转岗机会，焦虑明显缓解', 'milestone', noteId);
  created.push(newId);

  // 1. 下线
  const n1 = await applySupersede(pool, userId, newId, [oldId], `被 #${newId} 的更新理解取代`);
  const row = await pool.query<{ is_active: boolean; superseded_by: string | null; superseded_reason: string | null }>(
    `select is_active, superseded_by, superseded_reason from user_insights where id = $1`,
    [oldId],
  );
  const r = row.rows[0];
  n1 === 1 && r?.is_active === false && Number(r.superseded_by) === newId
    ? ok('旧洞察下线并溯源', `superseded_by=${r?.superseded_by}`)
    : bad('旧洞察下线并溯源', JSON.stringify(r));

  // 2. 幂等
  const n2 = await applySupersede(pool, userId, newId, [oldId], '重复调用');
  n2 === 0 ? ok('重复调用幂等', '第二次影响 0 行') : bad('重复调用幂等', `第二次影响 ${n2} 行`);

  // 3. 越权保护：新洞察属于别的用户时，不能把这条旧洞察下线
  const otherUser = await pool.query<{ id: string }>(
    `insert into users (wechat_openid) values ('check-insights-other')
     on conflict (wechat_openid) do update set updated_at = now() returning id`,
  );
  const otherId = Number(otherUser.rows[0]?.id);
  const stray = await insertInsight(userId, '一条不会被越权下线的洞察', 'pattern', noteId);
  created.push(stray);
  const n3 = await applySupersede(pool, otherId, newId, [stray], '越权尝试');
  n3 === 0 ? ok('跨用户不可下线', '影响 0 行') : bad('跨用户不可下线', `影响 ${n3} 行`);
  await pool.query(`delete from users where id = $1`, [otherId]);

  // 4. 组装上下文不再取到被取代的洞察
  const top = await pool.query<{ content: string }>(
    `select content from user_insights
     where user_id = $1 and is_active = true
     order by confidence desc, updated_at desc
     limit 5`,
    [userId],
  );
  const contents = top.rows.map((x) => x.content);
  !contents.some((c) => c.includes('一直在为转岗面试焦虑'))
    ? ok('组装层已过滤被取代洞察')
    : bad('组装层已过滤被取代洞察', contents.join(' | '));
  contents.some((c) => c.includes('已经拿到内部转岗机会'))
    ? ok('新洞察可见')
    : bad('新洞察可见', '未出现在 top insights');
} finally {
  if (created.length > 0) {
    await pool.query(`delete from user_insights where id = any($1::bigint[])`, [created]).catch(() => undefined);
  }
  await pool.end();
}

console.log(failed === 0 ? '\n洞察下线逻辑验证通过' : `\n${failed} 项断言失败`);
if (failed > 0) process.exit(1);
