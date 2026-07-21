import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectControlClient } from '../bin/control-client';
import {
  computeServerProof,
  CONTROL_PROTOCOL_VERSION,
  controlTokenPath,
  encodeFrame,
  MAX_LINE_BYTES,
  NdjsonLineReader,
  randomNonceHex,
} from '../daemon/control-protocol';

/**
 * P2 re-gate hardening finding: `bin/control-client.ts`'s two `reader.push
 * (chunk)` calls (one inside `connectAndHandshake`'s own handshake-phase
 * `onData`, one inside `createControlClient`'s post-handshake `data`
 * listener) both used to sit OUTSIDE any try/catch. `NdjsonLineReader.push`
 * throws once the still-unterminated remainder exceeds `MAX_LINE_BYTES`
 * (control-protocol.ts) — a hostile or simply broken peer streaming a line
 * with no terminating newline. Uncaught, that exception propagates out of a
 * `net.Socket` `'data'` event listener, which Node does not recover from —
 * it crashes the whole CLI process. These tests drive a REAL
 * `connectControlClient`/`ControlClient` against a hand-rolled fake control
 * SERVER (the mirror image of `control-server.test.ts`'s own raw-client
 * helpers) that completes a genuine, valid handshake using the real
 * exported crypto primitives, then sends a >64KiB unterminated line at each
 * of the two vulnerable points — proving the process survives and the
 * client fails closed (a clean rejection/connection-destroy), never an
 * uncaught exception.
 */

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

type Misbehavior = 'during-handshake' | 'after-ready';

/**
 * A minimal fake control SERVER speaking just enough of the real handshake
 * (using the real `computeServerProof`/`parseClientHello`/`parseClientAuth`
 * primitives, so a REAL `connectControlClient` genuinely accepts it as
 * legitimate) to reach the point under test, then misbehaves:
 * - `'during-handshake'`: after a valid server-hello, replies to the
 *   client's auth frame with a giant unterminated line instead of
 *   `{v:1, ready:true}` — exercises `connectAndHandshake`'s own `onData`.
 * - `'after-ready'`: completes the ENTIRE handshake validly, then sends the
 *   giant unterminated line as the "response" to the client's first real
 *   request — exercises `createControlClient`'s post-handshake `data` listener.
 */
function startFakeMisbehavingServer(endpoint: string, token: string, misbehavior: Misbehavior): Promise<{ close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      const reader = new NdjsonLineReader();
      let phase: 'hello' | 'auth' | 'ready' = 'hello';
      socket.on('error', () => {}); // a destroyed-from-the-client-side socket surfaces here on some platforms
      socket.on('data', (chunk: Buffer) => {
        let lines: string[];
        try {
          lines = reader.push(chunk);
        } catch {
          return; // not what this fake server is testing — just stop reading
        }
        for (const line of lines) {
          const parsed = JSON.parse(line) as { nonce?: string };
          if (phase === 'hello') {
            const clientNonce = parsed.nonce ?? '';
            const serverNonce = randomNonceHex();
            socket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, hello: 'server', proof: computeServerProof(token, clientNonce), nonce: serverNonce }));
            phase = 'auth';
          } else if (phase === 'auth') {
            if (misbehavior === 'during-handshake') {
              // No terminating newline — simulates a broken/hostile peer
              // instead of the expected {v:1, ready:true}.
              socket.write(`x`.repeat(MAX_LINE_BYTES + 4096));
            } else {
              socket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, ready: true }));
              phase = 'ready';
            }
          } else if (phase === 'ready' && misbehavior === 'after-ready') {
            // A real request frame arrived post-handshake — "respond" with
            // a giant unterminated line instead of a well-formed result.
            socket.write(`y`.repeat(MAX_LINE_BYTES + 4096));
          }
        }
      });
    });
    server.once('error', reject);
    server.listen(endpoint, () => resolve({ close: () => server.close() }));
  });
}

describe('control-client: hardening against a misbehaving/hostile control server (P2 re-gate finding)', () => {
  let fakeServer: { close: () => void } | undefined;

  afterEach(() => {
    fakeServer?.close();
    fakeServer = undefined;
  });

  it('a >64KiB unterminated line arriving DURING the handshake fails the connect attempt cleanly instead of crashing the process', async () => {
    const storeDir = await tmpDir('byok-ctl-client-hardening-hs-');
    const token = 'a'.repeat(64);
    await fs.writeFile(controlTokenPath(storeDir), token, { mode: 0o600 });
    const endpoint = path.join(storeDir, 'control.sock');
    fakeServer = await startFakeMisbehavingServer(endpoint, token, 'during-handshake');

    const result = await connectControlClient({ storeDir, productId: 'acme' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/daemon control socket not reachable/);
  });

  it('a >64KiB unterminated line arriving AFTER a valid handshake (in place of a request response) destroys the connection cleanly instead of crashing the process', async () => {
    const storeDir = await tmpDir('byok-ctl-client-hardening-post-');
    const token = 'b'.repeat(64);
    await fs.writeFile(controlTokenPath(storeDir), token, { mode: 0o600 });
    const endpoint = path.join(storeDir, 'control.sock');
    fakeServer = await startFakeMisbehavingServer(endpoint, token, 'after-ready');

    const result = await connectControlClient({ storeDir, productId: 'acme' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    // The malformed line arrives as soon as the fake server sees this
    // request frame; the pending call must reject (connection destroyed —
    // see `createControlClient`'s 'close' handler), never hang.
    await expect(result.client.request('status')).rejects.toThrow();
  });
});
