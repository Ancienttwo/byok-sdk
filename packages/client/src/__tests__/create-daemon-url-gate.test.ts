import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDaemon, type Daemon } from '../daemon/create-daemon';
import { InsecureServerUrlError } from '../daemon/url';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * M5: entry-point coverage for `url.ts`'s `assertServerUrlAllowed` — proves
 * the gate actually runs at the two real places a configured `serverUrl`
 * enters the client (`create-daemon.ts`'s `pair()` and `start()`), not just
 * in isolation (see `url.test.ts` for the gate function's own unit tests).
 *
 * None of these tests need a real or fake server: the gate is the very
 * first thing both `pair()` and `start()` do, so a disallowed URL rejects
 * before any network call is attempted, and `start()`'s guard runs before
 * even `auth.loadExisting()` — an unpaired device's usual "device is not
 * paired yet" error is exactly the signal used below to prove the gate let
 * execution continue (the escape-hatch cases), without needing a live
 * connection at all.
 */
describe('create-daemon.ts: server-URL transport-security gate', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('pair()', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('rejects pairing against an insecure remote URL with the typed error, before any network call', async () => {
      const daemon = createDaemon({
        productName: 'Acme',
        productId: 'acme-gate-pair-fail',
        serverUrl: 'http://example.com',
        workspaceRoot: await tmpDir('byok-gate-pair-fail-ws-'),
        storeDir: await tmpDir('byok-gate-pair-fail-store-'),
      });

      await expect(daemon.pair('the-code')).rejects.toThrow(InsecureServerUrlError);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('with dangerouslyAllowInsecureRemote: true, proceeds past the gate (reaches the network) and logs a warning', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ deviceId: 'dev-1', accessToken: 'tok-1' }),
      });

      const daemon = createDaemon({
        productName: 'Acme',
        productId: 'acme-gate-pair-hatch',
        serverUrl: 'http://example.com',
        dangerouslyAllowInsecureRemote: true,
        workspaceRoot: await tmpDir('byok-gate-pair-hatch-ws-'),
        storeDir: await tmpDir('byok-gate-pair-hatch-store-'),
      });

      const record = await daemon.pair('the-code');

      expect(record.deviceId).toBe('dev-1');
      expect(fetchMock).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [warning] = warnSpy.mock.calls[0] as [string];
      expect(warning).toContain('dangerouslyAllowInsecureRemote');
      expect(warning).toContain('http://example.com');
    });

    it('with dangerouslyAllowInsecureRemote: true against an ALREADY-loopback URL, proceeds normally and logs NO warning (the hatch was inert, never exercised)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ deviceId: 'dev-2', accessToken: 'tok-2' }),
      });

      const daemon = createDaemon({
        productName: 'Acme',
        productId: 'acme-gate-pair-inert-hatch',
        serverUrl: 'http://127.0.0.1:1',
        dangerouslyAllowInsecureRemote: true,
        workspaceRoot: await tmpDir('byok-gate-pair-inert-ws-'),
        storeDir: await tmpDir('byok-gate-pair-inert-store-'),
      });

      await daemon.pair('the-code');

      expect(fetchMock).toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('F2: with dangerouslyAllowInsecureRemote: true, an unsupported scheme (ftp:) still throws the typed error unconditionally — the hatch only covers plaintext-to-non-loopback, never a scheme this transport has no meaning for at all', async () => {
      const daemon = createDaemon({
        productName: 'Acme',
        productId: 'acme-gate-pair-unsupported-scheme',
        serverUrl: 'ftp://x',
        dangerouslyAllowInsecureRemote: true,
        workspaceRoot: await tmpDir('byok-gate-pair-unsupported-ws-'),
        storeDir: await tmpDir('byok-gate-pair-unsupported-store-'),
      });

      await expect(daemon.pair('the-code')).rejects.toThrow(InsecureServerUrlError);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('start()', () => {
    it('rejects starting against an insecure remote config URL with the typed error — even for a never-paired device (runs before the "not paired" check)', async () => {
      const daemon: Daemon = createDaemon({
        productName: 'Acme',
        productId: 'acme-gate-start-fail',
        serverUrl: 'http://example.com',
        workspaceRoot: await tmpDir('byok-gate-start-fail-ws-'),
        storeDir: await tmpDir('byok-gate-start-fail-store-'),
      });

      await expect(daemon.start()).rejects.toThrow(InsecureServerUrlError);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('with dangerouslyAllowInsecureRemote: true, proceeds past the gate (fails on "not paired" instead) and logs a warning', async () => {
      const daemon: Daemon = createDaemon({
        productName: 'Acme',
        productId: 'acme-gate-start-hatch',
        serverUrl: 'http://example.com',
        dangerouslyAllowInsecureRemote: true,
        workspaceRoot: await tmpDir('byok-gate-start-hatch-ws-'),
        storeDir: await tmpDir('byok-gate-start-hatch-store-'),
      });

      // Never paired — proves the gate passed and execution moved on to the
      // NEXT step (loadExisting()'s own "not paired" guard), rather than the
      // security gate itself blocking it.
      await expect(daemon.start()).rejects.toThrow(/device is not paired yet/);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [warning] = warnSpy.mock.calls[0] as [string];
      expect(warning).toContain('dangerouslyAllowInsecureRemote');
      expect(warning).toContain('http://example.com');
    });

    it('a loopback config URL never triggers the gate at all, with or without the escape hatch set', async () => {
      const daemon: Daemon = createDaemon({
        productName: 'Acme',
        productId: 'acme-gate-start-loopback',
        serverUrl: 'http://127.0.0.1:1',
        dangerouslyAllowInsecureRemote: true,
        workspaceRoot: await tmpDir('byok-gate-start-loopback-ws-'),
        storeDir: await tmpDir('byok-gate-start-loopback-store-'),
      });

      await expect(daemon.start()).rejects.toThrow(/device is not paired yet/);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('F2: with dangerouslyAllowInsecureRemote: true, an unsupported scheme (ftp:) still throws the typed error unconditionally, with no warning emitted', async () => {
      const daemon: Daemon = createDaemon({
        productName: 'Acme',
        productId: 'acme-gate-start-unsupported-scheme',
        serverUrl: 'ftp://x',
        dangerouslyAllowInsecureRemote: true,
        workspaceRoot: await tmpDir('byok-gate-start-unsupported-ws-'),
        storeDir: await tmpDir('byok-gate-start-unsupported-store-'),
      });

      await expect(daemon.start()).rejects.toThrow(InsecureServerUrlError);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
