import { describe, expect, it } from 'vitest';
import { backoffHours, dedupeKey, hardGate, type ProactiveUser } from '../apps/backend/src/companion/proactive';
import type { StateSnapshot } from '../apps/backend/src/companion/state';
import { hourSlot, isQuietHours, localDate } from '../apps/backend/src/lib/time';

const user: ProactiveUser = {
  id: 1,
  timezone: 'Asia/Shanghai',
  quietStart: '23:00',
  quietEnd: '08:00',
  proactiveEnabled: true,
  dailyProactiveCap: 3,
  subscriptionQuota: 1,
};

function state(over: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    userId: 1,
    currentMood: 'neutral',
    energy: 0.7,
    consecutiveIgnored: 0,
    cooldownUntil: null,
    lastUserMessageAt: null,
    lastProactiveAt: null,
    dailyProactiveCount: 0,
    dailyCountDate: '2026-10-20',
    version: 0,
    ...over,
  };
}

// 2026-10-20 14:30 Asia/Shanghai = 06:30Z
const DAYTIME = new Date('2026-10-20T06:30:00Z');
// 2026-10-20 23:30 Asia/Shanghai = 15:30Z
const NIGHT = new Date('2026-10-20T15:30:00Z');

describe('冷却退避', () => {
  it('按连续未回应次数递增', () => {
    expect(backoffHours(0)).toBe(0);
    expect(backoffHours(1)).toBe(6);
    expect(backoffHours(2)).toBe(24);
    expect(backoffHours(3)).toBe(72);
    expect(backoffHours(4)).toBe(168);
    expect(backoffHours(99)).toBe(168);
  });
});

describe('硬规则闸门', () => {
  it('正常状态放行', () => {
    expect(hardGate(user, state({ dailyCountDate: localDate(DAYTIME, user.timezone) }), DAYTIME)).toEqual({
      allowed: true,
    });
  });

  it('关闭主动关怀时不发', () => {
    expect(hardGate({ ...user, proactiveEnabled: false }, state(), DAYTIME).reason).toBe('proactive-disabled');
  });

  it('免打扰时段不发', () => {
    expect(hardGate(user, state(), NIGHT).reason).toBe('quiet-hours');
  });

  it('冷却期内不发', () => {
    const s = state({ cooldownUntil: new Date(DAYTIME.getTime() + 3600_000) });
    expect(hardGate(user, s, DAYTIME).reason).toBe('cooldown');
  });

  it('连续 3 次未回应后不发（不需要冷却也拦）', () => {
    expect(hardGate(user, state({ consecutiveIgnored: 3 }), DAYTIME).reason).toBe('ignored-backoff');
  });

  it('当日额度用尽不发', () => {
    const s = state({ dailyProactiveCount: 3, dailyCountDate: localDate(DAYTIME, user.timezone) });
    expect(hardGate(user, s, DAYTIME).reason).toBe('daily-cap');
  });

  it('跨天后额度重置', () => {
    const s = state({ dailyProactiveCount: 3, dailyCountDate: '2026-10-19' });
    expect(hardGate(user, s, DAYTIME).allowed).toBe(true);
  });
});

describe('时区与时间片', () => {
  it('免打扰支持跨午夜', () => {
    expect(isQuietHours(NIGHT, 'Asia/Shanghai', '23:00', '08:00')).toBe(true);
    expect(isQuietHours(DAYTIME, 'Asia/Shanghai', '23:00', '08:00')).toBe(false);
    // 07:30 本地时间仍在安静时段内
    expect(isQuietHours(new Date('2026-10-19T23:30:00Z'), 'Asia/Shanghai', '23:00', '08:00')).toBe(true);
  });

  it('dedupe_key 是 trigger + 小时片，同一小时只发一条', () => {
    const a = dedupeKey('idle_checkin', 'Asia/Shanghai', DAYTIME);
    const b = dedupeKey('idle_checkin', 'Asia/Shanghai', new Date('2026-10-20T06:59:00Z'));
    const c = dedupeKey('idle_checkin', 'Asia/Shanghai', new Date('2026-10-20T07:01:00Z'));
    expect(a).toBe('idle_checkin:2026-10-20T14');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('hourSlot / localDate 使用用户时区', () => {
    expect(hourSlot(DAYTIME, 'Asia/Shanghai')).toBe('2026-10-20T14');
    expect(localDate(DAYTIME, 'Asia/Shanghai')).toBe('2026-10-20');
    expect(localDate(DAYTIME, 'UTC')).toBe('2026-10-20');
  });
});
