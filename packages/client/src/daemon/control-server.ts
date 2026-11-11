import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import { atomicWriteFile } from '../util/atomic-write.js';
import { ensureSecureStoreRoot } from '../util/secure-dir.js';
import { listenPrivateUnixSocket, PrivateSocketInUseError, reclaimPrivateSocketFallbackDirectory } from '../util/private-unix-socket.js';
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
} from './control-protocol.js';

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

/** A single authenticated control connection must never retain more outbound application bytes than this. */
const MAX_OUTBOUND_QUEUE_BYTES = 1024 * 1024;

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
  /**
   * Stops accepting new connections and destroys every open one. The runtime
   * removes the Unix socket while closing its listener; the token remains.
   * Idempotent, and the first half of {@link close}.
   *
   * Split out from `close()` for `create-daemon.ts`'s shutdown sequence
   * (plan `shutdown-lease-order`): the socket/token files ARE this daemon's
   * only external liveness signal (`isControlDaemonGone` in
   * `daemon/control-client.ts` reads "token file gone AND a connect refused"),
   * so a shutdown must be able to stop serving RPCs, release its
   * store-mutation lease, and only THEN publish "gone" by removing the
   * files. Between the two stages a connect is already refused while the
   * token file still exists — which reads as "still running", the
   * conservative answer, rather than as "exited while still holding the
   * lease". The token is therefore the part of the liveness signal that
   * bridges listener close and lease release; preserving the socket file is
   * neither required nor provided by the runtime.
   */
  stopServing(): Promise<void>;
  /** Runs {@link stopServing}, then removes this server's token and reclaims an empty socket fallback directory. Idempotent. */
  close(): Promise<void>;
  /**
   * Replaces the method table on this same listener and token. Every later
   * request uses it, on connections already authenticated as well as new
   * ones. Changing what a running daemon serves never closes the endpoint,
   * so the liveness signal never reads "gone" while this daemon still holds
   * its store lease (service enrollment's handover to normal startup).
   */
  setMethods(methods: ControlMethods): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toControlErrorShape(err: unknown): ControlErrorShape {
  if (err instanceof ControlError) return { code: err.code, message: err.message };
  return { code: 'internal_error', message: errorMessage(err) };
}

async function bindControlEndpoint(server: net.Server, endpoint: string): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      await listenPrivateUnixSocket(server, endpoint);
    } catch (error) {
      if (error instanceof PrivateSocketInUseError) throw new AnotherControlServerRunningError(endpoint);
      throw error;
    }
    return;
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
  methods: () => ControlMethods,
  handshakeTimeoutMs: number,
  onHandshakeSettled: () => void,
): void {
  const reader = new NdjsonLineReader();
  type ActiveRequest =
    | { kind: 'unary' }
    | { kind: 'stream'; controller: AbortController };
  const activeRequests = new Map<string, ActiveRequest>();
  let phase: 'client-hello' | 'client-auth' | 'ready' = 'client-hello';
  let serverNonce = '';
  let destroyed = false;
  let handshakeSettled = false;
  let disposeOutboundWriter: (() => void) | undefined;

  function settleHandshake(): void {
    if (handshakeSettled) return;
    handshakeSettled = true;
    onHandshakeSettled();
  }

  const handshakeTimer = setTimeout(() => {
    if (phase !== 'ready') socket.destroy();
  }, handshakeTimeoutMs);
  handshakeTimer.unref?.();

  function terminateConnection(): void {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(handshakeTimer);
    settleHandshake();
    disposeOutboundWriter?.();
    const requests = [...activeRequests.values()];
    activeRequests.clear();
    for (const request of requests) {
      if (request.kind === 'stream' && !request.controller.signal.aborted) request.controller.abort();
    }
    if (!socket.destroyed) socket.destroy();
  }

  type QueuedFrame = { encoded: string; bytes: number };
  const queuedFrames: QueuedFrame[] = [];
  let queuedBytes = 0;
  let blocked = false;
  let terminal = false;
  let drainListening = false;

  function disposeQueuedFrames(): void {
    terminal = true;
    blocked = false;
    queuedFrames.length = 0;
    queuedBytes = 0;
    if (drainListening) {
      socket.removeListener('drain', onDrain);
      drainListening = false;
    }
  }

  function waitForDrain(): void {
    if (drainListening || terminal) return;
    drainListening = true;
    socket.once('drain', onDrain);
  }

  function writeEncodedFrame(encoded: string): void {
    if (terminal) return;
    if (!socket.writable) {
      terminateConnection();
      return;
    }
    try {
      if (!socket.write(encoded)) {
        blocked = true;
        waitForDrain();
      }
    } catch {
      terminateConnection();
    }
  }

  function onDrain(): void {
    drainListening = false;
    if (terminal) return;
    blocked = false;
    while (!blocked && queuedFrames.length > 0) {
      const frame = queuedFrames.shift()!;
      queuedBytes -= frame.bytes;
      writeEncodedFrame(frame.encoded);
    }
  }

  disposeOutboundWriter = disposeQueuedFrames;

  function sendFrame(frame: unknown): void {
    if (destroyed || terminal) return;
    const encoded = encodeFrame(frame);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_OUTBOUND_QUEUE_BYTES) {
      terminateConnection();
      return;
    }
    if (blocked) {
      if (queuedBytes + bytes > MAX_OUTBOUND_QUEUE_BYTES) {
        terminateConnection();
        return;
      }
      queuedFrames.push({ encoded, bytes });
      queuedBytes += bytes;
      return;
    }
    writeEncodedFrame(encoded);
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

  function rejectDuplicateRequest(id: string): void {
    sendFrame({
      v: 1,
      id,
      ok: false,
      error: { code: 'duplicate_request_id', message: `request id "${id}" is already active` },
    });
  }

  function registerRequest(id: string, record: ActiveRequest): boolean {
    if (activeRequests.has(id)) {
      rejectDuplicateRequest(id);
      return false;
    }
    activeRequests.set(id, record);
    return true;
  }

  function releaseRequest(id: string, record: ActiveRequest): boolean {
    if (activeRequests.get(id) !== record) return false;
    activeRequests.delete(id);
    return true;
  }

  function dispatch(id: string, method: string, params: unknown): void {
    const { unary: unaryMethods, stream: streamMethods } = methods();
    const unary = unaryMethods[method];
    if (unary) {
      const record: ActiveRequest = { kind: 'unary' };
      if (!registerRequest(id, record)) return;
      Promise.resolve()
        .then(() => unary(params))
        .then((result) => {
          if (!releaseRequest(id, record)) return;
          sendFrame({ v: 1, id, ok: true, result });
        })
        .catch((err: unknown) => {
          if (!releaseRequest(id, record)) return;
          sendFrame({ v: 1, id, ok: false, error: toControlErrorShape(err) });
        });
      return;
    }
    const stream = streamMethods[method];
    if (stream) {
      const controller = new AbortController();
      const record: ActiveRequest = { kind: 'stream', controller };
      if (!registerRequest(id, record)) return;
      Promise.resolve()
        .then(() => stream(params, { emit: (event) => sendFrame({ v: 1, id, event }), signal: controller.signal }))
        .then(() => {
          if (!releaseRequest(id, record)) return;
          if (!controller.signal.aborted) sendFrame({ v: 1, id, ok: true, done: true });
        })
        .catch((err: unknown) => {
          if (!releaseRequest(id, record)) return;
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
    // A write/reset error is terminal for this connection. Swallow it here
    // so it never becomes an unhandled EventEmitter error, but immediately
    // release queued output and abort active stream producers.
    terminateConnection();
  });
  socket.on('close', () => {
    terminateConnection(); // also handles pre-handshake close and drops a queued pre-drain burst
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
  // Finding F7: on win32, ALSO applies a restrictive DACL via `icacls` —
  // POSIX modes (the `{mode: 0o700}` this replaces) restrict nothing there.
  // See `util/secure-dir.ts`'s own doc comment; `control.token` (written
  // below, once the bind succeeds) inherits this directory's ACL.
  await ensureSecureStoreRoot(opts.storeDir);

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
  let methods = opts.methods;
  const server = net.createServer((socket) => {
    if (halfOpenCount >= maxHalfOpenConnections) {
      socket.destroy();
      return;
    }
    halfOpenCount += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handleConnection(socket, token, () => methods, handshakeTimeoutMs, () => {
      halfOpenCount -= 1;
    });
  });

  await bindControlEndpoint(server, endpoint); // throws without ever touching the token file — see doc comment above

  try {
    await atomicWriteFile(tokenPath, token, { mode: 0o600 });
  } catch (err) {
    // Finding F9 (cross-model adversarial review): the bind just above
    // already succeeded — `server` is actively listening on `endpoint`. A
    // token-write failure (disk full, storeDir removed out from under this
    // call, a permission change mid-flight) used to propagate straight out
    // of this function without ever tearing that listener down: the caller
    // never gets a `ControlServerHandle` to `close()` (the throw happens
    // before this function ever returns one — see `create-daemon.ts`'s own
    // "continuing without it" degrade path, which only ever sees the
    // exception, never the live socket underneath it), so the listener was
    // silently ORPHANED — unreachable for the rest of the process's
    // lifetime, and blocking every future bind attempt at this exact
    // `endpoint` with `EADDRINUSE`/{@link AnotherControlServerRunningError}
    // (e.g. a later retry, or this same daemon's next `start()`) even
    // though nothing valid is actually listening behind it anymore in any
    // useful sense (its token was never written, so no client could ever
    // complete a handshake against it either). `atomicWriteFile` itself
    // already guarantees `tokenPath` was never created/left partial on
    // failure (its own temp-file-only cleanup — see `util/atomic-write.ts`),
    // so there is nothing to unwind on that side; only the listener this
    // function itself just stood up needs tearing down before rethrowing.
    // Mirrors `close()`'s teardown below: destroy connections, close the
    // listener (which removes its Unix socket), and reclaim an empty fallback
    // directory.
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Runtime close removes the Unix socket synchronously. Never unlink this
    // pathname afterward: a successor may already have bound it before the
    // close callback resumes us, including on a failed token publication.
    if (process.platform !== 'win32') {
      await reclaimPrivateSocketFallbackDirectory(endpoint);
    }
    throw err;
  }

  // Memoized rather than boolean-latched so a `close()` racing an in-flight
  // `stopServing()` awaits the SAME teardown instead of returning while the
  // listener is still going down under it — the file removal below must
  // never overtake the listener close it is supposed to follow.
  let stopServingPromise: Promise<void> | undefined;
  async function stopServing(): Promise<void> {
    stopServingPromise ??= (async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })();
    await stopServingPromise;
  }

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await stopServing();
    // Node and Bun remove the Unix pathname as part of listener close, before
    // its callback. Retaining a second pathname-based unlink here would let
    // this old handle delete a successor bound after stopServing().
    // Reclaim only the empty fallback directory; rmdir preserves a successor's
    // socket (and therefore its nonempty parent directory).
    if (process.platform !== 'win32') {
      await reclaimPrivateSocketFallbackDirectory(endpoint);
    }
    // Lease release precedes this stage of daemon shutdown. A successor can
    // already have published its own token, which this handle must preserve.
    // The read/unlink pair is not atomic; see the decision on issue #1610.
    const currentToken = await fs.readFile(tokenPath, 'utf8').catch(() => undefined);
    if (currentToken === token) {
      await fs.rm(tokenPath, { force: true }).catch(() => {});
    }
  }

  return {
    endpoint,
    stopServing,
    close,
    setMethods: (next) => {
      methods = next;
    },
  };
}
