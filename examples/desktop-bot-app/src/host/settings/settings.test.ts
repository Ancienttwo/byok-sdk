import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Daemon, DaemonConfig, DiagnosticsSnapshot, RuntimeAdapter, RuntimeObservation } from '@byok-sdk/client';
import { describe, expect, it, vi } from 'vitest';
import { trayMenu } from '../../main/tray-menu.ts';
import type { HostContext } from '../domains.ts';
import { deviceSettings, deviceView } from './device.ts';
import { createSettingsDomain } from './domain.ts';
import { DEFAULT_SETTINGS, dreamingOption, SettingsDamagedError, settingsStore } from './store.ts';

const status = {
  paired: true, deviceId: 'dev-1', lifecycle: { phase: 'running', connection: 'open' }, activeTaskCount: 2, pendingTerminalCommits: 0,
  runtimes: [
    {
      id: 'claude',
      present: true,
      outcome: 'available',
      version: '2.1.0',
      authPresent: true,
      executablePath: '/usr/local/bin/claude',
      executableSource: 'path',
      versionVerdict: { state: 'allow', qualifiedVersion: '2.1.0' },
      steer: true,
      resume: true,
    },
    {
      id: 'codex',
      present: true,
      outcome: 'available',
      version: '0.50.0',
      authPresent: false,
      steer: true,
      resume: true,
    },
    {
      id: 'opencode',
      present: true,
      outcome: 'available',
      version: '0.9.0',
      steer: false,
      resume: true,
    },
    {
      id: 'grok',
      present: false,
      outcome: 'timeout',
      steer: false,
      resume: true,
    },
    {
      id: 'pi',
      present: true,
      outcome: 'available',
      version: '1.3.0',
      qualifiedVersion: '1.2.0',
      versionVerdict: { state: 'warn', qualifiedVersion: '1.2.0' },
      upgrade: { state: 'available', installedVersion: '1.3.0', qualifiedVersion: '1.4.0', command: 'npm i -g pi' },
      steer: true,
      resume: true,
    },
    {
      id: 'dsh',
      present: true,
      outcome: 'available',
      version: '0.1.0',
      versionVerdict: { state: 'block', qualifiedVersion: '0.2.0', matched: '0.1.0' },
      steer: false,
      resume: false,
    },
    {
      id: 'agy',
      present: false,
      outcome: 'not-found',
      steer: false,
      resume: false,
    },
    {
      id: 'refused-rt',
      present: false,
      outcome: 'refused',
      reason: 'app_server_unavailable',
      steer: false,
      resume: false,
    },
  ] satisfies RuntimeObservation[],
} as unknown as Parameters<typeof deviceView>[0];
const doctor = {
  generatedAt: '2026-11-11T00:00:00Z',
  clockSkew: { status: 'measured', deviceAheadMs: 40, uncertaintyMs: 5, observedAt: '2026-11-11T00:00:00Z' },
  checks: [{ id: 'device', status: 'pass', summary: 'ok' }, { id: 'clock-skew', status: 'warn', summary: 'skew' }],
} as unknown as DiagnosticsSnapshot;

describe('device view', () => {
  it('projects every RuntimeObservation branch without inferring absent fields', () => {
    const view = deviceView(status, doctor);
    expect(view.doctor.worst).toBe('warn');
    expect(view.clockSkew).toEqual(doctor.clockSkew);

    const byId = Object.fromEntries(view.runtimes.map(runtime => [runtime.id, runtime]));
    expect(byId.claude).toEqual({
      id: 'claude',
      present: true,
      outcome: 'available',
      version: '2.1.0',
      verdict: 'allow',
      authPresent: true,
      executablePath: '/usr/local/bin/claude',
      executableSource: 'path',
    });
    expect(byId.codex).toEqual({
      id: 'codex',
      present: true,
      outcome: 'available',
      version: '0.50.0',
      authPresent: false,
    });
    expect('verdict' in byId.codex!).toBe(false);
    expect(byId.opencode).toEqual({
      id: 'opencode',
      present: true,
      outcome: 'available',
      version: '0.9.0',
    });
    expect('authPresent' in byId.opencode!).toBe(false);
    expect(byId.grok).toEqual({
      id: 'grok',
      present: false,
      outcome: 'timeout',
    });
    expect('authPresent' in byId.grok!).toBe(false);
    expect(byId.pi).toEqual({
      id: 'pi',
      present: true,
      outcome: 'available',
      version: '1.3.0',
      verdict: 'warn',
      qualifiedVersion: '1.2.0',
      upgrade: { state: 'available', installedVersion: '1.3.0', qualifiedVersion: '1.4.0', command: 'npm i -g pi' },
    });
    expect(byId.dsh).toEqual({
      id: 'dsh',
      present: true,
      outcome: 'available',
      version: '0.1.0',
      verdict: 'block',
    });
    expect(byId.agy).toEqual({
      id: 'agy',
      present: false,
      outcome: 'not-found',
    });
    expect(byId['refused-rt']).toEqual({
      id: 'refused-rt',
      present: false,
      outcome: 'refused',
      reason: 'app_server_unavailable',
    });
  });

  it('re-probes configured adapters only when checkAuth is true and keeps timeout distinct', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'device-check-auth-'));
    const detectClaude = vi.fn<RuntimeAdapter['detect']>().mockResolvedValue({
      kind: 'available',
      version: '2.1.0',
      authPresent: true,
      executablePath: '/opt/bin/claude',
      executableSource: 'path',
    });
    const detectSlow = vi.fn<RuntimeAdapter['detect']>(
      (signal?: AbortSignal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    );
    const adapters: RuntimeAdapter[] = [
      {
        descriptor: {
          id: 'claude',
          selectionModes: ['subscription'],
          capabilities: { steer: true, resume: true, approvalInteractive: false },
        },
        detect: detectClaude,
      } as unknown as RuntimeAdapter,
      {
        descriptor: {
          id: 'codex',
          selectionModes: ['subscription'],
          capabilities: { steer: true, resume: true, approvalInteractive: false },
        },
        detect: detectSlow,
      } as unknown as RuntimeAdapter,
    ];
    const daemon = {
      status: () => ({
        ...status,
        runtimes: [
          { id: 'claude', present: true, outcome: 'available', version: '2.1.0', authPresent: false, steer: true, resume: true },
          { id: 'codex', present: true, outcome: 'available', version: '0.50.0', authPresent: false, steer: true, resume: true },
        ],
      }),
    } as unknown as Daemon;
    const config = {
      productId: 'test',
      productName: 'Test',
      deviceName: 'Test',
      serverUrl: 'http://127.0.0.1:1',
      storeDir,
    } as DaemonConfig;
    const settings = deviceSettings(daemon, config, adapters, {
      adapters: [],
      runtimeProbeTimeoutMs: 40,
    });

    const initial = await settings.device();
    expect(detectClaude).not.toHaveBeenCalled();
    expect(detectSlow).not.toHaveBeenCalled();
    expect(initial.runtimes.find(r => r.id === 'claude')?.authPresent).toBe(false);

    const noProbe = await settings.device({ checkAuth: false });
    expect(detectClaude).not.toHaveBeenCalled();
    expect(noProbe.runtimes.find(r => r.id === 'claude')?.authPresent).toBe(false);

    const reprobed = await settings.device({ checkAuth: true });
    expect(detectClaude).toHaveBeenCalledOnce();
    expect(detectSlow).toHaveBeenCalledOnce();
    expect(reprobed.runtimes.find(r => r.id === 'claude')).toMatchObject({
      present: true,
      outcome: 'available',
      authPresent: true,
      executablePath: '/opt/bin/claude',
      executableSource: 'path',
    });
    expect(reprobed.runtimes.find(r => r.id === 'codex')).toEqual({
      id: 'codex',
      present: false,
      outcome: 'timeout',
    });
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
    expect(trayMenu({ state: 'stopped', pid: 1, reason: 'store refused', storeRefused: true }, actions, 'App')[1]!.label).toBe('Host stopped: store refused');
    expect(trayMenu(undefined, actions, 'App')[1]!.label).toBe('Host starting');
    expect(trayMenu({ state: 'restarting', inMs: 1000, reason: 'Host exited with code 1' }, actions, 'App')[1]!.label).toBe('Host restarting: Host exited with code 1');
  });
});

describe('settings domain', () => {
  it('validates renderer params and persists dreaming under the Host directory', async () => {
    const hostStorageRoot = await mkdtemp(path.join(tmpdir(), 'settings-domain-'));
    const { handlers } = await createSettingsDomain({ hostStorageRoot, adapters: [] } as unknown as HostContext);
    expect(await handlers['settings.get'](undefined)).toEqual(DEFAULT_SETTINGS);
    await expect(handlers['settings.device']({ checkAuth: 'yes' } as unknown as undefined)).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(handlers['settings.device']({ extra: true } as unknown as undefined)).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(handlers['settings.device'](['bad'] as unknown as undefined)).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(handlers['settings.setDreaming']({ enabled: 'on', models: [] })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(handlers['settings.setDreaming']({ enabled: true, models: ['a', 'a'] })).rejects.toMatchObject({ code: 'invalid_params' });
    await handlers['settings.setDreaming']({ enabled: false, models: ['cheap'] });
    expect(JSON.parse(await readFile(path.join(hostStorageRoot, 'host', 'settings.json'), 'utf8'))).toEqual({ dreaming: { enabled: false, models: ['cheap'] } });
  });
});
