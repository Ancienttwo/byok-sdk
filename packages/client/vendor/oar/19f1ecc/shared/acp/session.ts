// BYOK change: Modified from OAR bc1b2ac for injected processes, an explicit environment, a record consumer and session credential redaction without sealSession (Apache-2.0).
/* oxlint-disable import/max-dependencies -- Session assembly wires the environment, process, terminal host, recorder and control machinery. */
/* oxlint-disable typescript/promise-function-async -- SDK callbacks deliberately return the SDK's native promises. */
import type { AvailableInstallation } from "../../contracts/installation.js";
import type {
  AdapterSession,
  ControlResult,
  InputOptions,
  RawEvent,
  RequestBody,
  RequestRecord,
  ResponseBody,
  RuntimeEventBody,
  SessionOptions,
} from "../../contracts/session.js";
// BYOK change: Build the session credential redactor directly; upstream withSessionCredentials imports sealSession.
import { isProjectedToolInput, redactRuntimeRecord, sessionCredentialRedactor, type CredentialRedactor, type CredentialRedactionTail } from "../credential-redactor.js";
import { asRecord, type JsonRecord } from "../json.js";
import { manualCompaction, type CompactionOperation } from "../manual-compaction.js";
import { createSessionKernel } from "../session-kernel.js";
import { createAcpClientApp, type AcpClientHooks } from "./client-app.js";
import {
  acpMcpOpenGuard,
  closeAcpSession,
  createUsageUpdateGate,
  openAcpSession,
  type AcpSessionProfile,
} from "./profile.js";
import { acpLaunchArgs } from "./launch-args.js";
import { startAcpProcess, type SpawnAcpLineProcess } from "./process.js";
import { acpRequestTimeoutError } from "./errors.js";
import { createAcpRecorder } from "./records.js";
import { acpToolProgressOutput, acpToolTerminalContent } from "./projection.js";
import { acpReportedEffort, acpReportedModel } from "./model.js";
import { createAcpTerminalHost, type SpawnAcpTerminal } from "./terminal.js";
import { createAcpTurns, type ActiveTurn } from "./turns.js";
import { acpTakesImages } from "./prompt.js";
import { createAcpTokenUsage } from "./token-usage.js";
import { createAcpOpening, createAcpPromptAnswers, withAcpPromptAnswers } from "./opening.js";
import { createAcpConfigUpdates } from "./config-updates.js";
import { createAcpNativeTurnTracker } from "./native-turns.js";
import { sendAcpSteerRequest } from "./steer-request.js";

export function redactAcpRecord<T extends RawEvent>(
  record: T, credentials: CredentialRedactor, childNotification?: AcpSessionProfile["childNotification"],
  pendingText?: Map<string, CredentialRedactionTail>, pendingToolText?: Map<string, CredentialRedactionTail>, rawToolOutput?: AcpSessionProfile["projectRawToolOutput"],
): T {
  const native = record.kind === "frame" ? asRecord(record.body.native) : null;
  const direct = asRecord(native?.update);
  const method = record.kind === "frame" ? record.body.type : "";
  const directUpdate = method === direct?.sessionUpdate || method === "session/update";
  const child = native === null ? null : childNotification?.(method.replace(/\/after_answer$/u, ""), native);
  const update = directUpdate ? direct : child?.update ?? null;
  const toolUpdate = update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update";
  const rawInput = update?.rawInput;
  // ACP projects string rawInput verbatim and serializes the other JSON values.
  const encoded = toolUpdate && rawInput !== null && rawInput !== undefined && typeof rawInput !== "string";
  let safe = redactRuntimeRecord(record, credentials.redactValue, path => encoded && isProjectedToolInput(record, path), (path, value) => {
    const [body, native, update, field] = path;
    return toolUpdate && path.length === 4 && body === "body" && native === "native" && update === "update" && field === "status"
      && (value === "pending" || value === "in_progress" || value === "completed" || value === "failed" || value === "cancelled");
  });
  if (record.kind !== "frame" || safe.kind !== "frame") return safe;
  const fragment = update?.sessionUpdate;
  const retainedNative = asRecord(safe.body.native);
  if ((fragment === "config_option_update" || (method.startsWith("session/") && update === null))
    && safe.body.native !== record.body.native) {
    const config = fragment !== "config_option_update" ? retainedNative : directUpdate ? asRecord(retainedNative?.update)
      : retainedNative === null ? null : childNotification?.(method.replace(/\/after_answer$/u, ""), retainedNative)?.update ?? null;
    const model = acpReportedModel(config);
    const effort = acpReportedEffort(config);
    const events = safe.body.events.flatMap<RuntimeEventBody>(event => {
      if (event.kind === "model") return model === null ? [] : [{ ...event, model }];
      if (event.kind === "effort") return effort === null ? [] : [{ ...event, effort }];
      return [event];
    });
    return { ...safe, body: { ...safe.body, events } };
  }
  if (toolUpdate || fragment === "usage_update") {
    const packet = asRecord(safe.body.native);
    const safeUpdate = packet === null ? null : directUpdate ? asRecord(packet.update) : childNotification?.(method.replace(/\/after_answer$/u, ""), packet)?.update ?? null;
    if (safeUpdate === null) {
      const events = safe.body.events.filter(event => fragment === "usage_update" ? event.kind !== "usage"
        : event.kind !== "tool_call_started" && event.kind !== "tool_call_input" && event.kind !== "tool_call_progress" && event.kind !== "tool_call_ended");
      return { ...safe, body: { ...safe.body, events } };
    }
  }
  if (credentials.hasProtectedValues() && (fragment === "agent_thought_chunk" || fragment === "user_message_chunk"
    || (fragment === "agent_message_chunk" && !record.body.events.some(event => event.kind === "text_delta")))) {
    const packet = asRecord(safe.body.native);
    const safeUpdate = asRecord(packet?.update);
    let native = safe.body.native;
    if (safeUpdate !== null) {
      const { content: _withheld, ...rest } = safeUpdate;
      native = { ...packet, update: rest };
    } else if (packet !== null) {
      native = "[redacted]";
    }
    const events = safe.body.events.filter(event => event.kind !== "reasoning" && event.kind !== "user_message");
    return { ...safe, body: { ...safe.body, native, events } };
  }
  if (pendingText !== undefined && safe.kind === "frame" && record.kind === "frame" && credentials.hasProtectedValues()) {
    const lane = record.sessionId;
    const previous = pendingText.get(lane);
    const delta = update?.sessionUpdate === "agent_message_chunk" ? record.body.events.find(event => event.kind === "text_delta") : undefined;
    if (delta !== undefined && update !== null) {
      const { ready, pending } = credentials.redactChunk(delta.text, previous);
      if (pending === undefined) pendingText.delete(lane);
      else pendingText.set(lane, pending);
      const safeNative = asRecord(safe.body.native);
      const safeUpdate = asRecord(safeNative?.update);
      const safeContent = asRecord(safeUpdate?.content);
      if (safeContent === null) pendingText.delete(lane);
      const content = { ...safeContent, type: "text", text: ready };
      const native = safeContent === null ? safe.body.native : { ...safeNative, update: { ...safeUpdate, content } };
      const events = safe.body.events.flatMap<RuntimeEventBody>(event => event.kind !== "text_delta" ? [event]
        : safeContent === null || ready.length === 0 ? [] : [{ ...event, text: ready }]);
      return { ...safe, body: { ...safe.body, native, events } };
    }
    const closedChild = child != null && record.body.events.some(event => event.kind === "task_ended" && event.taskId === child.sessionId);
    if (closedChild) {
      const text = credentials.finishRedaction(pendingText.get(child.sessionId));
      pendingText.delete(child.sessionId);
      if (text !== "") {
        const event = { kind: "text_delta" as const, text, byokChildId: credentials.redact(child.sessionId) };
        safe = { ...safe, body: { ...safe.body, events: [event, ...safe.body.events] } };
      }
    }
    if (safe.kind === "frame" && previous !== undefined && record.body.events.some(event => event.kind === "turn_ended" || event.kind === "tool_call_started" || event.kind === "tool_call_ended")) {
      pendingText.delete(lane);
      const text = credentials.finishRedaction(previous);
      if (text !== "") {
        const events = [{ kind: "text_delta" as const, text }, ...safe.body.events];
        safe = { ...safe, body: { ...safe.body, events } };
      }
    }
  }
  if (!toolUpdate || safe.kind !== "frame" || !credentials.hasProtectedValues()) return safe;
  const rawOutput = credentials.redactValue(update.rawOutput);
  const content = credentials.redactValue(update.content);
  const toolLane = JSON.stringify([child?.sessionId ?? record.sessionId, update.toolCallId]);
  const previous = pendingToolText?.get(toolLane);
  const terminal = update.status === "completed" || update.status === "failed" || update.status === "cancelled"
    || safe.body.events.some(event => event.kind === "tool_call_ended");
  let withholdProgress = false;
  const progressOutput = !terminal ? acpToolProgressOutput(rawOutput, text => {
    const { ready, pending } = credentials.redactChunk(text, previous);
    withholdProgress = ready !== text || pending !== undefined || previous !== undefined;
    if (pending === undefined) pendingToolText?.delete(toolLane);
    else pendingToolText?.set(toolLane, pending);
    return ready;
  }, update.rawOutput) : undefined;
  if (terminal) pendingToolText?.delete(toolLane);
  const events = safe.body.events.flatMap<RuntimeEventBody>(event => {
    if (event.kind === "tool_call_progress") {
      const { output: _original, ...progress } = event;
      return [progressOutput === undefined || progressOutput === "" ? progress : { ...progress, output: progressOutput }];
    }
    if (event.kind === "tool_call_ended") {
      let ended = event;
      if (rawOutput !== update.rawOutput || content !== update.content) {
        const { content: _original, exitCode, ...result } = event;
        const output = acpToolTerminalContent(content, rawOutput, rawToolOutput, update.status);
        const safeExitCode = exitCode !== undefined && asRecord(rawOutput) !== null ? { exitCode } : {};
        ended = { ...result, ...safeExitCode, ...(output === undefined ? {} : { content: output }) };
      }
      const output = ended.content === undefined ? credentials.finishRedaction(previous) : "";
      return output === "" ? [ended] : [{ kind: "tool_call_progress", callId: event.callId, output }, ended];
    }
    return [event];
  });
  // Some ACP implementations stream incomplete JSON input in nonterminal content. Full rawInput is a separate field.
  const withholdInputFragments = !terminal && update.content !== undefined;
  if (!withholdProgress && !withholdInputFragments) return { ...safe, body: { ...safe.body, events } };
  const packet = asRecord(safe.body.native);
  const sanitizedUpdate = packet !== null && (directUpdate || child !== null) ? asRecord(packet.update) : null;
  if (sanitizedUpdate === null) return { ...safe, body: { ...safe.body, native: "[redacted]", events } };
  const safeUpdate = { ...sanitizedUpdate };
  if (withholdProgress) delete safeUpdate.rawOutput;
  if (withholdInputFragments) delete safeUpdate.content;
  return { ...safe, body: { ...safe.body, native: { ...packet, update: safeUpdate }, events } };
}

export type { AcpSessionProfile } from "./profile.js";

/*
 * ACP mapping onto the record stream (shared by grok and kimi; profiles carry the vendor bits):
 * - every `session/update` is ONE event record, native verbatim, for WHATEVER
 *   session id it names: a foreign id is a derived child session (records.ts).
 * - listed vendor notifications are recorded verbatim except credential redaction.
 * - runtime→app requests (permission, terminal) are toApp request records;
 *   oar's automatic answer is the matching `answered` response (client-app.ts).
 * - prompt / steer / queue / withdraw / abort / dispose are toRuntime requests answered
 *   accepted-or-rejected; the turn's end is the runtime's own prompt answer
 *   (turns.ts) or the process exit oar observed (`exited` response).
 */

// BYOK change: the caller passes the complete filtered environment, so a value is never a null removal.
export type AcpSessionOptions = Omit<SessionOptions, "env" | "endTurnProcessesOnAbort"> & { readonly env: Readonly<Record<string, string>> };

// BYOK change: the record consumer is registered before any record is appended.
export interface AcpSessionHooks {
  /** BYOK change: Caller-resolved credentials for redaction before retention and diagnostic delivery. */
  readonly credentialsForRedaction?: readonly string[];
  /** The native session id, before any record is delivered; a throw fails the open. */
  readonly onReady?: (sessionId: string) => void;
  /** A kernel observer from seq 0. The kernel swallows its errors, so it fails the session itself. */
  readonly onRecord?: (record: RawEvent) => void;
  /** BYOK change: answers each `session/request_permission`. Absent, every request is cancelled. */
  readonly onPermission?: AcpClientHooks["permission"];
  /** Cancels a queued startup before it can launch an owned process. */
  readonly startupSignal?: AbortSignal;
}

// BYOK change: the caller owns the agent process, every hosted terminal process and the environment.
export type StartAcpSession = (
  spawnLineProcess: SpawnAcpLineProcess,
  spawnTerminal: SpawnAcpTerminal,
  installation: AvailableInstallation,
  options: AcpSessionOptions,
  hooks?: AcpSessionHooks,
) => Promise<AdapterSession>;

export function acpSession(profile: AcpSessionProfile): StartAcpSession {
  // BYOK change: Upstream withSessionCredentials without sealSession. One redactor per open keeps
  // opening failures, retained records and later control errors under the same credential rules.
  return async (spawnLineProcess, spawnTerminal, installation, options, hooks = {}) => {
    const credentials = sessionCredentialRedactor(options);
    for (const value of hooks.credentialsForRedaction ?? []) { credentials.addExplicit(value); }
    try { return await openAcpRuntimeSession(profile, spawnLineProcess, spawnTerminal, installation, options, hooks, credentials); }
    catch (error) { throw credentials.redactValue(error); }
  };
}

async function openAcpRuntimeSession(
  profile: AcpSessionProfile,
  spawnLineProcess: SpawnAcpLineProcess,
  spawnTerminal: SpawnAcpTerminal,
  installation: AvailableInstallation,
  options: AcpSessionOptions,
  hooks: AcpSessionHooks,
  credentials: CredentialRedactor,
): Promise<AdapterSession> {
    if (installation.via !== "executable") {
      throw new Error("ACP runtimes require an executable installation");
    }
    profile.validateOptions?.(options);
    // SessionOptions.mcpServers go out in the open request (mcp-servers.ts):
    // a list with an empty or repeated name fails before anything starts,
    // and an open that fails reports no credential they carry.
    const withoutCredentials = acpMcpOpenGuard(options.mcpServers, credentials.redact);
    // BYOK change: explicit environment for the process and its launch arguments.
    if (options.env === undefined) throw new Error("ACP session requires an explicit filtered environment");
    const environment = options.env;
    const args = acpLaunchArgs(profile, options);
    const terminalHost = createAcpTerminalHost(spawnTerminal, options.cwd, environment, {
      shellCommand: profile.terminalShellCommand === true,
    });
    // The recorder queues everything until the handshake reveals the session
    // id and the kernel can be bound (records.ts).
    const usageGate = createUsageUpdateGate();
    const nativeTurns = createAcpNativeTurnTracker(profile.nativeTurns);
    const tokenUsage = createAcpTokenUsage(profile, nativeTurns?.sentByOar, credentials.redactValue);
    // BYOK change: a child ledger is an attributed observation and never enters the root accumulator.
    const childLedgers = new Map<string, ReturnType<typeof createAcpTokenUsage>>();
    const childTokenUsage = profile.spontaneousTokenUsage === undefined ? undefined : (sessionId: string) => {
      let ledger = childLedgers.get(sessionId);
      if (ledger === undefined) {
        ledger = createAcpTokenUsage(profile, undefined, credentials.redactValue);
        childLedgers.set(sessionId, ledger);
      }
      return ledger;
    };
    const opening = createAcpOpening();
    const configUpdates = createAcpConfigUpdates(credentials.redactValue);
    const readiness = profile.openReadiness?.(options);
    // BYOK change: a child's own update projects events only when it was read while a prompt awaited its answer (records.ts).
    const promptAnswers = createAcpPromptAnswers();
    const recorder = createAcpRecorder(usageGate, profile.attributeUpdate, tokenUsage, undefined, profile.projectUpdate, profile.projectExtension, nativeTurns, {
      ...profile, whilePromptAwaited: promptAnswers.whilePromptAwaited, ...(childTokenUsage === undefined ? {} : { childTokenUsage }),
    });
    const client = createAcpClientApp(terminalHost, {
      update: (notification, receivedAt) => {
        recorder.update(notification, receivedAt);
        configUpdates.observe(notification);
      },
      extension: (method, params, receivedAt, afterOpen) => {
        readiness?.observe(method, params);
        recorder.extension(method, profile.redactExtensionNotification?.(method, params) ?? params, afterOpen ?? opening.afterOpen(params), receivedAt);
      },
      requested: (id, method, params, receivedAt) => {
        recorder.requested(id, method, params, receivedAt);
      },
      answered: (id, reply) => {
        recorder.answered(id, reply);
      },
      extensionNotifications: profile.extensionNotifications ?? [],
      ...(hooks.onPermission === undefined ? {} : { permission: hooks.onPermission }),
    });
    const initializeTimeoutMs = profile.initializeTimeoutMs ?? 60_000;
    const initializeStartedAt = profile.acquireStartup === undefined ? undefined : performance.now();
    const releaseStartup = profile.acquireStartup === undefined ? undefined : await profile.acquireStartup(options, initializeTimeoutMs, hooks.startupSignal);
    const { opened, runtime, release } = await (async () => {
      try {
        hooks.startupSignal?.throwIfAborted();
        if (initializeStartedAt !== undefined && performance.now() - initializeStartedAt >= initializeTimeoutMs) {
          throw acpRequestTimeoutError("startup queue", initializeTimeoutMs);
        }
        const runtime = startAcpProcess(spawnLineProcess, installation.command, args, client, { cwd: options.cwd, env: environment, redact: credentials.redact, opening: withAcpPromptAnswers(opening, promptAnswers) });
        if (releaseStartup !== undefined) { void runtime.exited.then(releaseStartup, releaseStartup); }
        const release = async (): Promise<void> => {
          runtime.kill();
          await runtime.exited;
          await terminalHost.dispose();
        };
        const opened = await openAcpSession(runtime, profile, options, (step) => {
          if (step.method === "initialize") { releaseStartup?.(); }
          recorder.step(step.method, step.response);
        }, { configUpdates, readiness }, initializeStartedAt).catch(async (error: unknown) => {
          await release();
          throw withoutCredentials(error);
        });
        return { opened, runtime, release };
      } finally { releaseStartup?.(); }
    })();
    // BYOK change: the record consumer observes from seq 0: it registers before the recorder binds.
    const pendingText = new Map<string, CredentialRedactionTail>();
    const pendingToolText = new Map<string, CredentialRedactionTail>();
    const kernel = createSessionKernel(opened.sessionId, record => {
      const safe = redactAcpRecord(record, credentials, profile.childNotification, pendingText, pendingToolText, profile.projectRawToolOutput);
      if (safe.kind !== "frame") return safe;
      const body = { ...safe.body, byokRoot: record.sessionId === opened.sessionId && record.agentPath.length === 0 };
      return { ...safe, body };
    }, options.retainedBytes);
    if (hooks.onRecord !== undefined) kernel.rawEvents(hooks.onRecord);
    try {
      hooks.onReady?.(opened.sessionId);
    } catch (error) {
      await release();
      throw error;
    }

    const capabilities = { ...profile.capabilities, images: profile.capabilities.images ?? acpTakesImages(opened.initialized) };
    let compaction: ReturnType<typeof manualCompaction> | null = null;
    const promptUsage = (response: JsonRecord): RuntimeEventBody | null => tokenUsage.prompt(response, opened.initialized);
    const turns = createAcpTurns({ operationBusy: () => compaction?.busy() === true, kernel, runtime, profile, usageGate, capabilities, protectImage: credentials.addImage, promptMeta: profile.promptMeta?.(options), promptUsage,
      ...(nativeTurns === undefined ? {} : { native: { promptParams: (inputId: string | undefined): JsonRecord => ({ _meta: nativeTurns.name(inputId) }), afterClose: nativeTurns.afterOarTurn } }),
    });
    // The runtime's own turn is the active turn: prompt is busy, held input waits, steer and abort reach it.
    nativeTurns?.bind({ active: () => turns.active(), adopt: () => turns.beginOperation(null), release: (turn) => {
      const active = turns.active();
      if (active === turn) { turns.finishOperation(active); }
    } });
    // Bound only now: frames queued since the open answer may start a native turn, which needs the driver above.
    recorder.bind(kernel);
    const createCompaction = profile.compaction;
    if (createCompaction !== undefined) {
      compaction = manualCompaction(kernel, {
        // BYOK change: no pending cancellation observation to wait for; see `abort` in turns.ts.
        busy: () => turns.active() !== null || turns.queued(),
        busyReason: "Wait for native input and cancellation to finish before compacting",
        settledBy: "native_response",
        released: () => { queueMicrotask(() => { turns.drain(); }); },
        create: (): CompactionOperation => {
          const operation = createCompaction(kernel, runtime, promptUsage);
          let state: ActiveTurn | null = null;
          const finish = (): void => { if (state !== null) { turns.finishOperation(state); state = null; } };
          return {
            observe(frame) {
              const result = operation.observe(frame);
              if (result !== null) { finish(); }
              return result;
            },
            async start(request, reply) {
              state = turns.beginOperation(request);
              try { return await operation.start(request, reply); }
              finally { finish(); }
            },
          };
        },
      });
    }
    // oxlint-disable-next-line promise/prefer-await-to-then, promise/always-return -- Exit observation outlives session creation.
    void runtime.exited.then((code) => {
      // BYOK change: the session's dispose awaits and reports this same disposal.
      void terminalHost.dispose().catch(() => {});
      // An outcome only oar observes: answers our dispose when we caused the
      // exit, stands alone (requestId "") when the runtime died on its own.
      kernel.processExited(code);
      turns.onExit();
    });

    // Reachability (exited, disposed) is the kernel's gate, read off the
    // stream; the adapter decides only the runtime-specific answers (busy,
    // not_steerable). `runtime.closed` flips synchronously on the process's
    // exit, one microtask before the observer above records the `exited`
    // response: a control landing in that window would otherwise be decided
    // here (rejected "ACP process exited") instead of by the gate, so the
    // exit is let land first.
    const control = async (
      body: RequestBody,
      decide: (request: RequestRecord) => ResponseBody | Promise<ResponseBody>,
    ): Promise<ControlResult> => {
      if (runtime.closed && kernel.unreachable() === null) {
        await runtime.exited;
      }
      return kernel.control(body, decide);
    };
    const heldControl = (body: RequestBody, decide: (request: RequestRecord) => ResponseBody): Promise<ControlResult> => kernel.control(body, (request) =>
      runtime.closed && kernel.unreachable() === null
        ? (async (): Promise<ResponseBody> => { await runtime.exited; return kernel.unreachable() ?? decide(request); })()
        : kernel.unreachable() ?? decide(request));

    // A profile without a native steer cannot inject, so the session has no `steer`;
    // neither does one whose connection did not advertise its steer request.
    const { steerParams } = profile;
    const steerRequest = profile.steerRequestAdvertised?.(opened.initialized) === false ? undefined : profile.steerRequest;
    const steer = steerParams === undefined && steerRequest === undefined
      ? {}
      : {
        steer: (input: string, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "steer", input, ...inputOptions }, (request): ResponseBody | Promise<ResponseBody> => {
          if (compaction?.busy() === true) { return { kind: "rejected", code: "busy", reason: "Native compaction is still running" }; }
          // The turn running now, OAR's or the runtime's own, must still be the one running when the RPC goes out.
          const target = turns.active();
          if (target === null) { return { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" }; }
          if (steerRequest !== undefined) { return sendAcpSteerRequest({ kernel, runtime, profile, capabilities, protectImage: credentials.addImage, running: () => turns.active() === target && !target.abortRequested }, request, input, inputOptions); }
          return steerParams === undefined
            ? { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" }
            : turns.steer(target, input, inputOptions, steerParams(input));
        }),
      };

    // BYOK change: The upstream credentials.seal guard without sealSession: a control's thrown error is redacted.
    // As upstream, compact also redacts its outcome: its reasons can carry native error text.
    const guard = <Args extends unknown[], Result>(method: (...args: Args) => Promise<Result>, cleanResult = false) =>
      async (...args: Args): Promise<Result> => {
        try { const result = await method(...args); return cleanResult ? credentials.redactValue(result) : result; } catch (error) { throw credentials.redactValue(error); }
      };
    return { // BYOK change: raw adapter without sealSession/observe dependencies.
      id: kernel.sessionId,
      capabilities,
      prompt: guard((input: string, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "prompt", input, ...inputOptions }, (request): ResponseBody =>
        (turns.active() === null && !turns.queued() && compaction?.busy() !== true ? turns.begin(request, input, inputOptions?.images) : { kind: "rejected", code: "busy", reason: "busy" }))),
      ...(steer.steer === undefined ? {} : { steer: guard(steer.steer) }),
      ...(compaction === null ? {} : { compact: guard(compaction.compact, true) }),
      queue: guard((input: string, inputOptions?: InputOptions): Promise<ControlResult> => heldControl({ kind: "queue", input, ...inputOptions }, (request) => turns.hold(input, inputOptions?.images, inputOptions?.inputId, request))),
      // The queue is held here (turns.ts), not by the vendor: an entry can be taken back until the drain sends it.
      withdraw: guard((inputId: string): Promise<ControlResult> => heldControl({ kind: "withdraw", inputId }, () => turns.withdraw(inputId))),
      abort: guard((): Promise<ControlResult> => control({ kind: "abort" }, (): ResponseBody | Promise<ResponseBody> => {
        const state = turns.active();
        return state === null ? { kind: "rejected", code: "no_active_turn", reason: "no active turn" } : turns.abort(state);
      })),
      rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
      records: () => kernel.records(),
      graph: () => kernel.graph(),
      // BYOK change: no `resources` reader; the SDK process-tree authority owns the tree.
      dispose: guard(() => kernel.dispose(async () => {
        // BYOK change: no prepareShutdown/markNativeStop; the SDK process-tree
        // authority reads the descendants itself before it signals the tree.
        // BYOK change: the abort records the descendants and starts the cancel
        // write synchronously; dispose does not wait for that write, so a
        // runtime that stopped reading its stdin is still killed below.
        const state = turns.active();
        if (state !== null && !runtime.closed) {
          void turns.abort(state);
        }
        if (opened.supportsClose && profile.detachOnDispose !== true && !runtime.closed) {
          await closeAcpSession(runtime, kernel.sessionId).catch(() => {});
        }
        runtime.kill();
        await runtime.exited;
        await terminalHost.dispose();
      }, () => terminalHost.dispose())),
    };
}
