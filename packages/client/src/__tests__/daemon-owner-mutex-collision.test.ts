import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, stat } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDaemonOwner, DaemonOwnerActiveError, storeMutexEndpoint } from '../daemon/daemon-owner';

/**
 * The store mutex used to be a listener on a loopback TCP port derived from
 * `sha256(canonicalStoreDir)` into a shared 10000..29999 band, with a 32-step
 * candidate walk. Third-party software holding the derived port — WeChat, VS
 * Code helpers, cloudflared, `ssh -L`; all ACCEPT-then-stay-silent listeners —
 * made the identity probe time out, which is fail-closed, so the store was
 * denied its own lease with no recovery: a hash is deterministic, so `start`
 * and doctor stayed locked out for as long as the squatter ran. It also
 * reddened this suite at random.
 *
 * The lock is now store-scoped (a Unix socket under the storeDir, a named pipe
 * keyed by its hash on win32), so no foreign process shares the namespace at
 * all. These tests hold that fix down from both sides: the old collision must
 * no longer bite (A, D), and nothing that used to be refused may now proceed
 * (B, C).
 */

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const tmpDir = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'byok-mutex-collision-')).then((d) => realpath(d));

/**
 * The ABANDONED port derivation, inlined as a historical fixture — this is the
 * address family a foreign listener used to be able to deny a store from, and
 * the only place the formula still exists. `attempt` walks the old candidate
 * sequence (`STORE_MUTEX_PORT_CANDIDATES` was 32).
 */
function legacyMutexPort(canonicalStoreDir: string, attempt: number): number {
  const digest = createHash('sha256').update(canonicalStoreDir).digest();
  const start = digest.readUInt32BE(0) % 20_000;
  const step = 1 + (digest.readUInt32BE(4) % 19_999);
  return 10_000 + ((start + attempt * step) % 20_000);
}

/**
 * A foreign, non-BYOK loopback listener that ACCEPTS the connection and then
 * stays silent — the ordinary request-response server shape (HTTP, IM clients,
 * IDE helpers, tunnels). Observed live on the machine this was diagnosed on:
 * WeChat holding 127.0.0.1:14013/14016/14019/14022/14023, cloudflared 20241,
 * VS Code helpers 17483/25702/29349, ssh -L 18790 — all ten classified as the
 * old probe's `uncertain`.
 *
 * Resolves `false` when the port could not be taken (something else already
 * holds it), which is a strictly MORE adverse condition for the store, not a
 * reason to skip the assertion.
 */
async function silentForeignListener(port: number): Promise<boolean> {
  const server = createServer((socket) => {
    sockets.push(socket); // never writes, never ends
  });
  servers.push(server);
  return new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(true));
  });
}

/**
 * A stale lock socket FILE — the path still there, its listener gone — can only
 * come from a process that died running no cleanup: libuv unlinks the file on
 * every in-process close path, so a real crash is the only way to produce this
 * condition (same finding, same technique as `control-server.test.ts`'s own
 * stale-socket helper).
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

async function abruptMutexProbe(endpoint: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection(endpoint);
    socket.once('connect', () => {
      // A caller only asking "is this endpoint bound?" needs no response and
      // may close immediately. The holder's identity write must tolerate that
      // ordinary probe lifecycle on every supported transport.
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
}

describe('daemon owner store mutex: a store-scoped lock, immune to foreign listeners', () => {
  it('A: silent foreign listeners across the whole abandoned candidate walk cannot deny this store its lease', async () => {
    const storeDir = await tmpDir();
    // Every address the old derivation would have contended on for THIS store.
    // Under the port design this is the exact condition that threw
    // `DaemonOwnerActiveError` at the first candidate, with no walk.
    for (let attempt = 0; attempt < 32; attempt += 1) await silentForeignListener(legacyMutexPort(storeDir, attempt));

    const lease = await acquireDaemonOwner(storeDir, 'doctor');
    await lease.release();
  }, 60_000);

  it('B: fail-closed is preserved — a second acquire on the SAME store is still refused', async () => {
    const storeDir = await tmpDir();
    const held = await acquireDaemonOwner(storeDir, 'doctor');
    try {
      await expect(acquireDaemonOwner(storeDir, 'doctor')).rejects.toBeInstanceOf(DaemonOwnerActiveError);
    } finally {
      await held.release();
    }
    // And the lease is genuinely reusable once released — a refusal must be
    // about a live holder, never a residue of one.
    await (await acquireDaemonOwner(storeDir, 'doctor')).release();
  }, 60_000);

  it('C: two distinct stores hold their leases concurrently', async () => {
    const [a, b] = [await tmpDir(), await tmpDir()];
    const la = await acquireDaemonOwner(a, 'doctor');
    const lb = await acquireDaemonOwner(b, 'doctor');
    await la.release();
    await lb.release();
  }, 60_000);

  it('E: a storeDir too long to hold the lock still gets a bindable address, and stays fail-closed there', async () => {
    if (process.platform === 'win32') return; // a pipe name has no length branch
    // A storeDir long enough that no address under it fits `sun_path` — the
    // shape `scripts/adapter-task-smoke.mjs` produces under a deep TMPDIR, and
    // the shape that broke CI job 94334133652: the first version of this
    // branch bound under `os.tmpdir()`, which the smoke had pointed INSIDE the
    // same long tree, so the escape hatch was longer than what it escaped
    // (152 bytes vs 126) and `bind()` returned EINVAL.
    const root = await tmpDir();
    let storeDir = root;
    while (Buffer.byteLength(path.join(storeDir, 'mutex.sock'), 'utf8') <= 100) {
      storeDir = path.join(storeDir, 'deeper-store-directory-segment');
    }
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    // The smoke's own topology: TMPDIR pointed inside the very tree that made
    // the natural path too long. Any derivation that reaches for `os.tmpdir()`
    // here produces an address longer than the one it is escaping.
    const original = process.env['TMPDIR'];
    process.env['TMPDIR'] = path.join(storeDir, 'tmp');
    try {
      const endpoint = storeMutexEndpoint(storeDir, createHash('sha256').update(storeDir).digest('hex'));
      expect(Buffer.byteLength(endpoint, 'utf8')).toBeLessThanOrEqual(100);

      const held = await acquireDaemonOwner(storeDir, 'doctor');
      try {
        // The fallback branch must be a real lock, not merely a bindable path.
        await expect(acquireDaemonOwner(storeDir, 'doctor')).rejects.toBeInstanceOf(DaemonOwnerActiveError);
      } finally {
        await held.release();
      }
    } finally {
      if (original === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = original;
    }
  }, 60_000);

  it('F: the lock address never depends on the environment', async () => {
    // `os.tmpdir()` reads TMPDIR/TMP/TEMP. Deriving the lock from it means a
    // daemon under a service manager and a doctor in an operator shell compute
    // DIFFERENT addresses for one store and both acquire it — a silent
    // two-writer window, the one outcome this file must never allow.
    const storeDir = await tmpDir();
    const identity = createHash('sha256').update(storeDir).digest('hex');
    const longStoreDir = path.join(storeDir, 'deeper-store-directory-segment'.repeat(3));
    const longIdentity = createHash('sha256').update(longStoreDir).digest('hex');
    const original = process.env['TMPDIR'];
    try {
      const under = (tmp: string): readonly [string, string] => {
        process.env['TMPDIR'] = tmp;
        return [storeMutexEndpoint(storeDir, identity), storeMutexEndpoint(longStoreDir, longIdentity)] as const;
      };
      const [shortA, longA] = under('/tmp');
      const [shortB, longB] = under(path.join(storeDir, 'a-completely-different-temp-root'));
      expect(shortB).toBe(shortA);
      expect(longB).toBe(longA); // the branch that used to read os.tmpdir()
    } finally {
      if (original === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = original;
    }
  }, 60_000);

  it('D: a lock socket left behind by a crashed holder is reclaimed, not treated as a live one', async () => {
    if (process.platform === 'win32') return; // stale socket FILES only exist on darwin/linux; a pipe leaves nothing behind
    const storeDir = await tmpDir();
    const identity = createHash('sha256').update(storeDir).digest('hex');
    const endpoint = storeMutexEndpoint(storeDir, identity);
    // Store-scoped, never a shared namespace: the address is either inside this
    // store's own directory or, on the long-path branch, in a private fallback
    // directory keyed by this store's own hash.
    expect(path.dirname(endpoint) === storeDir || endpoint.includes(identity.slice(0, 16))).toBe(true);

    await createStaleSocketFile(endpoint);
    await expect(stat(endpoint)).resolves.toBeDefined();

    const lease = await acquireDaemonOwner(storeDir, 'doctor');
    await lease.release();
  }, 60_000);

  it('E: abrupt bound-only probes cannot surface an unhandled peer-reset error from the holder', async () => {
    const storeDir = await tmpDir();
    const identity = createHash('sha256').update(storeDir).digest('hex');
    const endpoint = storeMutexEndpoint(storeDir, identity);
    const held = await acquireDaemonOwner(storeDir, 'doctor');
    try {
      await Promise.all(Array.from({ length: 64 }, () => abruptMutexProbe(endpoint)));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(acquireDaemonOwner(storeDir, 'doctor')).rejects.toBeInstanceOf(DaemonOwnerActiveError);
    } finally {
      await held.release();
    }
  }, 60_000);
});
