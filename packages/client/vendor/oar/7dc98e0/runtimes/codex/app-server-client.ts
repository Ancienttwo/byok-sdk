// BYOK change: Modified from OAR 7dc98e0 for injected processes, bounded RPCs and server replies (Apache-2.0).
// BYOK change: The caller owns process creation and must enforce bounded kill/exited semantics.
export interface LineProcess {
  readonly spawned: Promise<void>;
  readonly exited: Promise<number | null>;
  onLine(handler: (line: string) => void): void;
  onExit(handler: (code: number | null) => void): void;
  write(text: string): void;
  writeAcknowledged(text: string): Promise<void>; // BYOK change: native reply write receipt.
  kill(): void;
  exitError?(): Error; // BYOK change: bounded transport diagnostic, never used as a semantic classifier.
}
export type SpawnLineProcess = (
  command: string,
  args: readonly string[],
  options: { readonly env: Readonly<Record<string, string>>; readonly cwd?: string },
) => LineProcess;
// BYOK change: Count limits bound registration buffering and concurrent RPC state.
export interface AppServerLimits {
  readonly maxHeld?: number;
  readonly maxPending?: number;
}
// BYOK change: Typed timeout lets control record rejection independently of its reply mapper.
export class RpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`app-server ${method} timed out after ${timeoutMs}ms`);
    this.name = "RpcTimeoutError";
  }
}
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
import { redactError } from "../../shared/mcp-servers.js";
// BYOK change: Keep startup synchronous at the injected spawn seam; do not use the upstream queued-client wrapper.
// BYOK change: Use caller-owned exitError diagnostics instead of shared/executable processFailure.
// BYOK change: The injected LineProcess has no resources reader, so the client omits upstream `resources`.

/**
 * Minimal persistent JSON-RPC client over codex app-server's stdio JSONL
 * transport. Local to the codex runtime until a second consumer earns a
 * shared promotion; process mechanics are injected by the caller. // BYOK change
 */
/** How a request settled, delivered synchronously as the reply line is read. */
export type RpcOutcome =
  | { readonly kind: "result"; readonly result: JsonRecord }
  | { readonly kind: "error"; readonly error: Error; readonly native?: JsonRecord }
  | { readonly kind: "exited"; readonly error: Error };

export interface AppServerHandlers {
  readonly onNotification: (method: string, params: JsonRecord) => void;
  // BYOK change: JSON-RPC server ids retain their original wire type.
  readonly onServerRequest: (id: number | string, method: string, params: JsonRecord) => void;
}

export interface AppServerClient {
  readonly spawned: Promise<void>;
  readonly exited: Promise<number | null>;
  /**
   * Send a request. `onSettled`, when given, runs SYNCHRONOUSLY at the moment
   * the reply line (or the exit) is processed, before any later line in the
   * same chunk, so a caller can record the reply in stream order; the
   * returned promise settles afterwards, on the microtask queue.
   */
  request(method: string, params: JsonRecord, onSettled?: (outcome: RpcOutcome) => void, timeoutMs?: number): Promise<JsonRecord>; // BYOK change: optional per-request deadline (default 30s).
  notify(method: string, params: JsonRecord): void;
  // BYOK change: Answer server requests without coercing their ids.
  respond(id: number | string, result: unknown): Promise<void>;
  rejectRequest(id: number | string, code: number, message: string): Promise<void>;
  /**
   * Register the inbound handlers, once. Notifications and server-initiated
   * requests (frames with both `id` and `method`: approvals, user input,
   * dynamic tools; BYOK change: caller answers through respond/rejectRequest)
   * that arrive before this
   * call (the app-server talks right after `initialize`, before the thread
   * exists) are held in ONE queue and delivered here synchronously, in wire
   * order across both kinds: nothing the server said is lost or reordered
   * by registration timing.
   */
  handle(handlers: AppServerHandlers): void;
  /**
   * Place a callback in wire order: while frames are still being held (before
   * `handle`) it joins the held queue and runs at flush, after every frame
   * read before it and before every frame read after; once released it runs
   * immediately. Called from a request's synchronous `onSettled`, it pins a
   * record exactly where the reply sat on the wire.
   */
  mark(callback: () => void): void;
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
}

interface Pending {
  resolve(result: JsonRecord): void;
  reject(error: Error): void;
  settled(outcome: RpcOutcome): void;
  timer?: ReturnType<typeof setTimeout>; // BYOK change: cleared on every settlement path.
}

/** How the app-server process is handled. BYOK change: the caller's spawn owns stderr and the process tree. */
export interface AppServerProcessOptions {
  /** Applied to the text of every error the client reports (codex's error message, the exit's stderr tail): a session's MCP credentials must never reach one. */
  readonly redact?: (text: string) => string;
  /** The host's own `app-server` arguments (SessionOptions.launchArgs), unchecked, after oar's `-c` overrides and before `--listen`. */
  readonly launchArgs?: readonly string[];
}

export function startAppServerClient(
  spawnLineProcess: SpawnLineProcess, // BYOK change: no second process manager.
  command: string,
  env: Readonly<Record<string, string>>, // BYOK change: explicit filtered environment required.
  configOverrides: Readonly<Record<string, string>> = {},
  cwd?: string,
  limits: AppServerLimits = {}, // BYOK change: conservative count defaults, configurable by the caller.
  processOptions: AppServerProcessOptions = {},
): AppServerClient {
  // BYOK change: Reject invalid budgets before any process side effect.
  const maxHeld = limits.maxHeld ?? 256;
  const maxPending = limits.maxPending ?? 128;
  for (const value of [maxHeld, maxPending]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("app-server limits must be positive safe integers");
  }
  // -c KEY=VALUE injects config at launch, for every thread of this process
  // (session.ts sets sandbox_mode this way). thread/start can also set the
  // sandbox per thread, but its field is `sandbox`: an unknown field such as
  // `sandboxMode` is ignored without an error.
  const overrideArgs = Object.entries(configOverrides).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  const launchArgs = processOptions.launchArgs ?? [];
  const child = spawnLineProcess(
    command,
    ["app-server", ...overrideArgs, ...launchArgs, "--listen", "stdio://"],
    // BYOK change: upstream killTree is not passed. The caller-owned spawn owns tree termination.
    { ...(cwd === undefined ? {} : { cwd }), env }, // BYOK change: preserve filtered env verbatim.
  );
  // Session initialization observes spawn failures through its pending RPC.
  // Mark this parallel promise handled while preserving its rejection for
  // callers that explicitly await spawned.
  // oxlint-disable-next-line promise/prefer-await-to-then -- client construction remains synchronous
  void child.spawned.catch(() => {});
  const pending = new Map<number, Pending>();
  // Inbound frames and marks share one queue until `handle` registers the
  // handlers, so their relative order is the wire's whatever kind they are.
  const held: ((handlers: AppServerHandlers) => void)[] = [];
  let handlers: AppServerHandlers | null = null;
  // BYOK change: A sticky failure clears both budgets and rejects work even if kill has not exited yet.
  let terminalError: Error | null = null;
  // BYOK change: An exit or a kill settles as upstream's exited outcome; a local budget failure stays an error.
  let terminalOutcome: "error" | "exited" = "error";
  const fail = (error: Error, terminate: boolean, outcome: "error" | "exited" = "error"): void => {
    if (terminalError !== null) return;
    terminalError = error;
    terminalOutcome = outcome;
    held.length = 0;
    const waiters = [...pending.values()];
    pending.clear();
    // BYOK change: Release every waiter before user callbacks can throw or re-enter.
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    if (terminate) child.kill();
    for (const waiter of waiters) waiter.settled({ kind: outcome, error });
  };
  const deliver = (delivery: (handlers: AppServerHandlers) => void): void => {
    // BYOK change: Overflow is visible and fatal; no silently dropped frames or marks.
    if (terminalError !== null) throw terminalError;
    if (handlers === null) {
      if (held.length >= maxHeld) {
        const error = new Error(`app-server held limit exceeded (${maxHeld})`);
        fail(error, true);
        throw error;
      }
      held.push(delivery);
    } else {
      delivery(handlers);
    }
  };
  let nextId = 1;
  const redact = processOptions.redact ?? ((text: string): string => text);

  child.onLine((line) => {
    if (terminalError !== null) return; // BYOK change: ignore frames after terminal failure.
    const message = asRecord(parseJson(line));
    if (message === null) {
      return;
    }
    const hasId = typeof message.id === "number" || typeof message.id === "string";
    if (typeof message.method === "string") {
      const params = asRecord(message.params) ?? {};
      const { method } = message;
      if (hasId) {
        const id = message.id as number | string; // BYOK change: preserve the validated original id.
        deliver((target) => {
          target.onServerRequest(id, method, params);
        });
      } else {
        deliver((target) => {
          target.onNotification(method, params);
        });
      }
      return;
    }
    if (typeof message.id === "number" && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter?.timer); // BYOK change: response wins over the deadline.
      const error = asRecord(message.error);
      if (error !== null) {
        const failure = new Error(redact(typeof error.message === "string" ? error.message : "app-server error"));
        const redacted = JSON.stringify(error, (_key, value: unknown) => typeof value === "string" ? redact(value) : value);
        const native = asRecord(parseJson(redacted));
        // BYOK change: Required settlement failure must reject the promise even after removal from pending.
        try { waiter?.settled({ kind: "error", error: failure, ...(native === null ? {} : { native }) }); }
        catch (error) { waiter?.reject(error instanceof Error ? error : new Error(String(error))); throw error; }
        waiter?.reject(failure);
      } else {
        const result = asRecord(message.result) ?? {};
        // BYOK change: A throwing required consumer cannot strand an already dequeued waiter.
        try { waiter?.settled({ kind: "result", result }); }
        catch (error) { waiter?.reject(error instanceof Error ? error : new Error(String(error))); throw error; }
        waiter?.resolve(result);
      }
    }
  });
  child.onExit(() => {
    // BYOK change: release timers, waiters and held frames on exit; the bounded exit error carries the stderr tail, so it is redacted.
    // The owned transport reports the exit after stdout closed, so no reply can follow it.
    fail(redactError(child.exitError?.() ?? new Error("app-server exited"), redact) as Error, false, "exited");
  });

  return {
    spawned: child.spawned,
    exited: child.exited,
    async request(method, params, onSettled, timeoutMs = 30_000) { // BYOK change: bounded requests by default.
      const settled = onSettled ?? ((): void => {});
      // BYOK change: Validate deadlines and fail the process on pending overflow.
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error(`app-server ${method} timeout must be positive, finite and at most 2147483647ms`);
      if (terminalError === null && pending.size >= maxPending) {
        fail(new Error(`app-server pending limit exceeded (${maxPending})`), true);
      }
      if (terminalError !== null) {
        const error = terminalError;
        settled({ kind: terminalOutcome, error });
        throw error;
      }
      const id = nextId;
      nextId += 1;
      // oxlint-disable-next-line promise/avoid-new -- settlement is driven by the response pump
      const result = await new Promise<JsonRecord>((resolve, reject) => {
        // BYOK change: Install the deadline before write; synchronous fake/real replies can settle immediately.
        const waiter: Pending = { resolve, reject, settled };
        waiter.timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          const error = new RpcTimeoutError(method, timeoutMs);
          // BYOK change: Reject required-consumer failure without an uncaught timer exception.
          try { settled({ kind: "error", error }); }
          catch (consumerError) { reject(consumerError instanceof Error ? consumerError : new Error(String(consumerError))); return; }
          reject(error);
        }, timeoutMs);
        pending.set(id, waiter);
        // BYOK change: A failed write must not leak a pending entry or timer.
        try { child.write(`${JSON.stringify({ id, method, params })}\n`); }
        catch (error) {
          pending.delete(id);
          clearTimeout(waiter.timer);
          const failure = error instanceof Error ? error : new Error(String(error));
          try { settled({ kind: "error", error: failure }); }
          finally { reject(failure); }
        }
      });
      return result;
    },
    notify(method, params) {
      if (terminalError !== null) throw terminalError; // BYOK change: no writes after terminal failure.
      child.write(`${JSON.stringify({ method, params })}\n`);
    },
    // BYOK change: JSON-RPC results and errors echo numeric/string ids unchanged.
    respond(id, result) {
      if (terminalError !== null) throw terminalError;
      return child.writeAcknowledged(`${JSON.stringify({ id, result })}\n`);
    },
    rejectRequest(id, code, message) {
      if (terminalError !== null) throw terminalError;
      return child.writeAcknowledged(`${JSON.stringify({ id, error: { code, message } })}\n`);
    },
    handle(registered) {
      if (terminalError !== null) throw terminalError; // BYOK change: do not replay a failed stream.
      if (handlers !== null) {
        throw new Error("app-server handlers are already registered");
      }
      handlers = registered;
      for (const delivery of held.splice(0)) {
        delivery(registered);
      }
    },
    mark(callback) {
      deliver(() => {
        callback();
      });
    },
    onExit(handler) {
      child.onExit(handler);
    },
    kill() {
      fail(new Error("app-server killed"), true, "exited"); // BYOK change: do not await an exit to release pending state.
    },
  };
}
