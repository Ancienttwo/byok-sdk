import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';
import { BlobClient } from '../daemon/blob-client';
import { ConnectionManager, ReplayCursorTooOldError } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { LongPollClient } from '../daemon/long-poll-transport';
import { DeviceStore } from '../daemon/store';
import { formatServerUrl } from '../daemon/url';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function pairedAuth(): AuthManager {
  return {
    getValidAccessToken: async () => 'test-token',
    handleUnauthorized: async () => 'test-token',
  } as unknown as AuthManager;
}

describe('Issues #112/#113/#116/#121 client security and reliability guards', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('#112 preserves the first pairing key across a failed first-pair response, so an exact server retry receives the same public key', async () => {
    const store = new DeviceStore(await tmpDir('byok-first-pair-recovery-'));
    const firstAttempt = new AuthManager({ serverUrl: 'https://byok.test', store });
    const publicKeys: string[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        devicePublicKey: string;
      };
      publicKeys.push(body.devicePublicKey);
      if (publicKeys.length === 1) throw new Error('connection dropped after the server committed the pair');
      return new Response(
        JSON.stringify({
          deviceId: 'device-first-pair',
          tenantId: 'tenant-first-pair',
          accessToken: 'access-token',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    try {
      await expect(firstAttempt.pair('first-code')).rejects.toThrow('connection dropped');
      await firstAttempt.stop();
      const retry = new AuthManager({ serverUrl: 'https://byok.test', store });
      await expect(retry.pair('first-code')).resolves.toMatchObject({
        deviceId: 'device-first-pair',
      });
      await retry.stop();
      expect(publicKeys).toHaveLength(2);
      expect(publicKeys[1]).toBe(publicKeys[0]);
    } finally {
      fetch.mockRestore();
      await firstAttempt.stop();
    }
  });

  it('#113 projects only parsed scheme, host, and pathname for both validation and insecure-remote diagnostics', () => {
    expect(formatServerUrl('http://alice:password-sentinel@example.test/agent?token=query-sentinel#fragment-sentinel')).toBe('http://example.test/agent');
  });

  it('#116 stops long-poll on the explicit cursor_too_old signal without advancing its cursor', async () => {
    const auth = pairedAuth();
    const terminal = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'cursor_too_old',
          recoverableFrom: 501,
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new LongPollClient({
      serverUrl: 'https://byok.test',
      auth,
      getCursor: () => 12,
      onEnvelope: () => undefined,
      onReplayCursorTooOld: terminal,
      retryDelayMs: 1,
      idleDelayMs: 1,
    });
    try {
      client.start();
      await vi.waitFor(() => expect(terminal).toHaveBeenCalledTimes(1));
      expect(terminal).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ReplayCursorTooOldError',
          recoverableFrom: 501,
        }),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      client.stop();
      fetch.mockRestore();
    }
  });

  it('#116 treats the WebSocket cursor_too_old close as terminal and never enters long-poll fallback', async () => {
    const server = await TestServer.start();
    const storeDir = await tmpDir('byok-ws-replay-gap-');
    const auth = new AuthManager({
      serverUrl: server.url,
      store: new DeviceStore(storeDir),
    });
    const record = await auth.pair('pairing-code');
    const connection = new ConnectionManager({
      serverUrl: server.url,
      deviceId: record.deviceId,
      productId: 'test-product',
      capabilities: [],
      runtimes: [],
      auth,
      cursorStore: new CursorStore(storeDir),
      onEnvelope: () => undefined,
      wsFailureThreshold: 1,
      backoff: { baseMs: 1, maxMs: 1, factor: 1 },
    });
    try {
      await connection.start();
      await connection.waitForAck();
      server.socket?.close(1008, 'cursor_too_old');
      await vi.waitFor(() => expect(connection.getTerminalError()).toBeInstanceOf(ReplayCursorTooOldError));
      expect(connection.getTerminalError()).toMatchObject({
        recoverableFrom: undefined,
      });
      expect(connection.getMode()).toBe('ws');
    } finally {
      await connection.stop();
      await auth.stop();
      await server.close();
    }
  });

  it('#121 gives every BlobClient response-body read a deadline with stable typed classification', async () => {
    const client = new BlobClient('https://byok.test', pairedAuth(), {
      requestDeadlineMs: 10,
    });
    let streamCancelled = false;
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ downloadUrl: 'https://objects.test/blob' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockImplementationOnce(async () => {
        return new Response(new ReadableStream<Uint8Array>({
          start: () => undefined,
          cancel: () => {
            streamCancelled = true;
          },
        }), { status: 200 });
      });
    try {
      await expect(
        client.resolveInstruction({
          blobId: 'blob-deadline',
          contentHash: `sha256:${'0'.repeat(64)}`,
          contentType: 'text/plain',
          size: 0,
        }),
      ).rejects.toMatchObject({
        name: 'BlobRequestAbortedError',
        reason: 'deadline',
      });
      await vi.waitFor(() => expect(streamCancelled).toBe(true));
    } finally {
      fetch.mockRestore();
    }
  });

  it('#121 propagates task cancellation through an upload and never finalizes after cancellation', async () => {
    const controller = new AbortController();
    const client = new BlobClient('https://byok.test', pairedAuth(), {
      requestDeadlineMs: 1_000,
    });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            blobId: 'blob-cancelled',
            uploadUrl: 'https://objects.test/blob',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockImplementationOnce(async () => new Promise<Response>(() => {}));
    try {
      const upload = client.uploadArtifact('payload', 'text/plain', {
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      controller.abort();
      await expect(upload).rejects.toMatchObject({
        name: 'BlobRequestAbortedError',
        reason: 'cancelled',
      });
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/finalize'))).toBe(false);
    } finally {
      fetch.mockRestore();
    }
  });
});
