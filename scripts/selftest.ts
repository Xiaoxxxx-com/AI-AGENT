import assert from 'node:assert/strict';
import { estimateTokens, truncateToTokens } from '../apps/backend/src/lib/tokens';
import { segment, tokenize, toTsQuery } from '../apps/backend/src/memory/segment';
import { backoffHours, dedupeKey, hardGate } from '../apps/backend/src/companion/proactive';
import { isQuietHours, localDate } from '../apps/backend/src/lib/time';
import { detectCrisis } from '../apps/backend/src/chat/safety';

let pass = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
};

console.log('tokens');
check('中文按字计', () => assert.equal(estimateTokens('你好世界'), 4));
check('空串为 0', () => assert.equal(estimateTokens(''), 0));
check('截断不超预算', () => {
  const out = truncateToTokens('一二三四五六七八九十'.repeat(10), 20);
  assert.ok(estimateTokens(out) <= 20);
  assert.ok(out.length < 100);
});

console.log('segment');
check('切出多字词', () => {
  const t = tokenize('最近工作压力很大，天天加班到十点');
  assert.ok(t.includes('工作'));
  assert.ok(t.includes('压力'));
  assert.ok(t.includes('加班'));
});
check('过滤停用词与标点', () => {
  const t = tokenize('我今天真的很累，');
  assert.ok(!t.includes('我') && !t.includes('的') && !t.includes('，'));
  assert.ok(t.includes('累'));
});
check('toTsQuery 用 OR', () => {
  const q = toTsQuery('最近工作压力大');
  assert.ok(q.includes(' | '));
  assert.ok(!q.includes('&'));
});
check('全停用词给占位词', () => assert.equal(toTsQuery('的了是'), 'zzzznomatch'));

console.log('proactive gate');
const user = {
  id: 1,
  timezone: 'Asia/Shanghai',
  quietStart: '23:00',
  quietEnd: '08:00',
  proactiveEnabled: true,
  dailyProactiveCap: 3,
  subscriptionQuota: 1,
};
const daytime = new Date('2026-10-20T06:30:00Z');
const night = new Date('2026-10-20T15:30:00Z');
const baseState = {
  userId: 1,
  currentMood: 'neutral',
  energy: 0.7,
  consecutiveIgnored: 0,
  cooldownUntil: null,
  lastUserMessageAt: null,
  lastProactiveAt: null,
  dailyProactiveCount: 0,
  dailyCountDate: localDate(daytime, user.timezone),
  version: 0,
};

check('正常放行', () => assert.deepEqual(hardGate(user, baseState, daytime), { allowed: true }));
check('关闭开关不发', () =>
  assert.equal(hardGate({ ...user, proactiveEnabled: false }, baseState, daytime).reason, 'proactive-disabled'));
check('免打扰不发', () => assert.equal(hardGate(user, baseState, night).reason, 'quiet-hours'));
check('冷却期不发', () =>
  assert.equal(
    hardGate(user, { ...baseState, cooldownUntil: new Date(daytime.getTime() + 3600_000) }, daytime).reason,
    'cooldown',
  ));
check('3 次未回不发', () =>
  assert.equal(hardGate(user, { ...baseState, consecutiveIgnored: 3 }, daytime).reason, 'ignored-backoff'));
check('额度用尽不发', () =>
  assert.equal(hardGate(user, { ...baseState, dailyProactiveCount: 3 }, daytime).reason, 'daily-cap'));
check('跨天额度重置', () =>
  assert.equal(hardGate(user, { ...baseState, dailyProactiveCount: 3, dailyCountDate: '2026-10-19' }, daytime).allowed, true));

check('退避表', () => {
  assert.equal(backoffHours(0), 0);
  assert.equal(backoffHours(1), 6);
  assert.equal(backoffHours(2), 24);
  assert.equal(backoffHours(3), 72);
  assert.equal(backoffHours(4), 168);
});
check('dedupe 同小时相同', () => {
  const a = dedupeKey('idle_checkin', 'Asia/Shanghai', daytime);
  assert.equal(a, 'idle_checkin:2026-10-20T14');
  assert.equal(a, dedupeKey('idle_checkin', 'Asia/Shanghai', new Date('2026-10-20T06:59:00Z')));
});
check('跨午夜安静时段', () => {
  assert.equal(isQuietHours(night, 'Asia/Shanghai', '23:00', '08:00'), true);
  assert.equal(isQuietHours(daytime, 'Asia/Shanghai', '23:00', '08:00'), false);
});

console.log('crisis');
check('直接意图命中', () => {
  assert.equal(detectCrisis('我想自杀').level, 'crisis');
  assert.equal(detectCrisis('真的不想活了').level, 'crisis');
});
check('自伤方式命中', () => {
  assert.equal(detectCrisis('昨晚又割腕了').level, 'crisis');
  assert.equal(detectCrisis('想跳楼').level, 'crisis');
});
check('日常夸张不误判', () => {
  for (const t of ['累死了', '笑死我了', '困死了', '今天气死了']) {
    assert.equal(detectCrisis(t).level, 'none', t);
  }
});
check('普通低落不误判', () => {
  assert.equal(detectCrisis('最近有点撑不住，压力很大').level, 'none');
});

console.log(`\n${pass} 项通过${process.exitCode ? '，存在失败' : ''}`);
