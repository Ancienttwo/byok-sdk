import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { atomicWriteFile } from '../util/atomic-write';
import {
  computeClientAuth,
  computeServerProof,
  controlEndpointPath,
  controlTokenPath,
  encodeFrame,
  parseClientAuth,
  parseClientHello,
  parseRawControlRequest,
  randomNonceHex,
  timingSafeEqualHex,
  ControlError,
  HANDSHAKE_TIMEOUT_MS,
  NdjsonLineReader,
  type ControlErrorShape,
} from './control-protocol';

/**
 * M4 Phase 2: the daemon-side local control socket — Unix domain socket
 * (darwin/linux) or Windows named pipe, mutually authenticated by an
 * HMAC handshake over a token that never crosses the wire (see
 * `control-protocol.ts`), speaking a small NDJSON request/response(/event)
 * RPC protocol. Transport-only and daemon-agnostic: `create-daemon.ts`
 * supplies the actual method handlers (`status`, `tasks.subscribe`,
 * `approvals.*`, `shutdown`) as a plain registry — this module knows
 * nothing about `Daemon`/`TaskRunner` internals, which keeps it testable
 * (and reusable) on its own.
 */

export class AnotherControlServerRunningError extends Error {
  constructor(endpoint: string) {
    super(`another daemon's control server appears to already be running at "${endpoint}" — refusing to start a second one`);
    this.name = 'AnotherControlServerRunningError';
  }
}

/** Default cap on simultaneous pre-handshake ("half-open") connections — see `startControlServer`'s own comment on why. */
export const MAX_HALF_OPEN_CONNECTIONS = 8;

export interface ControlMethodContext {
  /** Emits one `event` frame for a streaming method's current request. */
  emit: (event: unknown) => void;
  /** Aborts once the client disconnects — a streaming handler must stop producing events and release whatever it subscribed to. */
  signal: AbortSignal;
}

export type UnaryMethod = (params: unknown) => Promise<unknown> | unknown;
export type StreamMethod = (params: unknown, ctx: ControlMethodContext) => Promise<void>;

export interface ControlMethods {
  unary: Record<string, UnaryMethod>;
  stream: Record<string, StreamMethod>;
}

export interface ControlServerOptions {
  storeDir: string;
  productId: string;
  methods: ControlMethods;
  /** Test-only override — default `HANDSHAKE_TIMEOUT_MS` (3000ms). */
  handshakeTimeoutMs?: number;
  /** Test-only override — default `MAX_HALF_OPEN_CONNECTIONS` (8). */
  maxHalfOpenConnections?: number;
}

export interface ControlServerHandle {
  /** The bound Unix socket path or Windows pipe name. */
  endpoint: string;
  /** Stops accepting new connections, destroys every open one, and removes the socket/token files (a Windows pipe leaves no file to remove). Idempotent. */
  close(): Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toControlErrorShape(err: unknown): ControlErrorShape {
  if (err instanceof ControlError) return { code: err.code, message: err.message };
  return { code: 'internal_error', message: errorMessage(err) };
}

/**
 * Unix-only: a socket FILE left over from a daemon that didn't shut down
 * cleanly (crash, `kill -9`) is otherwise indistinguishable on disk from one
 * a currently-running daemon is actively listening on. Attempts a real
 * connect to tell the two apart:
 *
 * - `ECONNREFUSED` — nothing is listening; the file is stale. Safe to unlink.
 * - A successful connect — a live daemon IS listening; fatal, never unlinked.
 * - Anything else (permission denied, a connect that hangs past the probe
 *   timeout, the path existing but not being a socket at all) — cannot
 *   positively confirm it's stale, so this fails closed exactly like a live
 *   listener (mirrors this repo's `bin/commands/unpair.ts` "unknown state is
 *   unsafe" convention) rather than guessing and risking two daemons racing
 *   the same store.
 */
function probeUnixSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const finish = (alive: boolean): void => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => finish(true), 1000); // no answer within 1s: cannot confirm stale -> fail closed
    socket.once('connect', () => finish(true));
    socket.once('error', (err: NodeJS.ErrnoException) => finish(err.code !== 'ECONNREFUSED'));
  });
}

async function handleStaleUnixSocket(socketPath: string): Promise<void> {
  const exists = await fs.stat(socketPath).then(
    () => true,
    () => false,
  );
  if (!exists) return;
  const alive = await probeUnixSocketAlive(socketPath);
  if (alive) throw new AnotherControlServerRunningError(socketPath);
  await fs.rm(socketPath, { force: true });
}

async function bindControlEndpoint(server: net.Server, endpoint: string): Promise<void> {
  if (process.platform !== 'win32') {
    // Ensure the socket's own parent directory is private BEFORE the
    // socket file itself ever exists — closes the default-perms window on
    // the socket file (see `control-protocol.ts`'s `controlSocketPath` doc
    // comment): a directory's own 0700 mode blocks any OTHER user from even
    // traversing into it, regardless of the socket file's transient mode
    // between `listen()` creating it and the `chmod` below tightening it.
    // A no-op re-assertion for the common (storeDir) case, already 0700 —
    // this only does real work for the tmpdir long-path fallback, whose
    // parent subdirectory doesn't exist yet the first time a given
    // storeDir hits it.
    const endpointDir = path.dirname(endpoint);
    await fs.mkdir(endpointDir, { recursive: true, mode: 0o700 });
    await fs.chmod(endpointDir, 0o700).catch(() => {});
    await handleStaleUnixSocket(endpoint);
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') reject(new AnotherControlServerRunningError(endpoint));
      else reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
  if (process.platform !== 'win32') {
    await fs.chmod(endpoint, 0o600).catch(() => {});
  }
}

/**
 * Per-connection handshake + request-dispatch state machine.
 * `onHandshakeSettled` fires exactly once — either once the handshake
 * actually completes (`phase` reaches `'ready'`) or, if it never does,
 * once the socket closes — so the caller's half-open-connection count
 * (see `MAX_HALF_OPEN_CONNECTIONS`) is always released, never leaked.
 */
function handleConnection(
  socket: net.Socket,
  token: string,
  methods: ControlMethods,
  handshakeTimeoutMs: number,
  onHandshakeSettled: () => void,
): void {
  const reader = new NdjsonLineReader();
  const activeStreams = new Map<string, AbortController>();
  let phase: 'client-hello' | 'client-auth' | 'ready' = 'client-hello';
  let serverNonce = '';
  let destroyed = false;
  let handshakeSettled = false;

  function settleHandshake(): void {
    if (handshakeSettled) return;
    handshakeSettled = true;
    onHandshakeSettled();
  }

  const handshakeTimer = setTimeout(() => {
    if (phase !== 'ready') socket.destroy();
  }, handshakeTimeoutMs);
  handshakeTimer.unref?.();

  function sendFrame(frame: unknown): void {
    if (!destroyed && socket.writable) socket.write(encodeFrame(frame));
  }

  function handleClientHello(parsed: unknown): void {
    const hello = parseClientHello(parsed);
    if (!hello) {
      socket.destroy();
      return;
    }
    serverNonce = randomNonceHex();
    sendFrame({ v: 1, hello: 'server', proof: computeServerProof(token, hello.nonce), nonce: serverNonce });
    phase = 'client-auth';
  }

  function handleClientAuth(parsed: unknown): void {
    const auth = parseClientAuth(parsed);
    if (!auth || !timingSafeEqualHex(auth.auth, computeClientAuth(token, serverNonce))) {
      socket.destroy();
      return;
    }
    clearTimeout(handshakeTimer);
    phase = 'ready';
    settleHandshake();
    sendFrame({ v: 1, ready: true });
  }

  function dispatch(id: string, method: string, params: unknown): void {
    const unary = methods.unary[method];
    if (unary) {
      Promise.resolve()
        .then(() => unary(params))
        .then((result) => sendFrame({ v: 1, id, ok: true, result }))
        .catch((err: unknown) => sendFrame({ v: 1, id, ok: false, error: toControlErrorShape(err) }));
      return;
    }
    const stream = methods.stream[method];
    if (stream) {
      const controller = new AbortController();
      activeStreams.set(id, controller);
      stream(params, { emit: (event) => sendFrame({ v: 1, id, event }), signal: controller.signal })
        .then(() => {
          activeStreams.delete(id);
          if (!controller.signal.aborted) sendFrame({ v: 1, id, ok: true, done: true });
        })
        .catch((err: unknown) => {
          activeStreams.delete(id);
          sendFrame({ v: 1, id, ok: false, error: toControlErrorShape(err) });
        });
      return;
    }
    sendFrame({ v: 1, id, ok: false, error: { code: 'unknown_method', message: `unknown method "${method}"` } });
  }

  function handleRequestLine(parsed: unknown): void {
    const raw = parseRawControlRequest(parsed);
    if (!raw) {
      // Can't even extract an id/method to respond against — fail closed by
      // closing the connection rather than guessing at a shape to reply with.
      socket.destroy();
      return;
    }
    if (raw.v !== 1) {
      sendFrame({ v: 1, id: raw.id, ok: false, error: { code: 'bad_version', message: `unsupported protocol version: ${String(raw.v)}` } });
      return;
    }
    dispatch(raw.id, raw.method, raw.params);
  }

  function handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      socket.destroy();
      return;
    }
    if (phase === 'client-hello') handleClientHello(parsed);
    else if (phase === 'client-auth') handleClientAuth(parsed);
    else handleRequestLine(parsed);
  }

  socket.on('data', (chunk: Buffer) => {
    let lines: string[];
    try {
      lines = reader.push(chunk);
    } catch {
      // MAX_LINE_BYTES exceeded (control-protocol.ts) — fail closed.
      socket.destroy();
      return;
    }
    for (const line of lines) handleLine(line);
  });
  socket.on('error', () => {
    // 'close' always follows and does cleanup below — swallow so a peer
    // reset/EPIPE never becomes an unhandled 'error' crash.
  });
  socket.on('close', () => {
    destroyed = true;
    clearTimeout(handshakeTimer);
    settleHandshake(); // in case it closed (timeout, malformed hello/auth, over-cap) before ever completing
    for (const controller of activeStreams.values()) controller.abort();
    activeStreams.clear();
  });
}

/**
 * Binds the platform endpoint (Unix socket or Windows pipe — see
 * `control-protocol.ts`) FIRST, and only once that succeeds generates and
 * persists a fresh per-session token to `<storeDir>/control.token` (0600).
 * This ordering matters: if a bind fails because ANOTHER daemon's control
 * server already owns this endpoint (see
 * {@link AnotherControlServerRunningError}), that other daemon's own token
 * file must be left completely untouched — writing (and, on failure,
 * deleting) a token before the bind attempt would corrupt or erase the
 * still-running daemon's valid token out from under it.
 *
 * Throws {@link AnotherControlServerRunningError} if a live listener already
 * owns this endpoint (fatal — the caller, `create-daemon.ts`, treats this as
 * a hard startup failure); any OTHER bind failure propagates as a plain
 * `Error` so the caller can decide to degrade instead (the control socket
 * must never be allowed to brick the rest of the daemon).
 */
export async function startControlServer(opts: ControlServerOptions): Promise<ControlServerHandle> {
  await fs.mkdir(opts.storeDir, { recursive: true, mode: 0o700 });
  await fs.chmod(opts.storeDir, 0o700).catch(() => {});

  const token = randomBytes(32).toString('hex'); // in-memory only until the bind below actually succeeds
  const tokenPath = controlTokenPath(opts.storeDir);
  const endpoint = controlEndpointPath(opts.productId, opts.storeDir);
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const sockets = new Set<net.Socket>();
  // Defensive cap against a peer opening many connections and never
  // completing (or slow-drip-ing) the handshake on any of them, tying up
  // resources — beyond this, a new connection is closed immediately rather
  // than given its own handshake timer. Real usage never approaches this
  // (each CLI command opens one connection, uses it briefly, and closes
  // it), so this only ever bites a misbehaving/hostile peer.
  const maxHalfOpenConnections = opts.maxHalfOpenConnections ?? MAX_HALF_OPEN_CONNECTIONS;
  let halfOpenCount = 0;
  const server = net.createServer((socket) => {
    if (halfOpenCount >= maxHalfOpenConnections) {
      socket.destroy();
      return;
    }
    halfOpenCount += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handleConnection(socket, token, opts.methods, handshakeTimeoutMs, () => {
      halfOpenCount -= 1;
    });
  });

  await bindControlEndpoint(server, endpoint); // throws without ever touching the token file — see doc comment above

  await atomicWriteFile(tokenPath, token, { mode: 0o600 });

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') {
      await fs.rm(endpoint, { force: true }).catch(() => {});
    }
    await fs.rm(tokenPath, { force: true }).catch(() => {});
  }

  return { endpoint, close };
}
