/**
 * 主动触达直推通道的连通性测试。
 *
 *   # 只测推送链路（不需要数据库）
 *   pnpm mock:llm                       # 提供 /push 回声端点
 *   pnpm push:test --kind=generic --url=http://127.0.0.1:4010/push
 *
 *   # 真实通道（把 URL 换掉即可）
 *   pnpm push:test --kind=bark       --url=https://api.day.app/你的KEY
 *   pnpm push:test --kind=serverchan --url=https://sctapi.ftqq.com/SCTxxxx.send
 *   pnpm push:test --kind=wecom      --url=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
 *   pnpm push:test --kind=telegram   --url=https://api.telegram.org/bot<token>/sendMessage --target=<chat_id>
 *
 *   # 端到端：写一条 proactive_log → deliverProactive → 断言 channel=push:*
 *   pnpm push:test --kind=generic --url=http://127.0.0.1:4010/push --e2e
 */
const args = process.argv.slice(2);
const pick = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const has = (name: string) => args.includes(`--${name}`);

if (pick('kind')) process.env.PUSH_KIND = pick('kind');
if (pick('url')) process.env.PUSH_URL = pick('url');
if (pick('target')) process.env.PUSH_TARGET = pick('target');

const { env } = await import('../apps/backend/src/config.js');
const { pushEnabled, pushMessage } = await import('../apps/backend/src/companion/push.js');

const TEXT = pick('text') ?? '如果你看到这条通知，说明她真的能找到你。';
const expectDegrade = has('expect-degrade');

let failed = 0;
const ok = (name: string, detail = '') => console.log(`  ok    ${name}${detail ? ` · ${detail}` : ''}`);
const bad = (name: string, detail: string) => {
  failed += 1;
  console.error(`  FAIL  ${name} · ${detail}`);
};

console.log(`channel=${env.PUSH_KIND} url=${env.PUSH_URL ? '已配置' : '未配置'} target=${env.PUSH_TARGET || '-'}\n`);

if (expectDegrade) {
  const res = await pushMessage({ title: '她给你留了一句话', body: TEXT });
  res.ok
    ? bad('推送失败被正确识别', '故意配错地址却成功了，检查是否走了别的分支')
    : ok('推送失败被正确识别', res.error ?? 'unknown');
} else {
  const res = await pushMessage({ title: '她给你留了一句话', body: TEXT });
  res.ok
    ? ok('推送请求成功', res.kind)
    : bad('推送请求成功', res.error ?? 'unknown');
}

if (has('e2e')) {
  const { createPool } = await import('../apps/backend/src/db/client.js');
  const { deliverProactive } = await import('../apps/backend/src/companion/delivery.js');
  const pool = createPool(env.DATABASE_URL, 2, 'test-push');
  const key = `push-test:${Date.now()}`;
  let id = 0;

  try {
    const userRes = await pool.query<{ id: string }>(
      `select id from users where wechat_openid = 'seed-openid-001'`,
    );
    const userId = Number(userRes.rows[0]?.id);
    if (!userId) throw new Error('找不到 seed 用户，先跑 pnpm db:seed');

    const ins = await pool.query<{ id: string }>(
      `insert into proactive_log (user_id, trigger_type, reason, message, urgency, status, dedupe_key)
       values ($1, 'idle_checkin', 'push 端到端验收', $2, 'low', 'queued', $3)
       returning id`,
      [userId, '（端到端测试）今天在楼下看到一只很像豆豆的猫。', key],
    );
    id = Number(ins.rows[0]?.id);

    await deliverProactive({ pool, log: console as never }, id);

    const after = await pool.query<{ status: string; channel: string | null }>(
      `select status, channel from proactive_log where id = $1`,
      [id],
    );
    const row = after.rows[0];
    if (has('expect-degrade')) {
      // 推送失败时应降级到站内待读，而不是丢掉这条消息
      row?.status === 'sent' && row.channel === 'in_app'
        ? ok('推送失败降级到站内', `channel=${row.channel}`)
        : bad('推送失败降级到站内', `status=${row?.status} channel=${row?.channel ?? 'null'}`);
    } else {
      row?.status === 'sent' && row.channel?.startsWith('push:')
        ? ok('端到端投递走直推通道', `channel=${row.channel}`)
        : bad('端到端投递走直推通道', `status=${row?.status} channel=${row?.channel ?? 'null'}`);
    }
  } catch (err) {
    bad('端到端投递走直推通道', err instanceof Error ? err.message : String(err));
  } finally {
    if (id) await pool.query(`delete from proactive_log where id = $1`, [id]).catch(() => undefined);
    await pool.end();
  }
}

console.log(failed === 0 ? '\n推送链路验证通过' : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
