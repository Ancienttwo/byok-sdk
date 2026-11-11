import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DiagnosticsSnapshot } from '@byok-sdk/client';
import { describe, expect, it, vi } from 'vitest';
import { trayMenu } from '../../main/tray-menu.ts';
import { deviceView } from './device.ts';
import { DEFAULT_SETTINGS, dreamingOption, SettingsDamagedError, settingsStore } from './store.ts';

const status = {
  paired: true, deviceId: 'dev-1', lifecycle: { phase: 'running', connection: 'open' }, activeTaskCount: 2, pendingTerminalCommits: 0,
  runtimes: [
    { id: 'pi', present: true, outcome: 'available', version: '1.3.0', versionVerdict: { state: 'warn', qualifiedVersion: '1.3.0' } },
    { id: 'codex', present: false, outcome: 'unavailable', reason: 'not_found' },
  ],
} as unknown as Parameters<typeof deviceView>[0];
const doctor = {
  generatedAt: '2026-11-11T00:00:00Z',
  clockSkew: { status: 'measured', deviceAheadMs: 40, uncertaintyMs: 5, observedAt: '2026-11-11T00:00:00Z' },
  checks: [{ id: 'device', status: 'pass', summary: 'ok' }, { id: 'clock-skew', status: 'warn', summary: 'skew' }],
} as unknown as DiagnosticsSnapshot;

describe('device view', () => {
  it('projects status and doctor without inferring a missing verdict', () => {
    const view = deviceView(status, doctor);
    expect(view.doctor.worst).toBe('warn');
    expect(view.clockSkew).toEqual(doctor.clockSkew);
    expect(view.runtimes.map(runtime => runtime.verdict)).toEqual(['warn', undefined]);
    expect(view.runtimes[1]).toMatchObject({ present: false, reason: 'not_found' });
  });
});

describe('settings store', () => {
  it('defaults when missing, persists dreaming, and refuses a damaged file', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'settings-')), 'sub', 'settings.json');
    const store = settingsStore(file);
    expect(await store.read()).toEqual(DEFAULT_SETTINGS);
    await store.setDreaming({ enabled: false, models: ['cheap'] });
    expect(await store.read()).toEqual({ dreaming: { enabled: false, models: ['cheap'] } });
    await expect(store.setDreaming({ enabled: true, models: ['a', 'a'] })).rejects.toThrow(RangeError);
    await writeFile(file, '{"dreaming":{"enabled":"yes","models":[]}}');
    await expect(store.read()).rejects.toThrow(SettingsDamagedError);
    expect(await readFile(file, 'utf8')).toContain('"yes"');
  });

  it('maps to the K8 dreaming option', () => {
    expect(dreamingOption({ enabled: false, models: ['x'] })).toBe(false);
    expect(dreamingOption({ enabled: true, models: ['x'] })).toEqual({ models: ['x'] });
  });
});

describe('tray menu', () => {
  it('shows active work only while running and wires show and quit', () => {
    const actions = { showWindow: vi.fn(), quit: vi.fn() };
    const running = trayMenu({ state: 'running', pid: 1, activeWork: 3 }, actions, 'App');
    expect(running.map(item => item.label)).toEqual(['Show App', 'Active tasks: 3', 'Quit']);
    running[0]!.click!();
    running[2]!.click!();
    expect(actions.showWindow).toHaveBeenCalledOnce();
    expect(actions.quit).toHaveBeenCalledOnce();
    expect(trayMenu({ state: 'stopped', pid: 1, reason: 'store refused' }, actions, 'App')[1]!.label).toBe('Host stopped: store refused');
    expect(trayMenu(undefined, actions, 'App')[1]!.label).toBe('Host starting');
  });
});
