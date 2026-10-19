import { time, type RoutineDefinition } from './model';

/** The Host can inject its shared cron/time-zone calendar. K4 does not define a cron dialect. */
export type NextOccurrence = (definition: Readonly<RoutineDefinition>, after: number) => number | null;

/** Default example rule: { anchorMs, everyMs, quietHours?: { startMinute, endMinute } }, UTC. */
export const nextIntervalOccurrence: NextOccurrence = (definition, after) => {
  const rule = definition.rule;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule) || definition.timeZone !== 'UTC') {
    throw new Error('The default interval calendar requires a UTC rule; inject another shared calendar for other zones');
  }
  const { anchorMs, everyMs, quietHours } = rule;
  if (typeof anchorMs !== 'number' || typeof everyMs !== 'number' || everyMs < 1) throw new Error('Invalid interval rule');
  time(anchorMs); time(everyMs);
  if (!Number.isSafeInteger(after) || after < -1) throw new Error('Invalid calendar cursor');
  let defer = (slot: number): number => slot;
  if (quietHours !== undefined) {
    if (!quietHours || typeof quietHours !== 'object' || Array.isArray(quietHours)) throw new Error('Invalid quiet hours');
    const { startMinute: start, endMinute: end } = quietHours;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end < 0 || start >= 1440 || end >= 1440 || start === end) throw new Error('Invalid quiet hours');
    defer = slot => {
      const day = Number(BigInt(slot) / 86_400_000n * 86_400_000n);
      const minute = (slot - day) / 60_000;
      if (start < end ? minute >= start && minute < end : minute >= start || minute < end) {
        return time(day + end * 60_000 + (start > end && minute >= start ? 86_400_000 : 0));
      }
      return slot;
    };
  }
  const anchor = BigInt(anchorMs), interval = BigInt(everyMs), cursor = BigInt(after);
  // Deferral is monotone. If the last raw slot is still in the future after
  // deferral, it is the next effective time. Otherwise take the next raw slot.
  // This is constant work even for 1 ms intervals through a long quiet period.
  const index = cursor < anchor ? 0n : (cursor - anchor) / interval;
  let slot = defer(time(Number(anchor + index * interval)));
  if (slot <= after) slot = defer(time(Number(anchor + (index + 1n) * interval)));
  return definition.endAt !== undefined && slot > definition.endAt ? null : slot;
};
