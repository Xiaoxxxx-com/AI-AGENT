/**
 * 阶段 C 验收之三：连续未回应 → 退避冷却。
 *
 *   pnpm check:cooldown
 *
 * 流程（全部用临时用户隔离，跑完删除）：
 *   1. 造 3 条 7 小时前、status='sent'、未回应的主动消息；
 *   2. markStaleProactive() 把它们标成 user_replied=false，并累加 consecutive_ignored；
 *   3. backoffHours(3) 应为 72，setCooldown 后 cooldown_until ≈ now + 72h；
 *   4. hardGate 在冷却期内必须拒绝（reason=cooldown 或 ignored-backoff）。
 */
import 'dotenv/config';
import { createPool } from '../apps/backend/src/db/client.js';
import { markStaleProactive, setCooldown, ensureState, getState } from '../apps/backend/src/companion/state.js';
import { backoffHours, hardGate, getProactiveUser } from '../apps/backend/src/companion/proactive.js';
import { env } from '../apps/backend/src/config.js';

let failed = 0;
const ok = (name: string, detail = '') => console.log(`  ok    ${name}${detail ? ` · ${detail}` : ''}`);
const bad = (name: string, detail: string) => {
  failed += 1;
  console.error(`  FAIL  ${name} · ${detail}`);
};

const pool = createPool(env.DATABASE_URL, 2, 'check-cooldown');
const OPENID = 'check-cooldown-user';

try {
  const userRes = await pool.query<{ id: string }>(
    `insert into users (wechat_openid, quiet_start, quiet_end)
     values ($1, '23:00', '08:00')
     on conflict (wechat_openid) do update set updated_at = now()
     returning id`,
    [OPENID],
  );
  const userId = Number(userRes.rows[0]?.id);
  if (!userId) throw new Error('临时用户创建失败');
  await ensureState(pool, userId);

  // 1. 三条已发送但未回应的历史消息
  for (let i = 0; i < 3; i += 1) {
    await pool.query(
      `insert into proactive_log (user_id, trigger_type, reason, message, urgency, status, dedupe_key, created_at)
       values ($1, 'idle_checkin', 'cold-start 验收', '冷却用例消息', 'low', 'sent', $2, now() - interval '7 hours')`,
      [userId, `cooldown:${Date.now()}:${i}`],
    );
  }

  // 2. 扫描任务：标记未回应 + 累加计数
  await markStaleProactive(pool);
  const afterSweep = await getState(pool, userId);
  afterSweep?.consecutiveIgnored === 3
    ? ok('未回应计数累加', `consecutive_ignored=${afterSweep.consecutiveIgnored}`)
    : bad('未回应计数累加', `期望 3，实际 ${afterSweep?.consecutiveIgnored}`);

  // 3. 退避表 + 冷却
  const hours = backoffHours(afterSweep?.consecutiveIgnored ?? 0);
  hours === 72 ? ok('退避表 3 次 → 72h') : bad('退避表 3 次 → 72h', `实际 ${hours}h`);

  await setCooldown(pool, userId, hours);
  const cooled = await getState(pool, userId);
  const cooldownHours =
    cooled?.cooldownUntil ? (cooled.cooldownUntil.getTime() - Date.now()) / 3_600_000 : 0;
  Math.abs(cooldownHours - 72) < 0.1
    ? ok('冷却时间写入', `${cooldownHours.toFixed(1)}h`)
    : bad('冷却时间写入', `期望 ≈72h，实际 ${cooldownHours.toFixed(1)}h`);

  // 4. 闸门必须拒绝
  const user = await getProactiveUser(pool, userId);
  const gate = user && cooled ? hardGate(user, cooled, new Date()) : { allowed: true, reason: 'missing' };
  gate.allowed === false
    ? ok('冷却期内不发', `reason=${gate.reason}`)
    : bad('冷却期内不发', '闸门仍然放行');

  // 5. 用户回一条消息后必须清冷却
  await pool.query(
    `update companion_state set consecutive_ignored = 0, cooldown_until = null where user_id = $1`,
    [userId],
  );
  const reset = await getState(pool, userId);
  const gateAfter = user && reset ? hardGate(user, reset, new Date()) : { allowed: false };
  gateAfter.allowed === true
    ? ok('用户回话后解除冷却')
    : bad('用户回话后解除冷却', `reason=${(gateAfter as { reason?: string }).reason}`);
} finally {
  await pool.query(`delete from users where wechat_openid = $1`, [OPENID]).catch(() => undefined);
  await pool.end();
}

console.log(failed === 0 ? '\n冷却退避验证通过' : `\n${failed} 项断言失败`);
if (failed > 0) process.exit(1);
