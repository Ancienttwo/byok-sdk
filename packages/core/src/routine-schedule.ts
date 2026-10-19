import { ByokCoreError } from './errors';

export const ROUTINE_DAYS_OF_WEEK = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const);
export type RoutineDayOfWeek = (typeof ROUTINE_DAYS_OF_WEEK)[number];

/**
 * One local time per matching day. No daysOfWeek and no dayOfMonth: every
 * day. daysOfWeek: those weekdays only. dayOfMonth: that day of every month,
 * or of `month` only. daysOfWeek and dayOfMonth never appear together;
 * `month` needs `dayOfMonth`.
 */
export interface RoutineSchedule {
  readonly minute: number;
  readonly hour: number;
  readonly daysOfWeek?: readonly RoutineDayOfWeek[];
  readonly dayOfMonth?: number;
  readonly month?: number;
  readonly tz: string;
}
/**
 * 368 days: a yearly date can be 366 days plus a DST shift apart (leap year
 * in between, DST state flips). The embedded wake limit must match this value.
 */
export const ROUTINE_HORIZON_MS = 368 * 86_400_000;
/**
 * Supported `now`: [2000-01-01T00:00Z, 2200-01-01T00:00Z). Before 1972 some
 * zones have second-level offsets (Africa/Monrovia); past 2200 tz rules are
 * projections. Date and Intl themselves cover ±8.64e15 ms.
 */
export const ROUTINE_MIN_NOW = Date.UTC(2000, 0, 1);
export const ROUTINE_MAX_NOW = Date.UTC(2200, 0, 1);
export type RoutineScheduleIssueCode = 'schedule_invalid' | 'schedule_unreachable' | 'schedule_beyond_horizon' | 'tz_invalid';
export type RoutineScheduleCheck = { readonly ok: true } | { readonly ok: false; readonly code: RoutineScheduleIssueCode; readonly message: string };

const KEYS = new Set(['minute', 'hour', 'daysOfWeek', 'dayOfMonth', 'month', 'tz']);
/** Days in each month of a common year; February 29 is handled apart. */
const COMMON_YEAR_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const TZ_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const DAY_MS = 86_400_000;
/** Date.getUTCDay() index (0 = Sunday) to the schedule's day name. */
const UTC_DAY_NAME: readonly RoutineDayOfWeek[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface Parsed { minute: number; hour: number; days?: Set<RoutineDayOfWeek>; dayOfMonth?: number; month?: number; tz: string }
class ScheduleError extends Error {
  readonly code: RoutineScheduleIssueCode;
  constructor(code: RoutineScheduleIssueCode, message: string) { super(message); this.code = code; }
}
const invalid = (message: string) => new ScheduleError('schedule_invalid', message);

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(`${name} must be an integer ${min}-${max}`);
  return value;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
    formatters.set(tz, f);
  }
  return f;
}

function checkTz(tz: unknown): string {
  if (typeof tz !== 'string' || !TZ_NAME.test(tz)) throw new ScheduleError('tz_invalid', `${JSON.stringify(tz)} is not an IANA zone name`);
  try { formatter(tz); } catch { throw new ScheduleError('tz_invalid', `"${tz}" is not a known IANA zone`); }
  return tz;
}

function parse(schedule: RoutineSchedule): Parsed {
  if (schedule === null || typeof schedule !== 'object' || Array.isArray(schedule)) throw invalid('schedule must be an object');
  for (const key of Object.keys(schedule)) if (!KEYS.has(key)) throw invalid(`unknown field ${key}`);
  const p: Parsed = { minute: integer(schedule.minute, 'minute', 0, 59), hour: integer(schedule.hour, 'hour', 0, 23), tz: checkTz(schedule.tz) };
  const s = schedule as { daysOfWeek?: unknown; dayOfMonth?: unknown; month?: unknown };
  if (s.daysOfWeek !== undefined && s.dayOfMonth !== undefined) throw invalid('daysOfWeek and dayOfMonth cannot both appear');
  if (s.month !== undefined && s.dayOfMonth === undefined) throw invalid('month needs dayOfMonth');
  if (s.daysOfWeek !== undefined) {
    if (!Array.isArray(s.daysOfWeek) || s.daysOfWeek.length < 1 || s.daysOfWeek.length > 7) throw invalid('daysOfWeek must list 1-7 days');
    for (const d of s.daysOfWeek) if (!(ROUTINE_DAYS_OF_WEEK as readonly unknown[]).includes(d)) throw invalid(`unknown day ${JSON.stringify(d)}`);
    p.days = new Set(s.daysOfWeek as RoutineDayOfWeek[]); // duplicates collapse
  }
  if (s.dayOfMonth !== undefined) {
    p.dayOfMonth = integer(s.dayOfMonth, 'dayOfMonth', 1, 31);
    if (s.month !== undefined) {
      p.month = integer(s.month, 'month', 1, 12);
      if (p.month === 2 && p.dayOfMonth === 29) {
        throw new ScheduleError('schedule_beyond_horizon', 'February 29 exists only in leap years; the next one can be up to 8 years away, beyond the 368-day horizon');
      }
      if (p.dayOfMonth > COMMON_YEAR_DAYS[p.month - 1]!) {
        throw new ScheduleError('schedule_unreachable', `month ${p.month} has no day ${p.dayOfMonth}`);
      }
    }
  }
  return p;
}

/** Validation only. The Host calls it when it applies create_routine / update_routine. */
export function checkRoutineSchedule(schedule: RoutineSchedule): RoutineScheduleCheck {
  try { parse(schedule); return { ok: true }; } catch (e) {
    if (e instanceof ScheduleError) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
}

/** Local wall-clock fields of an instant, written as a UTC epoch ("local as UTC"). */
function localAsUtc(tz: string, instant: number): number {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(instant)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}
const offsetAt = (tz: string, instant: number) => localAsUtc(tz, instant) - Math.floor(instant / 1000) * 1000;

/**
 * Local wall time to instant, as Temporal `disambiguation: 'compatible'`:
 * a repeated time takes the earlier instant; a skipped time moves later by
 * the length of the gap.
 */
function resolve(tz: string, local: number): { instant: number; shifted: boolean } {
  const before = offsetAt(tz, local - DAY_MS);
  const offsets = new Set([before, offsetAt(tz, local), offsetAt(tz, local + DAY_MS)]);
  const valid = [...offsets].map(o => local - o).filter(i => offsetAt(tz, i) === local - i);
  return valid.length ? { instant: Math.min(...valid), shifted: false } : { instant: local - before, shifted: true };
}

function matchesDate(p: Parsed, y: number, m: number, d: number): boolean {
  if (p.days) return p.days.has(UTC_DAY_NAME[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!);
  if (p.dayOfMonth !== undefined) return d === p.dayOfMonth && (p.month === undefined || m === p.month);
  return true;
}

/**
 * The first occurrence strictly after `now` (epoch ms): the instant at which
 * the zone's wall clock shows the schedule's whole local minute on a matching
 * date. Null when none falls within ROUTINE_HORIZON_MS. Throws on an invalid
 * schedule.
 *
 * Scan from the local date before `now`; keep the running minimum `best` of
 * candidates after `now`; stop at the first unshifted candidate, because a
 * later local time never resolves earlier. Assumes a gap is at most one day.
 */
export function nextRoutineOccurrence(schedule: RoutineSchedule, now: number): number | null {
  if (!Number.isSafeInteger(now) || now < ROUTINE_MIN_NOW || now >= ROUTINE_MAX_NOW) {
    throw new RangeError('now must be a safe integer epoch ms in [2000-01-01, 2200-01-01)');
  }
  let p: Parsed;
  try { p = parse(schedule); } catch (error) {
    if (error instanceof ScheduleError) throw new ByokCoreError('routine_schedule_invalid', error.message);
    throw error;
  }
  const start = localAsUtc(p.tz, now);
  const day0 = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), new Date(start).getUTCDate());
  let best = Infinity;
  for (let k = -1; k <= 368; k += 1) {
    const day = new Date(day0 + k * DAY_MS);
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    if (!matchesDate(p, y, m, d)) continue;
    const { instant, shifted } = resolve(p.tz, Date.UTC(y, m - 1, d, p.hour, p.minute));
    if (instant <= now) continue;
    best = Math.min(best, instant);
    if (!shifted) break; // a later local time can never resolve earlier than an unshifted one
  }
  return best - now <= ROUTINE_HORIZON_MS ? best : null;
}
