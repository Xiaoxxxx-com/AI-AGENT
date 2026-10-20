/**
 * 阶段 C 验收之一：同一 dedupe_key 重试 10 次只发 1 条。
 *
 *   pnpm check:dedupe
 *
 * 打的是真库上的唯一约束 + ON CONFLICT DO NOTHING，
 * 不是内存里的 Set —— 心跳重试、多 worker 并发都靠这条兜住。
 */
import 'dotenv/config';
import { createPool } from '../apps/backend/src/db/client.js';
import { createProactive } from '../apps/backend/src/companion/proactive.js';
import { ensureState } from '../apps/backend/src/companion/state.js';
import { env } from '../apps/backend/src/config.js';

let failed = 0;
const ok = (name: string, detail = '') => console.log(`  ok    ${name}${detail ? ` · ${detail}` : ''}`);
const bad = (name: string, detail: string) => {
  failed += 1;
  console.error(`  FAIL  ${name} · ${detail}`);
};

const pool = createPool(env.DATABASE_URL, 6, 'check-dedupe');
const key = `acceptance:${Date.now()}`;

try {
  const userRes = await pool.query<{ id: string }>(
    `select id from users where wechat_openid = 'seed-openid-001'`,
  );
  const userId = Number(userRes.rows[0]?.id);
  if (!userId) throw new Error('找不到 seed 用户，先跑 pnpm db:seed');
  await ensureState(pool, userId);

  // 1. 10 次并发写同一条（模拟心跳重试 + 多 worker）
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      createProactive(pool, {
        userId,
        triggerType: 'idle_checkin',
        reason: `并发验收 #${i}`,
        message: '这是一条只应该出现一次的主动消息',
        urgency: 'low',
        key,
      }),
    ),
  );
  const winners = results.filter((r) => r !== null);
  const rows = await pool.query<{ n: number }>(
    `select count(*)::int as n from proactive_log where user_id = $1 and dedupe_key = $2`,
    [userId, key],
  );
  const count = rows.rows[0]?.n ?? 0;

  winners.length === 1 && count === 1
    ? ok('10 次并发只落 1 条', `成功返回 ${winners.length} 次，库中 ${count} 行`)
    : bad('10 次并发只落 1 条', `成功返回 ${winners.length} 次，库中 ${count} 行`);

  // 2. 再来 10 次（模拟后续重试）仍然不新增
  const again = await Promise.all(
    Array.from({ length: 10 }, () =>
      createProactive(pool, {
        userId,
        triggerType: 'idle_checkin',
        reason: '重试',
        message: '重试不应产生新消息',
        urgency: 'low',
        key,
      }),
    ),
  );
  const rows2 = await pool.query<{ n: number }>(
    `select count(*)::int as n from proactive_log where user_id = $1 and dedupe_key = $2`,
    [userId, key],
  );
  again.every((r) => r === null) && rows2.rows[0]?.n === 1
    ? ok('再次重试仍只有 1 条', `返回全为 null，库中 ${rows2.rows[0]?.n} 行`)
    : bad('再次重试仍只有 1 条', `返回 ${again.filter(Boolean).length} 条新记录`);

  // 3. 换 key 能正常写入（确认不是被整体卡死）
  const fresh = await createProactive(pool, {
    userId,
    triggerType: 'note_triggered',
    reason: '不同 key',
    message: '不同 dedupe_key 应该能正常写入',
    urgency: 'low',
    key: `${key}:2`,
  });
  fresh ? ok('不同 dedupe_key 正常写入') : bad('不同 dedupe_key 正常写入', '返回 null');
} finally {
  await pool.query(`delete from proactive_log where dedupe_key like $1`, [`${key}%`]).catch(() => undefined);
  await pool.end();
}

console.log(failed === 0 ? '\ndedupe 验证通过' : `\n${failed} 项断言失败`);
if (failed > 0) process.exit(1);
