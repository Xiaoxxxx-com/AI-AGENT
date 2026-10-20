/** 用户本地时间相关的计算：免打扰时段、日期归属。容器 TZ 是 Asia/Shanghai，但用户时区可能不同。 */

export function zonedParts(now: Date, timeZone: string): { minutes: number; date: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const hour = Number(parts.hour === '24' ? '00' : parts.hour);
  const minute = Number(parts.minute);
  return {
    minutes: hour * 60 + minute,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** 'HH:MM[:SS]' → 当日分钟数 */
export function parseClock(value: string): number {
  const [h = '0', m = '0'] = value.split(':');
  return Number(h) * 60 + Number(m);
}

/** 支持跨午夜区间：23:00 → 08:00 */
export function isQuietHours(
  now: Date,
  timeZone: string,
  quietStart: string,
  quietEnd: string,
): boolean {
  const start = parseClock(quietStart);
  const end = parseClock(quietEnd);
  if (start === end) return false;
  const { minutes } = zonedParts(now, timeZone);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** 用于 dedupe_key 的时间片，例如 '2026-10-20T10' */
export function hourSlot(now: Date, timeZone: string): string {
  const { minutes, date } = zonedParts(now, timeZone);
  return `${date}T${String(Math.floor(minutes / 60)).padStart(2, '0')}`;
}

/** 用于 daily_count_date 的本地日期 */
export function localDate(now: Date, timeZone: string): string {
  return zonedParts(now, timeZone).date;
}

export function formatCst(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}
