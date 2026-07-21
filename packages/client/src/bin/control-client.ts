import { promises as fs } from 'node:fs';
import net from 'node:net';
import {
  CONTROL_PROTOCOL_VERSION,
  ControlError,
  HANDSHAKE_TIMEOUT_MS,
  NdjsonLineReader,
  computeClientAuth,
  computeServerProof,
  controlEndpointPath,
  controlTokenPath,
  encodeFrame,
  isRecord,
  parseServerHello,
  parseServerReady,
  randomNonceHex,
  timingSafeEqualHex,
} from '../daemon/control-protocol';

/**
 * M4 Phase 2: the CLI-side half of the control socket — connects, performs
 * the mutual HMAC handshake (`../daemon/control-protocol.ts`), and exposes a
 * small `request()`/`subscribe()` surface every rewired command
 * (`status`/`tasks --follow`/`unpair`/`approve`/`reject`) builds on.
 *
 * `connectControlClient` never throws for the ordinary "daemon isn't
 * running" case — it returns a typed `{ok:false, reason}` result instead
 * (see {@link ConnectControlResult}), so a caller can render a clean
 * fallback message rather than catching an exception. Missing
 * `control.token` (the daemon was never started, or was stopped) is by far
 * the most common reason; any other connect/handshake failure collapses
 * into the same shape — a CLI user doesn't need to know WHY the control
 * socket isn't reachable, only that it isn't and a fallback is being used.
 */

export interface ControlClientOptions {
  storeDir: string;
  productId: string;
  /** Default: `HANDSHAKE_TIMEOUT_MS` (3000ms) — matches the server's own handshake timeout. */
  handshakeTimeoutMs?: number;
  /** Default 10000ms — applied per `request()` call; never applied to `subscribe()`, which is expected to stay open indefinitely. */
  requestTimeoutMs?: number;
}

export interface ControlClient {
  /** Sends `{method, params}`, resolves with the server's `result`, or rejects with a {@link ControlError} (or a plain `Error` for a connection-level failure/timeout). */
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Sends a streaming request; `onEvent` fires for each `event` frame. Returns a handle whose `close()` ends the WHOLE connection (per the protocol: "client may just close the connection to unsubscribe") — don't share a client between a `subscribe()` and other concurrent `request()` calls if you need them to outlive each other. */
  subscribe(method: string, params: unknown, onEvent: (event: unknown) => void): { close: () => void };
  /** Closes the underlying connection. Safe to call more than once. */
  close(): void;
}

export type ConnectControlResult = { ok: true; client: ControlClient } | { ok: false; reason: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reads the control token, connects, and performs the handshake — see the module doc comment for why failures here collapse into `{ok:false, reason}` rather than throwing. */
export async function connectControlClient(opts: ControlClientOptions): Promise<ConnectControlResult> {
  const tokenPath = controlTokenPath(opts.storeDir);
  let token: string;
  try {
    token = (await fs.readFile(tokenPath, 'utf8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: 'daemon is not running (no control.token found)' };
    }
    return { ok: false, reason: `could not read the control token: ${errorMessage(err)}` };
  }
  if (!token) {
    return { ok: false, reason: 'control token file is empty' };
  }

  const endpoint = controlEndpointPath(opts.productId, opts.storeDir);
  try {
    const client = await connectAndHandshake(endpoint, token, opts);
    return { ok: true, client };
  } catch (err) {
    return { ok: false, reason: `daemon control socket not reachable: ${errorMessage(err)}` };
  }
}

function connectAndHandshake(endpoint: string, token: string, opts: ControlClientOptions): Promise<ControlClient> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const reader = new NdjsonLineReader();
    let phase: 'server-hello' | 'ready' = 'server-hello';
    let settled = false;
    const clientNonce = randomNonceHex();

    const timer = setTimeout(() => {
      fail(new Error('handshake timed out'));
    }, opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();

    function fail(err: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    }

    function succeed(): void {
      settled = true;
      clearTimeout(timer);
      socket.removeListener('error', onError);
      socket.removeListener('data', onData);
      resolve(createControlClient(socket, reader, opts));
    }

    function onData(chunk: Buffer): void {
      // Hardening finding (P2 re-gate): `reader.push` throws once the
      // still-unterminated remainder exceeds MAX_LINE_BYTES
      // (control-protocol.ts) — a hostile/broken peer sending a >64KiB line
      // with no newline. Uncaught, this would propagate out of the 'data'
      // listener and crash the whole CLI process (Node has no default
      // recovery for an exception thrown inside an EventEmitter callback).
      // Mirrors control-server.ts's own identical guard around its matching
      // `reader.push` call — route into this same handshake's `fail()` path
      // instead, exactly like every other handshake failure here.
      let lines: string[];
      try {
        lines = reader.push(chunk);
      } catch (err) {
        fail(err);
        return;
      }
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          fail(new Error('malformed handshake frame'));
          return;
        }
        if (phase === 'server-hello') {
          const hello = parseServerHello(parsed);
          if (!hello) {
            fail(new Error('malformed or unexpected server hello'));
            return;
          }
          if (!timingSafeEqualHex(hello.proof, computeServerProof(token, clientNonce))) {
            fail(new Error('server failed to prove it holds the control token'));
            return;
          }
          socket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, auth: computeClientAuth(token, hello.nonce) }));
          phase = 'ready';
          continue;
        }
        if (!parseServerReady(parsed)) {
          fail(new Error('server did not confirm readiness'));
          return;
        }
        succeed();
        return;
      }
    }

    function onError(err: unknown): void {
      fail(err);
    }

    socket.once('error', onError);
    socket.once('connect', () => {
      socket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, hello: 'client', nonce: clientNonce }));
      socket.on('data', onData);
    });
  });
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  onEvent?: (event: unknown) => void;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function createControlClient(socket: net.Socket, reader: NdjsonLineReader, opts: ControlClientOptions): ControlClient {
  const pending = new Map<string, PendingCall>();
  let idSeq = 0;
  let closed = false;

  function handleFrame(parsed: unknown): void {
    if (!isRecord(parsed) || typeof parsed.id !== 'string') return;
    const entry = pending.get(parsed.id);
    if (!entry) return;
    if ('event' in parsed) {
      entry.onEvent?.(parsed.event);
      return;
    }
    if (parsed.ok === true) {
      pending.delete(parsed.id);
      entry.resolve(parsed.done === true ? undefined : (parsed as { result?: unknown }).result);
      return;
    }
    pending.delete(parsed.id);
    const shape = (parsed as { error?: { code?: unknown; message?: unknown } }).error;
    entry.reject(
      new ControlError(
        typeof shape?.code === 'string' ? shape.code : 'internal_error',
        typeof shape?.message === 'string' ? shape.message : 'unknown control error',
      ),
    );
  }

  socket.on('data', (chunk: Buffer) => {
    // Same hardening as connectAndHandshake's own onData above: `reader.push`
    // throws on a >64KiB unterminated line (MAX_LINE_BYTES,
    // control-protocol.ts) — uncaught, that would crash this CLI process
    // from inside an EventEmitter 'data' callback. This connection is
    // already past the handshake (there is no `fail()` closure here), so
    // fail closed the same way a malformed/unexpected frame elsewhere in
    // this function already does: destroy the connection (which rejects
    // every pending call via the 'close' handler below) rather than risk
    // continuing to read from a peer that just proved it doesn't speak this
    // protocol.
    let lines: string[];
    try {
      lines = reader.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // ignore a malformed line rather than tearing down an otherwise-healthy connection
      }
      handleFrame(parsed);
    }
  });
  socket.on('close', () => {
    closed = true;
    for (const entry of pending.values()) entry.reject(new Error('control connection closed'));
    pending.clear();
  });
  socket.on('error', () => {
    // 'close' always follows and rejects every pending call above — swallow
    // here so a peer reset never becomes an unhandled 'error' crash.
  });

  function send(method: string, params: unknown, onEvent?: (event: unknown) => void): { id: string; promise: Promise<unknown> } {
    const id = `c${++idSeq}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject, onEvent });
    });
    socket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, id, method, params }));
    return { id, promise };
  }

  return {
    async request<T>(method: string, params?: unknown): Promise<T> {
      if (closed) throw new Error('control connection is closed');
      const { promise } = send(method, params);
      const result = await withTimeout(promise, opts.requestTimeoutMs ?? 10_000, `control request "${method}" timed out`);
      return result as T;
    },
    subscribe(method, params, onEvent) {
      const { id, promise } = send(method, params, onEvent);
      promise.catch(() => {
        // subscribe()'s lifetime is managed via close()/onEvent, not this
        // promise — swallow so destroying the connection later (which
        // rejects every pending call, this one included) never surfaces as
        // an unhandled rejection.
      });
      return {
        close: (): void => {
          pending.delete(id);
          socket.destroy();
        },
      };
    },
    close(): void {
      socket.destroy();
    },
  };
}

/**
 * Unpair's own poll for "has the daemon actually exited yet" (see
 * `bin/commands/unpair.ts`): both the control token file being gone AND a
 * fresh connect attempt being refused, checked directly rather than through
 * a full `connectControlClient` handshake — cheaper per poll, and matches
 * the exact two-condition check the M4 design calls for.
 */
export async function isControlDaemonGone(storeDir: string, productId: string): Promise<boolean> {
  const tokenGone = await fs.stat(controlTokenPath(storeDir)).then(
    () => false,
    (err) => (err as NodeJS.ErrnoException).code === 'ENOENT',
  );
  if (!tokenGone) return false;

  const endpoint = controlEndpointPath(productId, storeDir);
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(endpoint);
    const finish = (gone: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(gone);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', (err: NodeJS.ErrnoException) => finish(err.code === 'ECONNREFUSED' || err.code === 'ENOENT'));
  });
}
