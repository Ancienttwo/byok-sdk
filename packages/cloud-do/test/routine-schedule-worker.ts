import { checkRoutineSchedule, nextRoutineOccurrence, type RoutineSchedule } from '../../core/src/routine-schedule';

export default {
  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as { schedules: { schedule: RoutineSchedule; now: number }[]; zones: string[] };
    return Response.json({
      instants: body.schedules.map(({ schedule, now }) => nextRoutineOccurrence(schedule, now)),
      zones: body.zones.map(tz => checkRoutineSchedule({ minute: 0, hour: 9, tz })),
    });
  },
};
