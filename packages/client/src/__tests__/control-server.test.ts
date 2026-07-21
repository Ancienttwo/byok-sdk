import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectControlClient } from '../bin/control-client';
import {
  AnotherControlServerRunningError,
  startControlServer,
  type ControlMethods,
  type ControlServerHandle,
} from '../daemon/control-server';
import {
  CONTROL_PROTOCOL_VERSION,
  computeClientAuth,
  controlSocketPath,
  controlTokenPath,
  encodeFrame,
  NdjsonLineReader,
  randomNonceHex,
} from '../daemon/control-protocol';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function noopMethods(): ControlMethods {
  return { unary: {}, stream: {} };
}

async function readToken(storeDir: string): Promise<string> {
  return (await fs.readFile(controlTokenPath(storeDir), 'utf8')).trim();
}

function connectRaw(endpoint: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForClose(socket: net.Socket, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for socket close')), timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Performs the real client-side handshake against a raw socket, using a possibly-WRONG `auth` value (see `corruptAuth`) — used to prove the SERVER's own auth verification (not just the client's), which `connectControlClient` alone can never exercise (it always sends a correct auth once it has verified the server's proof). */
function handshakeWithAuthOverride(endpoint: string, token: string, corruptAuth: (correct: string) => string): Promise<'ready' | 'rejected'> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    const reader = new NdjsonLineReader();
    const clientNonce = randomNonceHex();
    let phase: 'hello' | 'auth' = 'hello';
    socket.on('error', () => {
      // a destroy from the server surfaces as ECONNRESET here on some platforms — 'close' below is the authoritative signal
    });
    socket.once('connect', () => {
      socket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, hello: 'client', nonce: clientNonce }));
    });
    socket.on('data', (chunk: Buffer) => {
      for (const line of reader.push(chunk)) {
        const parsed = JSON.parse(line) as { nonce: string };
        if (phase === 'hello') {
          const correctAuth = computeClientAuth(token, parsed.nonce);
          socket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, auth: corruptAuth(correctAuth) }));
          phase = 'auth';
        } else {
          resolve('ready');
        }
      }
    });
    socket.once('close', () => resolve('rejected'));
  });
}

/** Raw handshake using the CORRECT token/auth throughout, leaving the socket ready for hand-written request frames — used for the RPC-dispatch tests below (`unknown_method`/`bad_version`), which need to control `v` on the wire, something `connectControlClient` never does (it always sends the current protocol version). */
async function rawConnectAndHandshake(endpoint: string, token: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const reader = new NdjsonLineReader();
    const clientNonce = randomNonceHex();
    let phase: 'hello' | 'auth' = 'hello';

    function onData(chunk: Buffer): void {
      for (const line of reader.push(chunk)) {
        const parsed = JSON.parse(line) as { nonce: string };
        if (phase === 'hello') {
          socket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, auth: computeClientAuth(token, parsed.nonce) }));
          phase = 'auth';
        } else {
          socket.removeListener('data', onData);
          socket.removeListener('error', onError);
          resolve(socket);
          return;
        }
      }
    }
    function onError(err: unknown): void {
      reject(err instanceof Error ? err : new Error(String(err)));
    }

    socket.once('error', onError);
    socket.once('connect', () => {
      socket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, hello: 'client', nonce: clientNonce }));
      socket.on('data', onData);
    });
  });
}

/** Reads subsequent NDJSON frames off an already-handshaken raw socket, one at a time, in arrival order. */
function frameStream(socket: net.Socket): { next(): Promise<Record<string, unknown>> } {
  const reader = new NdjsonLineReader();
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  socket.on('data', (chunk: Buffer) => {
    for (const line of reader.push(chunk)) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(parsed);
      else queue.push(parsed);
    }
  });
  return {
    next(): Promise<Record<string, unknown>> {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/**
 * A genuinely stale Unix socket file (a listener that's gone, but the path
 * still exists) can only happen from a process that dies WITHOUT running
 * any cleanup — Node's own `net.Server.close()` (even via a raw
 * `_handle.close()` in the SAME process) always unlinks the socket file
 * itself as part of the underlying libuv pipe handle's own close path
 * (empirically confirmed while writing this test — there is no in-process
 * way to leave the file behind). A real crash is the only way to produce
 * this, so this spawns a genuine child process that starts listening, then
 * SIGKILLs it — no cleanup code in the child ever gets a chance to run,
 * leaving exactly the stale-file condition `control-server.ts`'s
 * `handleStaleUnixSocket` exists for.
 */
async function createStaleSocketFile(socketPath: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ['-e', `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => process.send('listening'));`],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  await new Promise<void>((resolve, reject) => {
    child.once('message', (msg) => {
      if (msg === 'listening') resolve();
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`stale-socket helper child exited early with code ${code}`)));
  });
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

describe('control-server: handshake', () => {
  let handle: ControlServerHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('a correct handshake succeeds and a request round-trips', async () => {
    const storeDir = await tmpDir('byok-ctl-handshake-');
    handle = await startControlServer({ storeDir, productId: 'acme', methods: { unary: { ping: async () => 'pong' }, stream: {} } });

    const conn = await connectControlClient({ storeDir, productId: 'acme' });
    expect(conn.ok).toBe(true);
    if (!conn.ok) throw new Error('unreachable');
    await expect(conn.client.request('ping')).resolves.toBe('pong');
    conn.client.close();
  });

  it('a client holding the wrong token fails the handshake (client-side verification of the server proof)', async () => {
    const storeDir = await tmpDir('byok-ctl-wrongtoken-');
    handle = await startControlServer({ storeDir, productId: 'acme', methods: noopMethods() });
    // Overwrite the on-disk token AFTER the server captured its own copy in
    // memory — the client now reads a token that no longer matches what the
    // server actually holds.
    await fs.writeFile(controlTokenPath(storeDir), '0'.repeat(64), 'utf8');

    const conn = await connectControlClient({ storeDir, productId: 'acme' });
    expect(conn.ok).toBe(false);
  });

  it('the server rejects a wrong client auth proof (mutual — not just the client verifying the server)', async () => {
    const storeDir = await tmpDir('byok-ctl-wrongauth-');
    handle = await startControlServer({ storeDir, productId: 'acme', methods: noopMethods() });
    const token = await readToken(storeDir);

    const outcome = await handshakeWithAuthOverride(handle.endpoint, token, () => '0'.repeat(64));
    expect(outcome).toBe('rejected');
  });

  it('a malformed client hello (missing nonce) is rejected — connection closed, never hangs', async () => {
    const storeDir = await tmpDir('byok-ctl-malformed-');
    handle = await startControlServer({ storeDir, productId: 'acme', methods: noopMethods() });

    const socket = await connectRaw(handle.endpoint);
    socket.on('error', () => {});
    socket.write(encodeFrame({ v: 1, hello: 'client' })); // missing nonce
    await waitForClose(socket);
  });

  it('a handshake that never completes is closed once the timeout elapses', async () => {
    const storeDir = await tmpDir('byok-ctl-timeout-');
    handle = await startControlServer({ storeDir, productId: 'acme', methods: noopMethods(), handshakeTimeoutMs: 50 });

    const socket = await connectRaw(handle.endpoint);
    socket.on('error', () => {});
    // Deliberately send nothing at all.
    await waitForClose(socket, 2000);
  });
});

describe('control-server: RPC dispatch', () => {
  let handle: ControlServerHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('an unknown method fails closed with {ok:false, error:{code:"unknown_method"}}', async () => {
    const storeDir = await tmpDir('byok-ctl-unknown-');
    handle = await startControlServer({ storeDir, productId: 'acme', methods: noopMethods() });
    const token = await readToken(storeDir);
    const socket = await rawConnectAndHandshake(handle.endpoint, token);
    const frames = frameStream(socket);

    socket.write(encodeFrame({ v: 1, id: 'req-1', method: 'no.such.method' }));
    const response = await frames.next();

    expect(response).toMatchObject({ v: 1, id: 'req-1', ok: false, error: { code: 'unknown_method' } });
    socket.destroy();
  });

  it('a request naming an unsupported protocol version fails closed with {ok:false, error:{code:"bad_version"}} rather than being guessed at', async () => {
    const storeDir = await tmpDir('byok-ctl-badversion-');
    handle = await startControlServer({ storeDir, productId: 'acme', methods: { unary: { status: async () => ({}) }, stream: {} } });
    const token = await readToken(storeDir);
    const socket = await rawConnectAndHandshake(handle.endpoint, token);
    const frames = frameStream(socket);

    socket.write(encodeFrame({ v: 2, id: 'req-1', method: 'status' }));
    const response = await frames.next();

    expect(response).toMatchObject({ v: 1, id: 'req-1', ok: false, error: { code: 'bad_version' } });
    socket.destroy();
  });

  it('a handler that throws a plain Error surfaces as {ok:false, error:{code:"internal_error"}}', async () => {
    const storeDir = await tmpDir('byok-ctl-internalerror-');
    handle = await startControlServer({
      storeDir,
      productId: 'acme',
      methods: {
        unary: {
          boom: async () => {
            throw new Error('kaboom');
          },
        },
        stream: {},
      },
    });
    const conn = await connectControlClient({ storeDir, productId: 'acme' });
    if (!conn.ok) throw new Error('expected reachable');

    await expect(conn.client.request('boom')).rejects.toMatchObject({ code: 'internal_error', message: expect.stringContaining('kaboom') });
    conn.client.close();
  });

  it('supports multiple independent concurrent connections against the same server', async () => {
    const storeDir = await tmpDir('byok-ctl-concurrent-');
    let counter = 0;
    handle = await startControlServer({
      storeDir,
      productId: 'acme',
      methods: { unary: { next: async () => ++counter }, stream: {} },
    });

    const [connA, connB] = await Promise.all([
      connectControlClient({ storeDir, productId: 'acme' }),
      connectControlClient({ storeDir, productId: 'acme' }),
    ]);
    if (!connA.ok || !connB.ok) throw new Error('expected both connections to succeed');

    const [a, b] = await Promise.all([connA.client.request<number>('next'), connB.client.request<number>('next')]);
    expect(new Set([a, b]).size).toBe(2); // two independent calls, the shared counter incremented twice

    connA.client.close();
    connB.client.close();
  });

  it('a streaming method emits event frames live and cleans up (aborts) once the client disconnects', async () => {
    const storeDir = await tmpDir('byok-ctl-stream-');
    let aborted = false;
    handle = await startControlServer({
      storeDir,
      productId: 'acme',
      methods: {
        unary: {},
        stream: {
          ticks: (_params, ctx) => {
            ctx.emit({ n: 1 });
            ctx.emit({ n: 2 });
            return new Promise<void>((resolve) => {
              ctx.signal.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  resolve();
                },
                { once: true },
              );
            });
          },
        },
      },
    });

    const conn = await connectControlClient({ storeDir, productId: 'acme' });
    if (!conn.ok) throw new Error('expected reachable');
    const events: unknown[] = [];
    const subscription = conn.client.subscribe('ticks', {}, (event) => events.push(event));

    await vi.waitFor(() => expect(events).toEqual([{ n: 1 }, { n: 2 }]));
    expect(aborted).toBe(false);

    subscription.close();
    await vi.waitFor(() => expect(aborted).toBe(true));
  });
});

describe('control-server: stale socket cleanup + "another daemon running"', () => {
  let handle: ControlServerHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('cleans up a stale (no-listener) Unix socket file left behind by a crashed daemon before binding', async () => {
    if (process.platform === 'win32') return; // stale socket FILES only exist on darwin/linux
    const storeDir = await tmpDir('byok-ctl-stale-');
    await fs.mkdir(storeDir, { recursive: true });
    const socketPath = controlSocketPath(storeDir);

    await createStaleSocketFile(socketPath);
    await expect(fs.stat(socketPath)).resolves.toBeDefined();

    handle = await startControlServer({ storeDir, productId: 'acme', methods: noopMethods() });
    expect(handle.endpoint).toBe(socketPath);

    const conn = await connectControlClient({ storeDir, productId: 'acme' });
    expect(conn.ok).toBe(true);
    if (conn.ok) conn.client.close();
  }, 10000);

  it('throws AnotherControlServerRunningError when a live listener already owns this storeDir\'s endpoint, and leaves the first daemon\'s token untouched', async () => {
    const storeDir = await tmpDir('byok-ctl-running-');
    handle = await startControlServer({ storeDir, productId: 'acme', methods: noopMethods() });
    const originalToken = await readToken(storeDir);

    await expect(startControlServer({ storeDir, productId: 'acme', methods: noopMethods() })).rejects.toBeInstanceOf(
      AnotherControlServerRunningError,
    );

    // The first daemon must still be fully reachable — its token must not
    // have been corrupted or deleted by the second, failed attempt.
    expect(await readToken(storeDir)).toBe(originalToken);
    const conn = await connectControlClient({ storeDir, productId: 'acme' });
    expect(conn.ok).toBe(true);
    if (conn.ok) conn.client.close();
  });
});

describe('control-server: defensive hardening (gatekeeper advisories)', () => {
  let handle: ControlServerHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('the tmpdir long-path fallback socket lives inside a subdirectory that is 0700 BEFORE the socket becomes reachable', async () => {
    if (process.platform === 'win32') return; // Unix file-mode concept only
    const longStoreDir = path.join(await tmpDir('byok-ctl-perms-'), 'x'.repeat(200));
    const socketPath = controlSocketPath(longStoreDir);
    expect(path.dirname(socketPath)).not.toBe(longStoreDir); // confirms this really is the nested-fallback path, not <storeDir>/control.sock

    handle = await startControlServer({ storeDir: longStoreDir, productId: 'acme', methods: noopMethods() });
    expect(handle.endpoint).toBe(socketPath);

    const dirMode = (await fs.stat(path.dirname(socketPath))).mode & 0o777;
    expect(dirMode).toBe(0o700);

    const conn = await connectControlClient({ storeDir: longStoreDir, productId: 'acme' });
    expect(conn.ok).toBe(true);
    if (conn.ok) conn.client.close();
  });

  it('P2 re-gate hardening: refuses to bind when the tmpdir fallback directory is a SYMLINK rather than a real directory (possible attacker-controlled path in a shared temp dir)', async () => {
    if (process.platform === 'win32') return; // Unix symlink/uid concept only
    const longStoreDir = path.join(await tmpDir('byok-ctl-symlink-'), 'x'.repeat(200));
    const socketPath = controlSocketPath(longStoreDir);
    const endpointDir = path.dirname(socketPath);

    // Simulate an attacker pre-creating the exact deterministic byok-<hash>
    // directory name as a symlink to somewhere else, BEFORE this daemon ever
    // starts — mkdir(recursive) never throws on an existing path and never
    // fixes an existing symlink's target, so nothing upstream of the new
    // check would have caught this.
    const attackerTarget = await tmpDir('byok-ctl-symlink-target-');
    await fs.mkdir(path.dirname(endpointDir), { recursive: true });
    await fs.symlink(attackerTarget, endpointDir);

    await expect(startControlServer({ storeDir: longStoreDir, productId: 'acme', methods: noopMethods() })).rejects.toThrow(
      /is a symlink/,
    );

    // Confirms this genuinely never bound inside the attacker's directory.
    expect(await fs.readdir(attackerTarget)).toEqual([]);
  });

  it('P2 re-gate hardening: refuses to bind when the tmpdir fallback directory is owned by a DIFFERENT uid (possible attacker-controlled path in a shared temp dir)', async () => {
    if (process.platform === 'win32') return; // Unix uid concept only
    const longStoreDir = path.join(await tmpDir('byok-ctl-uidmismatch-'), 'x'.repeat(200));
    const socketPath = controlSocketPath(longStoreDir);
    const endpointDir = path.dirname(socketPath);
    const realLstat = fs.lstat;
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (target, ...rest) => {
      const real = await realLstat(target, ...(rest as []));
      if (target === endpointDir) {
        // A directory genuinely owned by someone else — same shape lstat
        // would report, only the uid differs (chmod having already failed
        // silently against it is exactly the pre-fix swallowed case).
        return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { uid: real.uid + 1 });
      }
      return real;
    });

    try {
      await expect(startControlServer({ storeDir: longStoreDir, productId: 'acme', methods: noopMethods() })).rejects.toThrow(
        /owned by uid/,
      );
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it('an NDJSON line exceeding MAX_LINE_BYTES closes the connection (fail-closed), never grows the buffer unbounded', async () => {
    const storeDir = await tmpDir('byok-ctl-maxline-');
    handle = await startControlServer({ storeDir, productId: 'acme', methods: noopMethods() });

    const socket = await connectRaw(handle.endpoint);
    socket.on('error', () => {});
    socket.write(`{"v":1,"hello":"client","nonce":"${'a'.repeat(70 * 1024)}`); // no terminating newline, well over 64 KiB
    await waitForClose(socket, 3000);
  });

  it('caps concurrent half-open (pre-handshake) connections — beyond the cap, a new connection is closed immediately', async () => {
    const storeDir = await tmpDir('byok-ctl-halfopen-');
    handle = await startControlServer({ storeDir, productId: 'acme', methods: noopMethods(), maxHalfOpenConnections: 2 });

    // Two connections that never complete their handshake occupy both slots.
    const stuck1 = await connectRaw(handle.endpoint);
    stuck1.on('error', () => {});
    const stuck2 = await connectRaw(handle.endpoint);
    stuck2.on('error', () => {});

    // A third is over the cap and must be closed immediately, without ever
    // getting a handshake timer of its own.
    const third = await connectRaw(handle.endpoint);
    third.on('error', () => {});
    await waitForClose(third, 2000);

    stuck1.destroy();
    stuck2.destroy();
  });

  it('a slot freed by a settled handshake (success or failure) can be reused by a later connection', async () => {
    const storeDir = await tmpDir('byok-ctl-halfopen-reuse-');
    handle = await startControlServer({ storeDir, productId: 'acme', methods: noopMethods(), maxHalfOpenConnections: 1 });

    // First connection completes its handshake, freeing the one slot.
    const conn = await connectControlClient({ storeDir, productId: 'acme' });
    expect(conn.ok).toBe(true);
    if (conn.ok) conn.client.close();

    // A second connection now must be able to acquire that freed slot and
    // complete its OWN handshake — not be rejected as "over cap".
    const conn2 = await connectControlClient({ storeDir, productId: 'acme' });
    expect(conn2.ok).toBe(true);
    if (conn2.ok) conn2.client.close();
  });
});
