// BYOK change: Modified from OAR 0be506f for injected processes, native-first recording, bounded request refusal and caller-selected sandbox (Apache-2.0).
/* oxlint-disable import/max-dependencies -- The adapter composes protocol, input and process-lifetime mechanisms. */
import type { AvailableInstallation } from "../../contracts/installation.js"; // BYOK change: direct type-only contract import.
import { randomUUID } from "node:crypto";
import type {
  ControlResult,
  InputImage,
  InputOptions,
  RequestRecord,
  AdapterSession,
  SessionOptions,
} from "../../contracts/session.js";
import { createAbortFallback } from "../../shared/abort-fallback.js";
// BYOK change: Image admission is owned by the BYOK caller, not vendored filesystem helpers.
import { asRecord, type JsonRecord } from "../../shared/json.js";
// BYOK change: Return the raw adapter contract without best-effort observer projections.
import { createSessionKernel } from "../../shared/session-kernel.js";
import { startAppServerClient, type RpcOutcome, type SpawnLineProcess } from "./app-server-client.js";
import { CODEX_SETTINGS_REPORT_MS, codexOpenReadback, codexResumeEffortRefusal, codexThreadOpen } from "./open.js";
import {
  foldCodexNotification,
  initialCodexProjection,
  type CodexProjectionState,
} from "./projection.js";
import { openThread, rpcControl, type RpcControlPlan } from "./rpc-control.js";

/*
 * App-server v2: RPC replies answer controls; notifications carry facts.
 * Record replies synchronously, before later notifications in the same chunk.
 * Model/effort read-back and resume overrides live in open.ts. Reachability
 * comes from the recorded exit/dispose, never a separate liveness flag.
 * Native mappings and live evidence: docs/runtimes/codex.md.
 * BYOK change: server requests go to an explicit caller-owned native interaction handler, or are declined/rejected immediately when absent.
 */

/** codex's UserInput: the text, then each image as a `localImage` path codex reads itself (its own composer's order). */
const userInput = (input: string, images: readonly InputImage[] = []): JsonRecord[] =>
  [{ type: "text", text: input }, ...images.map((image) => ({ type: "localImage", path: image.path }))];

interface CodexSessionState {
  /** The prompt request whose turn is running; null while idle or during a spontaneous turn. */
  active: RequestRecord | null;
  /** True while codex runs a root turn we did not prompt (a drained queue submission). */
  spontaneous: boolean;
  /** The runtime's id for the active root turn; steer/abort identity. */
  codexTurnId: string | null;
  projection: CodexProjectionState;
}

// BYOK change: Codex implements steer even though the generic 0.18.0 adapter contract makes it optional.
export interface CodexAdapterSession extends AdapterSession {
  steer(input: string, options?: InputOptions): Promise<ControlResult>;
}

// BYOK change: No production spawn implementation or convenience Session layer is imported here.
export async function codexSession(
  spawnLineProcess: SpawnLineProcess,
  installation: AvailableInstallation,
  options: SessionOptions & {
    readonly approvalPolicy?: "never" | "on-request"; // BYOK change: explicit local interactive opt-in.
    // BYOK change: the caller passes OAR_CODEX_SANDBOX semantics explicitly.
    readonly sandboxMode?: "read-only" | "workspace-write" | "danger-full-access" | "inherit";
  },
  serverRequestTimeoutMs = 1_000,
  hooks: { // BYOK change: required record delivery and retention are injected before registration/replay.
    readonly onReady?: (threadId: string) => void;
    readonly onRecord?: (record: import("../../contracts/session.js").RawEvent) => void;
    readonly maxBytes?: number;
    readonly onLimit?: () => never;
    // BYOK change: caller-owned, bounded native request lifecycle; no permissive fallback.
    readonly onServerRequest?: (id: string | number, method: string, params: JsonRecord, reply: {
      respond(value: JsonRecord): Promise<void>; reject(code: number, message: string): Promise<void>; cancelled(): void;
    }) => void;
  } = {},
): Promise<CodexAdapterSession> {
  if (installation.via !== "executable") {
    throw new Error("The codex session adapter needs an executable installation");
  }
  // Threads persist so a later SessionOptions.resume can reattach; the thread
  // id is the runtime-native identity and becomes Session.id (open.ts builds
  // the request, and refuses what it cannot build before anything starts).
  const { method: openMethod, params: openParams, redact } = codexThreadOpen(options);
  // BYOK change: Explicit environment and caller sandbox; ambient OAR_CODEX_SANDBOX is ignored.
  if (options.env === undefined) throw new Error("codex session requires an explicit filtered environment");
  // YOLO default (repo policy 2026-08-24): bypass the sandbox too, not just
  // approvals. Injected as a launch -c override because that is the only seam
  // that governs codex's exec tool. "inherit" skips the override, so the
  // user's own config wins.
  const sandboxMode = options.sandboxMode ?? "danger-full-access";
  const configOverrides: Record<string, string> = sandboxMode === "inherit" ? {} : { sandbox_mode: `"${sandboxMode}"` };
  if (!Number.isFinite(serverRequestTimeoutMs) || serverRequestTimeoutMs <= 0 || serverRequestTimeoutMs > 2_147_483_647) {
    throw new Error("codex server request timeout must be positive, finite and at most 2147483647ms");
  }
  // Every error the client reports goes through the redactor first: the
  // open's config carries the session's MCP credentials to codex.
  const client = startAppServerClient(spawnLineProcess, installation.command, options.env, configOverrides, options.cwd, undefined, { redact });
  // BYOK change: Ownership/adoption must settle before the first protocol write.
  try {
    await client.spawned;
  await client.request("initialize", {
    clientInfo: { name: "oar", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  });
  } catch (error) {
    client.kill(); // BYOK change: Failed initialization must release the owned process.
    throw error;
  }
  client.notify("initialized", {});
  // The open event is marked at the reply's wire position AS the reply line
  // is read (onSettled → client.mark), not after this await: a frame codex
  // wrote in the same chunk right after the reply (thread/started) would
  // otherwise precede it. The mark runs when the handlers register below,
  // once the kernel exists; a failed open registers none, so it never runs.
  let recordOpen: (() => void) | null = null;
  const markOpen = (outcome: RpcOutcome): void => {
    if (outcome.kind === "result") {
      client.mark(() => recordOpen?.());
    }
  };
  const started = await openThread(client, openMethod, async () => {
    const reply = await client.request(openMethod, openParams, markOpen);
    return reply;
  });
  const threadId = asRecord(started.thread)?.id;
  if (typeof threadId !== "string") {
    client.kill();
    throw new TypeError("codex thread start/resume returned no thread id");
  }
  // The reply is codex's word on the model and effort the thread runs (the
  // open frame's events); anything but what was requested refuses the open.
  // BYOK change: Never advertise an interactive policy the provider did not actually apply.
  if (options.approvalPolicy === "on-request" && started.approvalPolicy !== "on-request") {
    client.kill();
    await client.exited;
    throw new Error("codex native interaction approval policy readback mismatch");
  }
  const readback = codexOpenReadback(openMethod, options, started);
  if (readback.refusal !== null) {
    client.kill();
    await client.exited;
    throw new Error(readback.refusal);
  }

  const kernel = createSessionKernel(threadId, hooks); // BYOK change: budget/required projection before any frame.
  hooks.onReady?.(threadId);
  const state: CodexSessionState = {
    active: null,
    spontaneous: false,
    codexTurnId: null,
    // A resume awaits codex's re-report of the thread's total so far: the
    // baseline this Session's token totals count from (projection.ts, #169).
    projection: initialCodexProjection(threadId, openMethod),
  };
  const busy = (): boolean => state.active !== null || state.spontaneous;
  // BYOK change: The fallback timer never throws. A failed settlement already rejected its control.
  const abortFallback = createAbortFallback(() => { try { client.kill(); } catch { /* surfaced by the rejected control */ } });
  let disposeRequest: RequestRecord | null = null;
  // A resume's effort update in flight: codex's thread/settings/updated answers it.
  let settingsWaiter: ((params: JsonRecord) => void) | null = null;

  recordOpen = (): void => {
    kernel.frame({ type: openMethod, native: started, events: readback.events });
  };
  // Drive the pure projection fold, applying its commands to the kernel; the
  // fold owns event translation, attribution and graph links; this owns the
  // transport-only turn id and the control decisions (busy, spontaneous).
  const onNotification = (method: string, params: JsonRecord): void => {
    // BYOK change: Retain the exact native notification before any potentially throwing fold.
    const notificationSession = typeof params.threadId === "string" ? params.threadId : threadId;
    if (notificationSession !== threadId) kernel.node(notificationSession);
    // BYOK change: Structural extra metadata distinguishes native frames even when derived events are empty.
    const nativeBody = { type: method, native: params, events: [], origin: "byok-native" } as const;
    kernel.frame(nativeBody, {
      sessionId: notificationSession,
      ...(typeof params.turnId === "string" ? { spanId: params.turnId } : {}),
    });
    try {
    const isRoot = typeof params.threadId !== "string" || params.threadId === threadId;
    if (isRoot && method === "turn/started") {
      const startedTurn = asRecord(params.turn)?.id;
      if (!busy()) {
        // A turn we did not prompt (a drained queue submission): adopt it.
        state.spontaneous = true;
      }
      if (typeof startedTurn === "string") {
        state.codexTurnId = startedTurn;
      }
    }
    const { state: nextProjection, commands } = foldCodexNotification(state.projection, method, params);
    state.projection = nextProjection;
    for (const command of commands) {
      switch (command.kind) {
        case "frame":
          if (command.sessionId !== undefined) {
            kernel.node(command.sessionId);
          }
          kernel.frame(command.body, {
            ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
            ...(command.spanId === undefined ? {} : { spanId: command.spanId }),
          });
          break;
        case "link":
          kernel.link(command.edge);
          break;
        default:
          break;
      }
    }
    if (isRoot && method === "turn/completed") {
      abortFallback.clear();
      state.active = null;
      state.spontaneous = false;
      state.codexTurnId = null;
    }
    if (isRoot && method === "thread/settings/updated") {
      settingsWaiter?.(params);
    }
    } catch (error) {
      client.kill(); // BYOK change: A required fold failure is visible and terminates the session.
      throw error;
    }
  };
  // BYOK change: Opted-in native requests use the caller-owned lifecycle; absent opt-in keeps bounded refusal.
  const onServerRequest = (id: number | string, method: string, params: JsonRecord): void => {
    // BYOK change: Record ids follow the kernel string contract; the wire reply echoes the original id.
    const request = kernel.request("toApp", { kind: "native", type: method, native: params }, { id: `native:${typeof id}:${JSON.stringify(id)}` });
    // BYOK change: This injected owner uses NativeInteractionController for deadlines and at-most-once answers.
    if (hooks.onServerRequest !== undefined) {
      let claimed = false;
      let recorded = false;
      const claim = (): void => { if (claimed) throw new Error("codex native request already answered"); claimed = true; };
      const record = (body: import("../../contracts/session.js").ResponseBody): void => {
        if (recorded) return;
        recorded = true; kernel.respond(request.id, body);
      };
      const send = async (write: () => Promise<void>, body: import("../../contracts/session.js").ResponseBody): Promise<void> => {
        claim();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([write(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("codex native reply write deadline exceeded")), serverRequestTimeoutMs);
          })]);
          record(body);
        } catch (error) {
          try { record({ kind: 'rejected', code: 'error', reason: 'native reply transport failed' }); } finally { client.kill(); }
          throw error;
        } finally { clearTimeout(timer); }
      };
      try {
        hooks.onServerRequest(id, method, params, {
          respond: value => send(() => client.respond(id, value), { kind: "accepted" }),
          cancelled() {
            claimed = true; record({ kind: "rejected", code: "error", reason: "native request cancelled" });
          },
          reject: (code, message) => send(() => client.rejectRequest(id, code, message), { kind: "rejected", code: "unsupported", reason: message }),
        });
      } catch (error) { client.kill(); throw error; }
      return;
    }
    let settled = false;
    const finish = (body: import("../../contracts/session.js").ResponseBody): void => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { kernel.respond(request.id, body); } catch { client.kill(); }
    };
    const timer = setTimeout(() => {
      // BYOK change: The deadline timer never throws. A failed settlement already rejected its control.
      try {
        finish({ kind: "rejected", code: "error", reason: `codex ${method} response deadline exceeded` });
        client.kill();
      } catch { /* surfaced by the rejected control */ }
    }, serverRequestTimeoutMs);
    const failed = (error: unknown): void => {
      finish({ kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) });
      client.kill();
    };
    try {
      const written = method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval"
        ? client.respond(id, { decision: "decline" })
        : method === "item/permissions/requestApproval"
          ? client.respond(id, { permissions: {} })
          : client.rejectRequest(id, -32601, `unsupported codex server request: ${method}`);
      void written.then(() => finish({ kind: "rejected", code: "unsupported", reason: `codex ${method} declined by BYOK` }), failed);
    } catch (error) { failed(error); }

  };
  // Registering flushes everything held so far in wire order: the frames
  // from before the thread existed, then the open event (the mark placed at
  // the reply), then whatever codex wrote after the reply.
  client.handle({ onNotification, onServerRequest });
  client.onExit((code) => {
    abortFallback.clear();
    // The exit is an outcome only oar observes: it answers our dispose when
    // we caused it, and stands alone when the app-server died on its own.
    kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code });
    state.active = null;
    state.spontaneous = false;
    state.codexTurnId = null;
  });
  if (readback.resumeEffort !== null) {
    // The resumed thread runs another level: set it on the loaded thread and
    // take codex's pushed settings (a recorded frame) as the word on it.
    const requested = readback.resumeEffort;
    // BYOK change: Equivalent deferred promise under the SDK ES2022 library contract.
    let resolve!: (params: JsonRecord | null) => void;
    const reported = new Promise<JsonRecord | null>((complete) => { resolve = complete; });
    settingsWaiter = resolve;
    const timer = setTimeout(() => {
      resolve(null);
    }, CODEX_SETTINGS_REPORT_MS);
    const update = await client.request("thread/settings/update", { threadId, effort: requested })
      .then(() => null, (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    const refusal = codexResumeEffortRefusal(requested, update, update === null ? await reported : null);
    clearTimeout(timer);
    settingsWaiter = null;
    if (refusal !== null) {
      client.kill();
      await client.exited;
      throw new Error(refusal);
    }
  }

  /** Turn a plan builder into a Session control member. */
  const via = <Args extends unknown[]>(plan: (...args: Args) => RpcControlPlan) =>
    async (...args: Args): Promise<ControlResult> => {
      const result = await rpcControl(kernel, client, plan(...args));
      // BYOK change: Typed RPC timeout bypasses the plan error mapper, so release a refused prompt's slot here.
      if (result.request.body.kind === "prompt" && result.response.body.kind === "rejected" && state.active?.id === result.request.id) {
        state.active = null;
      }
      return result;
    };
  const capabilities = { queue: { durable: true }, attribution: "nested", images: true } as const;
  const promptPlan = (input: string, inputOptions?: InputOptions): RpcControlPlan => ({
    body: { kind: "prompt", input, ...inputOptions },
    gate: (request) => {
      const refused = busy() ? { kind: "rejected", code: "busy", reason: "busy" } as const : null /* BYOK change: caller owns image admission. */;
      if (refused !== null) {
        return refused;
      }
      // Hold the slot while the RPC is in flight so a concurrent prompt is busy.
      state.active = request;
      return null;
    },
    method: "turn/start",
    params: () => ({ threadId, input: userInput(input, inputOptions?.images), clientUserMessageId: inputOptions?.inputId }),
    onReply: (reply) => {
      const turnId = asRecord(reply.turn)?.id;
      if (typeof turnId !== "string") {
        state.active = null;
        return { kind: "rejected", code: "runtime_refused", reason: "codex turn/start returned no turn id", native: reply };
      }
      state.codexTurnId = turnId;
      return { kind: "accepted", native: reply };
    },
    onError: (message) => {
      state.active = null;
      return { kind: "rejected", code: "runtime_refused", reason: message };
    },
  });
  const steerPlan = (input: string, inputOptions?: InputOptions): RpcControlPlan => ({
    body: { kind: "steer", input, ...inputOptions },
    gate: () => (!busy() || state.codexTurnId === null ? { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" } : null /* BYOK change: caller owns image admission. */),
    method: "turn/steer",
    params: () => ({ threadId, input: userInput(input, inputOptions?.images), expectedTurnId: state.codexTurnId, clientUserMessageId: inputOptions?.inputId }),
    onReply: (reply) => ({ kind: "accepted", native: reply }),
    onError: (message) => ({ kind: "rejected", code: "runtime_refused", reason: `not_steerable: ${message}` }),
  });
  // The reply carries the runtime's submission id; it is retained on the response.
  const queuePlan = (input: string, inputOptions?: InputOptions): RpcControlPlan => ({
    body: { kind: "queue", input, ...inputOptions },
    gate: () => null /* BYOK change: caller owns image admission. */,
    method: "thread/queue/add",
    params: () => ({ threadId, input: userInput(input, inputOptions?.images), clientUserMessageId: inputOptions?.inputId ?? randomUUID() }),
    onReply: (reply) => ({ kind: "accepted", native: reply }),
    onError: (message) => ({ kind: "rejected", code: "runtime_refused", reason: message }),
  });
  // An early or late interrupt can be refused; turn/completed is the outcome.
  const abortPlan = (): RpcControlPlan => {
    let refused: (() => void) | null = null;
    return {
      body: { kind: "abort" },
      gate: () => {
        if (!busy() || state.codexTurnId === null) {
          return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
        }
        return null;
      },
      onPending: (accept) => { refused = abortFallback.arm(accept); },
      method: "turn/interrupt",
      params: () => ({ threadId, turnId: state.codexTurnId }),
      onReply: (reply) => ({ kind: "accepted", native: reply }),
      onError: (message) => {
        refused?.();
        return { kind: "rejected", code: "runtime_refused", reason: message };
      },
    };
  };

  const session: CodexAdapterSession = { // BYOK change: raw adapter without sealSession/observe dependencies.
    id: kernel.sessionId,
    capabilities,
    prompt: via(promptPlan),
    steer: via(steerPlan),
    queue: via(queuePlan),
    // No withdraw: the queue is codex's own, and thread/queue/delete is experimental and not live-verified (docs/runtimes/input-cancellation.md).
    abort: via(abortPlan),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    dispose: async () => {
      if (disposeRequest !== null) {
        return;
      }
      const gone = kernel.unreachable() !== null; // only an observed exit can say so before this dispose is recorded
      disposeRequest = kernel.request("toRuntime", { kind: "dispose" });
      if (gone) {
        // The exit is already recorded; nothing is left to release.
        kernel.respond(disposeRequest.id, { kind: "accepted" });
        return;
      }
      client.kill();
      // Await the actual exit: the process may hold state (codex's sqlite
      // runtime in CODEX_HOME) that the next session needs released. The
      // exit response is recorded by onExit.
      await client.exited;
    },
  };
  return session;
}
