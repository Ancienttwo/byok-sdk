import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PiAdapterOptions } from '../adapters/pi/pi-adapter';

const seen = vi.hoisted(() => [] as PiAdapterOptions[]);
vi.mock('../adapters/pi/pi-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/pi/pi-adapter')>();
  class RecordingPiAdapter extends actual.PiAdapter {
    constructor(options: PiAdapterOptions = {}) { seen.push(options); super(options); }
  }
  return { ...actual, PiAdapter: RecordingPiAdapter };
});

const { createDaemon } = await import('../daemon/create-daemon');

/** A single-file product configures one helper host; the Pi adapter re-enters it too. */
describe('createDaemon: DaemonConfig.sdkHelperHost reaches the Pi adapter', () => {
  it.each([undefined, { mode: 'self-executable' as const }])('passes %j to PiAdapter', (sdkHelperHost) => {
    seen.length = 0;
    createDaemon({
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'pi-sdk-helper-host-test',
      serverUrl: 'http://127.0.0.1:1',
      workspaceRoot: path.join(os.tmpdir(), 'byok-pi-helper-host-workspaces'),
      storeDir: path.join(os.tmpdir(), 'byok-pi-helper-host-store'),
      ...(sdkHelperHost === undefined ? {} : { sdkHelperHost }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sdkHelperHost).toEqual(sdkHelperHost);
  });
});
