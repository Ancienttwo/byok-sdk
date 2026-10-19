import { describe, expect, it } from 'vitest';
import {
  ROUTINE_DAYS_OF_WEEK, ROUTINE_HORIZON_MS, ROUTINE_MIN_NOW, ROUTINE_MAX_NOW,
  checkRoutineSchedule, nextRoutineOccurrence, type RoutineDayOfWeek, type RoutineSchedule,
} from '../routine-schedule';
import { directed, fieldCases, tzCases } from './fixtures/routine-cases';

const NY = 'America/New_York';
const at = Date.parse;
const iso = (t: number | null) => t === null ? 'null' : new Date(t).toISOString();
const show = JSON.stringify;
const report = (ok: boolean, message: string) => expect(ok, message).toBe(true);

describe('routine schedule contract', () => {
  it.each(directed)('%s', (_name, schedule, now, expected) => {
    expect(iso(nextRoutineOccurrence(schedule, at(now)))).toBe(expected);
  });
  it.each(fieldCases)('validates %s', (_name, value, expected) => {
    const schedule = value as RoutineSchedule;
    const check = checkRoutineSchedule(schedule);
    expect(check.ok ? 'ok' : check.code).toBe(expected);
    if (!check.ok) expect(() => nextRoutineOccurrence(schedule, ROUTINE_MIN_NOW))
      .toThrow(expect.objectContaining({ code: 'routine_schedule_invalid' }));
  });
  it.each(tzCases)('checks zone %s', (tz, expected) => {
    const check = checkRoutineSchedule({ minute: 0, hour: 9, tz });
    expect(check.ok ? 'ok' : check.code).toBe(expected);
  });
  it('checks the explicit now domain and the exact horizon constant', () => {
    const schedule = { minute: 0, hour: 9, tz: 'UTC' };
    expect(ROUTINE_HORIZON_MS).toBe(368 * 86_400_000);
    for (const now of [NaN, Infinity, 1.5, ROUTINE_MIN_NOW - 1, ROUTINE_MAX_NOW, Number.MAX_SAFE_INTEGER]) {
      expect(() => nextRoutineOccurrence(schedule, now)).toThrow(RangeError);
    }
    for (const now of [ROUTINE_MIN_NOW, ROUTINE_MAX_NOW - 1]) {
      expect(nextRoutineOccurrence(schedule, now)).toBeGreaterThan(now);
    }
  });
  it.each([null, [], {}, { minute: 0, hour: 9, tz: null }])('refuses malformed input %j', value => {
    expect(checkRoutineSchedule(value as unknown as RoutineSchedule).ok).toBe(false);
  });
});

// Oracle helpers. The weekday comes from Intl's own weekday name, not from the
// getUTCDay() table in routine-schedule.ts; the scan walks instants, not local dates.
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });
const weekdayOf = (localAsUtc: number) => weekdayFmt.format(localAsUtc).toLowerCase() as RoutineDayOfWeek;
function dateMatches(s: RoutineSchedule, localAsUtc: number): boolean {
  const d = new Date(localAsUtc);
  if (s.daysOfWeek) return s.daysOfWeek.includes(weekdayOf(localAsUtc));
  if (s.dayOfMonth !== undefined) return d.getUTCDate() === s.dayOfMonth && (s.month === undefined || d.getUTCMonth() + 1 === s.month);
  return true;
}
function rng(seed: number) { return () => ((seed = (seed * 1_103_515_245 + 12_345) >>> 0) / 2 ** 32); }
const rand = rng(20261018);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
function randomDays(): RoutineDayOfWeek[] {
  const days = Array.from({ length: int(1, 7) }, () => pick(ROUTINE_DAYS_OF_WEEK));
  return rand() < 0.1 ? [...days, days[0]!].slice(0, 7) : days; // sometimes a duplicate
}
function randomSchedule(tz: string, kinds: readonly ('daily' | 'weekly' | 'monthly' | 'yearly')[]): RoutineSchedule {
  const time = { minute: int(0, 59), hour: int(0, 23), tz };
  switch (pick(kinds)) {
    case 'daily': return time;
    case 'weekly': return { ...time, daysOfWeek: randomDays() };
    case 'monthly': return { ...time, dayOfMonth: int(1, 31) };
    case 'yearly': return { ...time, dayOfMonth: int(1, 31), month: int(1, 12) };
  }
}

// Oracle: step through instants one hour apart on the schedule's minute; take
// the first whose local hour and local date match.
function fixedOracle(s: RoutineSchedule, offsetMin: number, now: number): number | null {
  const offset = offsetMin * 60_000;
  let t = Math.floor((now + offset) / 3_600_000) * 3_600_000 + s.minute * 60_000 - offset;
  while (t <= now) t += 3_600_000;
  for (; t <= now + ROUTINE_HORIZON_MS; t += 3_600_000) {
    const local = t + offset;
    if (new Date(local).getUTCHours() === s.hour && dateMatches(s, local)) return t;
  }
  return null;
}
const fixed: [string, number][] = [['UTC', 0], ['Asia/Shanghai', 480], ['Asia/Kolkata', 330], ['Asia/Kathmandu', 345]];
it('agrees with the fixed-offset instant oracle for 400 schedules', () => {
  let diffCases = 0, diffFail = 0, skipped = 0;
  const kindsSeen = new Map<string, number>();
  for (let i = 0; i < 400; i++) {
    const [tz, off] = pick(fixed);
    const schedule = randomSchedule(tz, ['daily', 'weekly', 'monthly', 'yearly']);
    const now = at('2024-01-01T00:00:00Z') + Math.floor(rand() * 10 * 365 * 86_400_000) + Math.floor(rand() * 60_000);
    if (!checkRoutineSchedule(schedule).ok) { skipped++; continue; }
    const kind = schedule.daysOfWeek ? 'weekly' : schedule.month ? 'yearly' : schedule.dayOfMonth ? 'monthly' : 'daily';
    kindsSeen.set(kind, (kindsSeen.get(kind) ?? 0) + 1);
    diffCases++;
    const got = nextRoutineOccurrence(schedule, now), want = fixedOracle(schedule, off, now);
    if (got !== want) { diffFail++; if (diffFail <= 5) console.log(`  MISMATCH ${show(schedule)} now=${iso(now)} got=${iso(got)} want=${iso(want)}`); }
  }
  report(diffFail === 0, `${diffCases} random schedules agree with the oracle (${[...kindsSeen].map(([k, n]) => `${k} ${n}`).join(', ')}; ${skipped} rejected by checkRoutineSchedule, ${diffFail} mismatches)`);
});

const fmt = new Map<string, Intl.DateTimeFormat>();
function local(tz: string, t: number): number {
  let f = fmt.get(tz);
  if (!f) fmt.set(tz, f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
  const p = Object.fromEntries(f.formatToParts(t).map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
}
// Oracle: scan instants minute by minute; a local time seen first after now
// is a candidate; local times jumped over are gap candidates at prev + (L - Lprev).
function dstOracle(s: RoutineSchedule, now: number): number | null {
  const seen = new Set<number>();
  const matches = (L: number) => { const d = new Date(L); return d.getUTCMinutes() === s.minute && d.getUTCHours() === s.hour && dateMatches(s, L); };
  let prev = Math.floor(now / 60_000) * 60_000 - 2 * 86_400_000;
  let prevLocal = local(s.tz, prev);
  seen.add(prevLocal);
  let best = Infinity;
  for (let t = prev + 60_000; t <= now + 9 * 86_400_000; t += 60_000) {
    const L = local(s.tz, t);
    for (let gap = prevLocal + 60_000; gap < L; gap += 60_000) {
      const cand = prev + (gap - prevLocal);
      if (!seen.has(gap) && matches(gap) && cand > now) best = Math.min(best, cand);
    }
    if (!seen.has(L)) { seen.add(L); if (matches(L) && t > now) best = Math.min(best, t); }
    prev = t; prevLocal = L;
  }
  return best === Infinity ? null : best;
}
const transitions: [string, string][] = [
  [NY, '2026-03-08T07:00:00Z'], [NY, '2026-11-01T06:00:00Z'],
  ['Europe/London', '2026-03-29T01:00:00Z'], ['Europe/London', '2026-10-25T01:00:00Z'],
  ['Australia/Sydney', '2026-04-04T16:00:00Z'], ['Australia/Sydney', '2026-10-03T16:00:00Z'],
  ['Australia/Lord_Howe', '2026-04-04T15:00:00Z'], ['Australia/Lord_Howe', '2026-10-03T15:30:00Z'],
  ['America/Santiago', '2026-04-05T03:00:00Z'], ['America/Santiago', '2026-09-06T04:00:00Z'],
];
it('agrees with the minute-scan oracle near ten DST transitions', () => {
  let dstCases = 0, dstFail = 0, dstWeekly = 0;
  for (let i = 0; i < 120; i++) {
    const [tz, edge] = pick(transitions);
    const schedule = randomSchedule(tz, ['daily', 'weekly']);
    // Near the transition: an hour within ±2 of the change makes gap and overlap times likely.
    const edgeLocalHour = new Date(local(tz, at(edge))).getUTCHours();
    if (rand() < 0.6) (schedule as { hour: number }).hour = (edgeLocalHour + int(-2, 1) + 24) % 24;
    const now = at(edge) - Math.floor(rand() * 26 * 3_600_000) + Math.floor(rand() * 4 * 3_600_000);
    const want = dstOracle(schedule, now);
    const got = nextRoutineOccurrence(schedule, now);
    dstCases++;
    if (schedule.daysOfWeek) dstWeekly++;
    if (want === null || got !== want) { dstFail++; if (dstFail <= 5) console.log(`  MISMATCH ${show(schedule)} now=${iso(now)} got=${iso(got)} want=${iso(want)}`); }
  }
  report(dstFail === 0, `${dstCases} random daily/weekly schedules (${dstWeekly} weekly) near 10 DST transitions agree with the scan oracle (${dstFail} mismatches; oracle null counts as a mismatch)`);

}, 30_000);

it('keeps yearly schedules within the horizon, including DST and leap years', () => {
  {
    const now = at('2031-03-10T16:00:00.001Z'); // 12:00 EDT, just after the 2031 occurrence
    const next = nextRoutineOccurrence({ minute: 0, hour: 12, dayOfMonth: 10, month: 3, tz: NY }, now);
    const gapH = next === null ? NaN : (next - now) / 3_600_000;
    report(next === at('2032-03-10T17:00:00Z'), `yearly Mar 10 12:00 NY across leap 2032 and a DST flip: next=${iso(next)} gap=${(gapH / 24).toFixed(4)} d; horizon=${ROUTINE_HORIZON_MS / 86_400_000} d`);
  }
  {
    let worst = 0, worstAt = '', nulls = 0;
    const zones = [NY, 'Europe/London', 'Australia/Sydney', 'Antarctica/Troll', 'America/Santiago', 'Australia/Lord_Howe', 'Africa/Cairo', 'Pacific/Apia'];
    for (const tz of zones) for (let month = 1; month <= 12; month++) for (const dayOfMonth of [1, 9, 10, 12, 15, 28]) {
      const schedule = { minute: 0, hour: 12, dayOfMonth, month, tz };
      let t = at('2026-01-01T00:00:00Z');
      for (let n = 0; n < 30; n++) {
        const next = nextRoutineOccurrence(schedule, t);
        if (next === null) { nulls++; break; }
        if (next - t > worst) { worst = next - t; worstAt = `${month}/${dayOfMonth} 12:00 ${tz} ${iso(t)}→${iso(next)}`; }
        t = next;
      }
    }
    report(nulls === 0 && worst <= ROUTINE_HORIZON_MS, `yearly sweep 2026-2056, 8 zones × 72 dates: max gap ${(worst / 86_400_000).toFixed(4)} d (${worstAt}); nulls=${nulls}`);
  }
  let maxGap = 0;
  for (const [dayOfMonth, month, hour] of [[1, 1, 0], [31, 12, 0], [28, 2, 0], [10, 3, 12]] as const) {
    let t = at('2027-06-01T00:00:00Z');
    for (let n = 0; n < 12; n++) {
      const next = nextRoutineOccurrence({ minute: 0, hour, dayOfMonth, month, tz: NY }, t)!;
      maxGap = Math.max(maxGap, next - t); t = next;
    }
  }
  report(maxGap <= ROUTINE_HORIZON_MS, `largest gap over 12 years of yearly schedules (NY) = ${(maxGap / 86_400_000).toFixed(4)} d ≤ ${ROUTINE_HORIZON_MS / 86_400_000} d`);
  {
    // Feb 29 is reachable, but the wait can be 8 years (2096 → 2104: 2100 is not a leap year).
    let worstYears = 0, worstFrom = 0, prev = 0;
    for (let y = 2000; y < 2200; y++) {
      if (new Date(Date.UTC(y, 1, 29)).getUTCMonth() !== 1) continue;
      if (prev && y - prev > worstYears) { worstYears = y - prev; worstFrom = prev; }
      prev = y;
    }
    const check = checkRoutineSchedule({ minute: 0, hour: 0, dayOfMonth: 29, month: 2, tz: 'UTC' });
    report(!check.ok && check.code === 'schedule_beyond_horizon',
      `Feb 29 yearly: longest wait between Feb 29s in [2000, 2200) is ${worstYears} years (${worstFrom} → ${worstFrom + worstYears}) → ${check.ok ? 'ok' : check.code}`);
  }

}, 30_000);
