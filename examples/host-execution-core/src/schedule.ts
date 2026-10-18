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
  let slot = time(anchorMs + Math.max(0, Math.floor((after - anchorMs) / everyMs) + 1) * everyMs);
  if (quietHours !== undefined) {
    if (!quietHours || typeof quietHours !== 'object' || Array.isArray(quietHours)) throw new Error('Invalid quiet hours');
    const { startMinute: start, endMinute: end } = quietHours;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end < 0 || start >= 1440 || end >= 1440 || start === end) throw new Error('Invalid quiet hours');
    const day = Math.floor(slot / 86_400_000) * 86_400_000;
    const minute = (slot - day) / 60_000;
    if (start < end ? minute >= start && minute < end : minute >= start || minute < end) {
      slot = day + end * 60_000 + (start > end && minute >= start ? 86_400_000 : 0);
    }
  }
  return definition.endAt !== undefined && slot > definition.endAt ? null : slot;
};
