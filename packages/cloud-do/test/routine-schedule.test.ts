import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { directed, tzCases } from '../../core/src/__tests__/fixtures/routine-cases';
import { nextRoutineOccurrence } from '../../core/src/routine-schedule';

it('matches Node calendar instants and zone checks in real workerd without Node support', async () => {
  const bundle = await build({ entryPoints: ['test/routine-schedule-worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const mf = new Miniflare({ log: new Log(LogLevel.ERROR), workers: [{ config: {
    name: 'routine-calendar', compatibilityDate: '2026-08-18',
    compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: bundle.outputFiles![0]!.text } } },
  } }] });
  try {
    const schedules = directed.map(([, schedule, now]) => ({ schedule, now: Date.parse(now) }));
    const response = await mf.dispatchFetch('https://calendar.test', {
      method: 'POST', body: JSON.stringify({ schedules, zones: tzCases.map(([tz]) => tz) }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { instants: number[]; zones: { ok: boolean; code?: string }[] };
    expect(body.instants).toEqual(directed.map(([, , , expected]) => Date.parse(expected)));
    expect(body.instants).toEqual(schedules.map(({ schedule, now }) => nextRoutineOccurrence(schedule, now)));
    expect(body.zones.map(check => check.ok ? 'ok' : check.code)).toEqual(tzCases.map(([, expected]) => expected));
  } finally {
    await mf.dispose();
  }
}, 30_000);
