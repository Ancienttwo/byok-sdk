// BYOK change: Modified from OAR bc1b2ac for injected processes, native-first recording, bounded request refusal, caller-selected sandbox, caller-owned open steps and session credential redaction without sealSession (Apache-2.0).
import { codexTurnProcesses, type CodexProcessReader } from "./turn-processes.js";
import { codexTaskControl } from "./task-control.js";

// BYOK change: the narrow bridge reads the same declaration as Runtime.sessionCapabilities.
export const codexSessionCapabilities = () => ({ steer: true, images: true } as const);
import { manualCompaction } from "../../shared/manual-compaction.js";
import { codexCompaction, codexCompactionBusy } from "./compaction.js";
/* oxlint-disable import/max-dependencies -- The adapter composes protocol, input and process-lifetime mechanisms. */
import type { AvailableInstallation } from "../../contracts/installation.js"; // BYOK change: direct type-only contract import.
import { randomUUID } from "node:crypto";
import type {
  ControlResult,
  InputOptions,
  RawEvent,
  RequestRecord,
  RuntimeEventBody,
  AdapterSession,
  SessionOptions,
} from "../../contracts/session.js";
import { createAbortFallback } from "../../shared/abort-fallback.js";
import { acceptCodexSteer, codexUserInput, codexQueueRefusal } from "./input-delivery.js";
import { inputImagesRefusal } from "../../shared/input-images.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
// BYOK change: Return the raw adapter contract without best-effort observer projections.
// BYOK change: Build the session credential redactor directly; upstream withSessionCredentials imports sealSession.
import { isProjectedToolInput, redactRuntimeRecord, sessionCredentialRedactor, type CredentialRedactor, type CredentialRedactionTail } from "../../shared/credential-redactor.js";
import { redactJoinedText } from "../../shared/redact-text.js";
import { createSessionKernel } from "../../shared/session-kernel.js";
import { newSessionLinks } from "../../shared/session-links.js";
import { startAppServerClient, type RpcOutcome, type SpawnLineProcess } from "./app-server-client.js";
import { CODEX_SETTINGS_REPORT_MS, codexOpenReadback, codexResumeEffortRefusal, codexThreadName, codexThreadOpen } from "./open.js";
import { codexToolContent } from "./item-detail.js";
import { codexReasoningContent } from "./reasoning.js";
import { foldCodexNotification, initialCodexProjection, type CodexProjectionState } from "./projection.js";
import { prepareCodexOpenParams } from "./open-config.js";
import { missingDirectoryError, nameThread, openThread, rpcControl, updateThreadEffort, type RpcControlPlan } from "./rpc-control.js";
import { codexControlRefusal, codexVersion } from "./refusal.js";

/*
 * App-server v2: RPC replies answer controls; notifications carry facts.
 * Record replies synchronously, before later notifications in the same chunk.
 * Model/effort read-back and resume overrides live in open.ts. Reachability
 * comes from the recorded exit/dispose, never a separate liveness flag.
 * Native mappings and live evidence: docs/runtimes/codex.md.
 * BYOK change: server requests go to an explicit caller-owned native interaction handler, or are declined/rejected immediately when absent.
 */

interface CodexSessionState {
  /** The prompt request whose turn is running; null while idle or during a spontaneous turn. */
  active: RequestRecord | null;
  /** True while codex runs a root turn we did not prompt (a drained queue submission). */
  spontaneous: boolean;
  /** The runtime's id for the active root turn; steer/abort identity. */
  codexTurnId: string | null;
  /** Native interrupted completion pauses queue dispatch until another root turn starts. */
  queuePausedAfterInterrupt: boolean;
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
  // BYOK change: the caller passes the complete filtered environment, so a value is never a null removal.
  options: Omit<SessionOptions, "env" | "goals" | "fork"> & {
    readonly env?: Readonly<Record<string, string>>;
    readonly approvalPolicy?: "never" | "on-request"; // BYOK change: explicit local interactive opt-in.
    // BYOK change: the caller passes OAR_CODEX_SANDBOX semantics explicitly.
    readonly sandboxMode?: "read-only" | "workspace-write" | "danger-full-access" | "inherit";
  },
  serverRequestTimeoutMs = 1_000,
  hooks: { // BYOK change: the record consumer is registered before any record is appended.
    readonly onReady?: (threadId: string) => void;
    readonly turnProcessReader?: CodexProcessReader;
    readonly onRecord?: (record: RawEvent) => void;
    /** Native interaction correlation uses opaque wire IDs. */
    readonly onNativeIdentity?: (method: string, identity: JsonRecord) => void;
    // BYOK change: caller-owned, bounded native request lifecycle; no permissive fallback.
    readonly onServerRequest?: (id: string | number, method: string, params: JsonRecord, reply: {
      respond(value: JsonRecord): Promise<void>; reject(code: number, message: string): Promise<void>; cancelled(): void;
    }) => void;
    // BYOK change: caller-owned steps on this app-server client, before the thread open request and after its read-back.
    readonly beforeOpen?: (request: CodexOpenStepRequest, params: JsonRecord) => Promise<JsonRecord>;
    readonly afterOpen?: (request: CodexOpenStepRequest, threadId: string) => Promise<void>;
  } = {},
): Promise<CodexAdapterSession> {
  // BYOK change: Upstream withSessionCredentials without sealSession. One redactor per open keeps
  // opening failures, retained records and later control errors under the same credential rules.
  const credentials = sessionCredentialRedactor(options);
  try { return await openCodexSession(spawnLineProcess, installation, options, serverRequestTimeoutMs, hooks, credentials); }
  catch (error) { throw credentials.redactValue(error); }
}

type CodexSessionArgs = Parameters<typeof codexSession>;
// BYOK change: one request on the session's own client, for the caller-owned open steps.
export type CodexOpenStepRequest = (method: string, params: JsonRecord) => Promise<JsonRecord>;

const codexObservedMethods = new Set(["turn/started", "turn/completed", "thread/tokenUsage/updated", "error", "item/agentMessage/delta", "item/started", "item/completed", "rawResponseItem/completed"]);
const codexItemFields = new Map<string, readonly string[]>([
  ["agentMessage", ["text"]], ["userMessage", ["content", "clientId"]], ["error", ["message"]],
  ["commandExecution", ["command", "status", "aggregatedOutput", "exitCode"]],
  ["fileChange", ["changes", "status"]], ["mcpToolCall", ["server", "tool", "arguments", "result", "error", "status"]],
  ["collabAgentToolCall", ["tool", "prompt", "status", "receiverThreadIds", "agentsStates"]],
  ["webSearch", ["query", "results", "status"]], ["sleep", ["durationMs"]],
]);
const codexTerminalFields = new Set(["id", "status", "error", "items"]);
const codexUsageFields = new Set(["last", "total", "modelContextWindow"]);
const codexTokenFields = new Set(["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]);
const codexNotificationFields: Readonly<Record<string, readonly string[]>> = {
  "turn/started": ["turn"], "turn/completed": ["turn"], "item/started": ["item"], "item/completed": ["item"],
  "item/agentMessage/delta": ["itemId", "delta"], "thread/tokenUsage/updated": ["tokenUsage"], "rawResponseItem/completed": ["item"], error: ["error", "willRetry"],
};
const isCodexNotificationKey = (method: string, key: string): boolean => codexObservedMethods.has(method)
  && (key === "threadId" || key === "turnId" || codexNotificationFields[method]?.includes(key) === true);
const isCodexItemKey = (fields: readonly string[] | undefined, key: string): boolean => fields !== undefined
  && (key === "id" || key === "type" || fields.includes(key));

function redactCodexTurnItems(source: JsonRecord | null, safe: JsonRecord | null, redact: CredentialRedactor["redactValue"]): JsonRecord | null {
  const originalItems = source?.items;
  const retainedItems = safe?.items;
  if (!Array.isArray(originalItems) || !Array.isArray(retainedItems)) return safe;
  const items = retainedItems.map((item: unknown, index: number) => {
    const original = asRecord(originalItems[index]);
    const retained = asRecord(item);
    if (original?.type !== "userMessage" || !Array.isArray(original.content) || retained === null) return item;
    const { content } = redactJoinedText(original.content, retained.content, redact);
    return content === retained.content ? item : { ...retained, content };
  });
  return items.every((item: unknown, index: number) => item === retainedItems[index]) ? safe : { ...safe, items };
}

function redactCodexSnapshot(source: JsonRecord | null, safe: JsonRecord | null, redact: CredentialRedactor["redactValue"]): JsonRecord | null {
  if (source === null || safe === null) return safe;
  const turn = asRecord(safe.turn);
  const updated = redactCodexTurnItems(asRecord(source.turn), turn, redact);
  const originalTurns = asRecord(source.thread)?.turns;
  const thread = asRecord(safe.thread);
  const retainedTurns = thread?.turns;
  const reply = updated === turn ? safe : { ...safe, turn: updated };
  if (!Array.isArray(originalTurns) || !Array.isArray(retainedTurns)) return reply;
  const turns = retainedTurns.map((value: unknown, index: number) => redactCodexTurnItems(asRecord(originalTurns[index]), asRecord(value), redact) ?? value);
  return turns.every((value: unknown, index: number) => value === retainedTurns[index]) ? reply
    : { ...reply, thread: { ...thread, turns } };
}

export function redactCodexRecord<T extends RawEvent>(record: T, redact: CredentialRedactor["redactValue"], normalizedDraft = false,
  readyText?: WeakSet<RuntimeEventBody>,
): T {
  const method = record.kind === "frame" ? record.body.type : "";
  const originalNative = record.kind === "frame" ? asRecord(record.body.native) : null;
  const originalItem = asRecord(originalNative?.item);
  const itemType = method === "item/started" || method === "item/completed" ? originalItem?.type : undefined;
  const isRawItem = method === "rawResponseItem/completed";
  const rawFunction = isRawItem && originalItem?.type === "function_call";
  const rawReasoning = isRawItem && originalItem?.type === "reasoning";
  const rawMessage = isRawItem && originalItem?.type === "message";
  const itemFields = rawFunction ? ["arguments", "call_id", "name"] : rawReasoning ? ["summary", "content", "encrypted_content"]
    : rawMessage ? ["role", "content", "status", "phase"] : typeof itemType === "string" ? codexItemFields.get(itemType) : undefined;
  const encoded = itemType === "mcpToolCall" || itemType === "fileChange" || itemType === "collabAgentToolCall" || itemType === "sleep";
  const safe = redactRuntimeRecord(record, redact, path => (encoded && isProjectedToolInput(record, path))
    || (rawFunction && path.length === 4 && path[0] === "body" && path[1] === "native" && path[2] === "item" && path[3] === "arguments"), (path, value) => {
    const [body, group, member, field] = path;
    if (body !== "body" || record.kind !== "frame") return false;
    if (normalizedDraft && record.body.type === "item/agentMessage/delta" && path.length === 3 && group === "native" && member === "delta") return true;
    if (path.length === 4 && group === "events" && typeof member === "number" && field === "text") {
      const event = record.body.events[member];
      if (event?.kind === "text_delta" && (normalizedDraft || readyText?.has(event))) return true;
    }
    if (path.length === 2) return (group === "type" && codexObservedMethods.has(value)) || (group === "origin" && value === "byok-native")
      || (group === "byokTurnStatus" && record.body.type === "turn/completed" && (value === "completed" || value === "interrupted" || value === "failed"));
    if (path.length !== 4 || group !== "native") return false;
    if (member === "item" && field === "type") return itemFields !== undefined;
    return record.body.type === "turn/completed" && member === "turn" && field === "status"
      && (value === "completed" || value === "interrupted" || value === "failed");
  }, (path, key) => {
    if (record.kind !== "frame" || !codexObservedMethods.has(record.body.type) || path[0] !== "body" || path[1] !== "native") return false;
    return (path.length === 2 && isCodexNotificationKey(record.body.type, key))
      || (path.length === 3 && path[2] === "turn" && (record.body.type === "turn/completed" || record.body.type === "turn/started") && codexTerminalFields.has(key))
      || (path.length === 3 && path[2] === "item" && isCodexItemKey(itemFields, key))
      || (record.body.type === "thread/tokenUsage/updated" && path[2] === "tokenUsage"
        && ((path.length === 3 && codexUsageFields.has(key))
          || (path.length === 4 && (path[3] === "last" || path[3] === "total") && codexTokenFields.has(key))));
  });
  if (record.kind === "response" && safe.kind === "response" && (record.body.kind === "accepted" || record.body.kind === "rejected")
    && (safe.body.kind === "accepted" || safe.body.kind === "rejected")) {
    const native = asRecord(safe.body.native);
    const snapshot = redactCodexSnapshot(asRecord(record.body.native), native, redact);
    return snapshot === native ? safe : { ...safe, body: { ...safe.body, native: snapshot } };
  }
  if (safe.kind !== "frame") return safe;
  const native = asRecord(safe.body.native);
  if (originalNative !== null && native === null) {
    const retained = { ...safe, body: { ...safe.body, events: [] } };
    Reflect.deleteProperty(retained, "spanId");
    return retained;
  }
  const safeItem = asRecord(native?.item);
  const isOpenReply = method === "thread/start" || method === "thread/resume" || method === "thread/fork";
  if (isOpenReply || method === "turn/completed" || method === "turn/started" || method === "thread/started") {
    const turn = asRecord(native?.turn);
    const hiddenTurn = (method === "turn/completed" || method === "turn/started") && asRecord(originalNative?.turn) !== null && turn === null;
    if (hiddenTurn) {
      const events = safe.body.events.map(event => {
        if (event.kind !== "turn_ended") return event;
        const { forkAnchor: _withheld, ...ended } = event;
        return ended;
      });
      const retained = { ...safe, body: { ...safe.body, events } };
      Reflect.deleteProperty(retained, "spanId");
      return retained;
    }
    const snapshot = redactCodexSnapshot(originalNative, native, redact);
    if (snapshot !== native) return { ...safe, body: { ...safe.body, native: snapshot } };
    if (native === null && isOpenReply) return { ...safe, body: { ...safe.body, events: [] } };
    return safe;
  }
  if (method.startsWith("thread/goal/") && asRecord(originalNative?.goal) !== null && asRecord(native?.goal) === null) {
    const events = safe.body.events.filter(event => event.kind !== "goal_changed");
    return { ...safe, body: { ...safe.body, events } };
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = asRecord(native?.tokenUsage);
    const source = asRecord(originalNative?.tokenUsage);
    if (usage === null || asRecord(usage.total) === null || (asRecord(source?.last) !== null && asRecord(usage.last) === null)) {
      return { ...safe, body: { ...safe.body, events: safe.body.events.filter(event => event.kind !== "usage") } };
    }
  }
  if (method === "thread/settings/updated" && asRecord(native?.threadSettings) === null) {
    const events = safe.body.events.filter(event => event.kind !== "model" && event.kind !== "effort" && event.kind !== "service_tier");
    return { ...safe, body: { ...safe.body, events } };
  }
  if (method === "error" && asRecord(originalNative?.error) !== null && asRecord(native?.error) === null) {
    const events = safe.body.events.map(event => {
      if (event.kind !== "retry") return event;
      const { reason: _withheld, ...retry } = event;
      return retry;
    });
    return { ...safe, body: { ...safe.body, events } };
  }
  if ((itemType === "userMessage" || rawMessage) && Array.isArray(originalItem?.content)) {
    const { content, input } = redactJoinedText(originalItem.content, safeItem?.content, redact, "",
      rawMessage ? block => block.type === "input_text" || block.type === "output_text" : undefined);
    const events = safe.body.events.map(event => event.kind === "user_message" ? { ...event, input } : event);
    const updated = safeItem !== null && content !== safeItem.content ? { ...native, item: { ...safeItem, content } } : safe.body.native;
    return { ...safe, body: { ...safe.body, native: updated, events } };
  }
  if (rawReasoning && originalItem !== null) {
    const originalSummary = Array.isArray(originalItem.summary) ? originalItem.summary : [];
    const originalContent = Array.isArray(originalItem.content) ? originalItem.content : [];
    const summary = Array.isArray(safeItem?.summary) ? safeItem.summary : [];
    const blocks = Array.isArray(safeItem?.content) ? safeItem.content : [];
    const retained = [...summary, ...blocks];
    const joined = redactJoinedText([...originalSummary, ...originalContent], retained, redact, "\n", () => true);
    const content = joined.input === "" ? codexReasoningContent(safeItem) : { kind: "text" as const, text: joined.input };
    const events = safe.body.events.flatMap<RuntimeEventBody>(event => event.kind !== "reasoning" ? [event]
      : content === null ? [] : [{ ...event, content }]);
    let updated = safe.body.native;
    if (safeItem !== null && Array.isArray(joined.content) && joined.content !== retained) {
      const item = { ...safeItem,
        ...(Array.isArray(safeItem.summary) ? { summary: joined.content.slice(0, summary.length) } : {}),
        ...(Array.isArray(safeItem.content) ? { content: joined.content.slice(summary.length) } : {}),
      };
      updated = { ...native, item };
    }
    return { ...safe, body: { ...safe.body, native: updated, events } };
  }
  if (itemType !== "mcpToolCall" || method !== "item/completed") return safe;
  if (safeItem?.result === originalItem?.result && safeItem?.error === originalItem?.error) return safe;
  const originalError = asRecord(originalItem?.error);
  const visibleError = asRecord(safeItem?.error);
  const content = typeof visibleError?.message === "string" && typeof originalError?.message === "string"
    ? [{ type: "text" as const, text: redact(`error: ${originalError.message}`) }]
    : safeItem === null ? undefined : codexToolContent({ ...safeItem, type: "mcpToolCall" });
  const events = safe.body.events.map(event => {
    if (event.kind !== "tool_call_ended") return event;
    const { content: _original, ...rest } = event;
    return content === undefined ? rest : { ...rest, content };
  });
  return { ...safe, body: { ...safe.body, events } };
}

async function openCodexSession(
  spawnLineProcess: SpawnLineProcess,
  installation: AvailableInstallation,
  options: CodexSessionArgs[2],
  serverRequestTimeoutMs: number,
  hooks: NonNullable<CodexSessionArgs[4]>,
  credentials: CredentialRedactor,
): Promise<CodexAdapterSession> {
  const { redactValue } = credentials;
  if (installation.via !== "executable") {
    throw new Error("The codex session adapter needs an executable installation");
  }
  if (options.endTurnProcessesOnAbort === true && process.platform !== "win32" && hooks.turnProcessReader === undefined) {
    throw new Error("Codex turn process cleanup requires the isolated process reader");
  }
  // Threads persist so a later SessionOptions.resume can reattach; the thread
  // id is the runtime-native identity and becomes Session.id (open.ts builds
  // the request, and refuses what it cannot build before anything starts).
  // BYOK change: Explicit environment and caller sandbox; ambient OAR_CODEX_SANDBOX is ignored.
  // YOLO default (repo policy 2026-08-24): bypass the sandbox too, not just
  // approvals. Injected as a launch -c override (app-server-client.ts).
  // "inherit" skips the override, so the user's own config wins.
  const sandboxMode = options.sandboxMode ?? "danger-full-access";
  const { method: openMethod, params: openParams, redact } = codexThreadOpen(options, sandboxMode);
  if (options.env === undefined) throw new Error("codex session requires an explicit filtered environment");
  const configOverrides: Record<string, string> = sandboxMode === "inherit" ? {} : { sandbox_mode: `"${sandboxMode}"` };
  if (!Number.isFinite(serverRequestTimeoutMs) || serverRequestTimeoutMs <= 0 || serverRequestTimeoutMs > 2_147_483_647) {
    throw new Error("codex server request timeout must be positive, finite and at most 2147483647ms");
  }
  // Every error the client reports goes through the redactor first: the
  // open's config carries the session's MCP credentials to codex.
  const client = startAppServerClient(spawnLineProcess, installation.command, options.env, configOverrides, options.cwd, { redact, ...(options.launchArgs === undefined ? {} : { launchArgs: options.launchArgs }) });
  // BYOK change: One kill per failed open, so a caller-owned hook can await its exit without a second kill.
  let killedForOpen = false;
  const killForOpen = (): void => { if (!killedForOpen) { killedForOpen = true; client.kill(); } };
  // BYOK change: Every open failure releases the caller-owned process before it is reported.
  try {
  // BYOK change: Ownership/adoption must settle before the first protocol write.
  await client.spawned;
  // The running binary's own version; the probed one when codex names none.
  const version = codexVersion(await client.request("initialize", {
    clientInfo: { name: "oar", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  })) ?? installation.version ?? null;
  client.notify("initialized", {});
  const effectiveOpenParams = await prepareCodexOpenParams(client, options, openParams);
  // BYOK change: a caller-owned open step that throws releases the process, as a refused open does.
  const openStep = async <T>(step: () => Promise<T>): Promise<T> => {
    try { return await step(); } catch (error) { killForOpen(); await client.exited.catch(() => {}); throw error; }
  };
  const stepRequest: CodexOpenStepRequest = (method, params) => client.request(method, params);
  const { beforeOpen, afterOpen } = hooks;
  const requestParams = beforeOpen === undefined ? effectiveOpenParams : await openStep(() => beforeOpen(stepRequest, effectiveOpenParams));
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
  const started = await openThread(openMethod, async () => {
    const reply = await client.request(openMethod, requestParams, markOpen);
    return reply;
  }, { version, serviceTier: options.serviceTier, resumeId: options.resume });
  const threadId = asRecord(started.thread)?.id;
  if (typeof threadId !== "string") {
    throw new TypeError("codex thread start/resume returned no thread id");
  }
  // The reply is codex's word on the model and effort the thread runs (the
  // open frame's events); anything but what was requested refuses the open.
  // BYOK change: Never advertise an interactive policy the provider did not actually apply.
  if (options.approvalPolicy === "on-request" && started.approvalPolicy !== "on-request") {
    throw new Error("codex native interaction approval policy readback mismatch");
  }
  const publicReadback = asRecord(redactValue(started)) === null ? null : started;
  const readback = codexOpenReadback(openMethod, options, started, publicReadback);
  if (readback.refusal !== null) {
    throw typeof readback.refusal === "string" ? new Error(readback.refusal) : readback.refusal;
  }
  if (afterOpen !== undefined) await openStep(() => afterOpen(stepRequest, threadId));

  // BYOK change: The record consumer observes from seq 0: it registers before any record is appended.
  // Observer errors are swallowed by the kernel, so the consumer fails the session itself.
  const readyText = new WeakSet<RuntimeEventBody>();
  const kernel = createSessionKernel(threadId, record => {
    const body = record.kind === "frame" ? record.body : undefined;
    return redactCodexRecord(record, redactValue, body?.type === "item/agentMessage/delta" && credentials.hasProtectedValues(), readyText);
  }, options.retainedBytes);
  if (hooks.onRecord !== undefined) kernel.rawEvents(hooks.onRecord);
  hooks.onReady?.(threadId);
  const state: CodexSessionState = {
    active: null,
    spontaneous: false,
    codexTurnId: null,
    queuePausedAfterInterrupt: false,
    // A resume awaits codex's re-report of the thread's total so far: the
    // baseline this Session's token totals count from (projection.ts, #169).
    projection: initialCodexProjection(threadId, openMethod),
  };
  const tasks = codexTaskControl(kernel, client, () => state.projection.subagents);
  const nativeBusy = (): boolean => state.active !== null || state.spontaneous;
  let compactOperation: ReturnType<typeof codexCompaction> | null = null;
  const compaction = manualCompaction(kernel, { busy: codexCompactionBusy(kernel, nativeBusy), busyReason: "Codex manual compaction requires an idle session without an active goal or queued input", create: () => { compactOperation = codexCompaction(client, threadId); return compactOperation; } });
  const busy = (): boolean => nativeBusy() || compaction.busy();
  const abortFallback = createAbortFallback(() => { client.kill(); });
  const turnProcesses = codexTurnProcesses(kernel, options.endTurnProcessesOnAbort === true ? hooks.turnProcessReader : undefined);
  // A resume's effort update in flight: codex's thread/settings/updated answers it.
  type SettingsReadback = { readonly params: JsonRecord; readonly visible: boolean };
  let settingsWaiter: ((readback: SettingsReadback) => void) | null = null;

  recordOpen = (): void => {
    kernel.frame({ type: openMethod, native: started, events: readback.events });
  };
  // Drive the pure projection fold, applying its commands to the kernel; the
  // fold owns event translation, attribution and graph links; this owns the
  // transport-only turn id and the control decisions (busy, spontaneous).
  let lastNotifiedRootTurnId: string | undefined;
  const draftTails = new Map<string, Map<string | undefined, Map<string, CredentialRedactionTail>>>();
  const onNotification = (method: string, params: JsonRecord): void => {
    // BYOK change: Retain the exact native notification before any potentially throwing fold.
    // The record envelope's sessionId puts a foreign thread in the graph (observe/graph.ts); no out-of-band node.
    const notificationSession = typeof params.threadId === "string" ? params.threadId : threadId;
    const isRoot = notificationSession === threadId;
    const wireTurn = asRecord(params.turn)?.id;
    if (isRoot && method === "turn/started" && typeof wireTurn === "string") lastNotifiedRootTurnId = wireTurn;
    const turnId = method === "turn/completed" ? wireTurn : params.turnId;
    const activeTurn = state.codexTurnId ?? lastNotifiedRootTurnId;
    const byokStaleTurn = isRoot && typeof turnId === "string" && activeTurn !== undefined && turnId !== activeTurn;
    const draftMethod = method === "item/agentMessage/delta";
    const streamedOutput = method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta"
      || method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta";
    const draftTurn = typeof turnId === "string" ? turnId : isRoot ? activeTurn : undefined;
    const itemId = typeof params.itemId === "string" ? params.itemId : "";
    const threadTails = draftTails.get(notificationSession);
    const turnTails = threadTails?.get(draftTurn);
    const pruneTail = (item: string): void => {
      turnTails?.delete(item);
      if (turnTails?.size === 0) threadTails?.delete(draftTurn);
      if (threadTails?.size === 0) draftTails.delete(notificationSession);
    };
    if (method === "turn/completed" || method === "turn/started") {
      const endedTurn = method === "turn/completed" ? draftTurn : undefined;
      threadTails?.delete(endedTurn);
      if (threadTails?.size === 0) draftTails.delete(notificationSession);
    }
    const itemMethod = method === "item/started" || method === "item/completed";
    const withheld = Object.getOwnPropertyNames(params).some(key => !isCodexNotificationKey(method, key) && credentials.matches(key));
    const item = itemMethod ? asRecord(params.item) : null;
    const itemFields = typeof item?.type === "string" ? codexItemFields.get(item.type) : undefined;
    const withheldItem = item !== null && (withheld || Object.getOwnPropertyNames(item)
      .some(key => !isCodexItemKey(itemFields, key) && credentials.matches(key)));
    let draftTail = "";
    if (method === "item/completed" && !byokStaleTurn && typeof item?.id === "string") {
      const pending = turnTails?.get(item.id);
      if (!withheldItem && pending !== undefined && item.type === "agentMessage"
        && typeof item.text === "string" && item.text.endsWith(pending.text)) {
        draftTail = credentials.finishRedaction(pending);
      }
      pruneTail(item.id);
    }
    if (withheld && draftMethod) pruneTail(itemId);
    if (!withheld && credentials.hasProtectedValues() && typeof params.delta === "string" && (streamedOutput || (draftMethod && byokStaleTurn))) {
      const { delta: _omitted, ...rest } = params;
      params = rest;
    } else if (!withheld && draftMethod && typeof params.delta === "string" && credentials.hasProtectedValues()) {
      const { ready, pending } = credentials.redactChunk(params.delta, turnTails?.get(itemId));
      if (pending === undefined) pruneTail(itemId);
      else {
        const items = (turnTails ?? new Map()).set(itemId, pending);
        draftTails.set(notificationSession, (threadTails ?? new Map()).set(draftTurn, items));
      }
      params = { ...params, delta: ready };
    }
    // BYOK change: label native frames and anchor root and turn membership before redaction can change ids.
    const byokTurnStatus = method === "turn/completed" ? asRecord(params.turn)?.status : undefined;
    const terminalStatus = byokTurnStatus === "completed" || byokTurnStatus === "interrupted" || byokTurnStatus === "failed"
      ? { byokTurnStatus } : {};
    const nativeBody = { type: method, native: params, events: [], origin: "byok-native", byokRoot: isRoot, byokStaleTurn, ...terminalStatus } as const;
    const nativeRecord = kernel.frame(nativeBody, withheld ? undefined : {
      sessionId: notificationSession,
      ...(typeof params.turnId === "string" ? { spanId: params.turnId } : {}),
    });
    if (byokStaleTurn && (method === "turn/completed" || method === "item/completed")) return;
    try {
    // Keep native interaction correlation private to the SDK's transport owner.
    if (isRoot && (method === "turn/started" || method === "turn/completed" || method === "serverRequest/resolved")) {
      hooks.onNativeIdentity?.(method, { threadId, ...(typeof wireTurn === "string" ? { turn: { id: wireTurn } } : {}),
        ...(typeof params.requestId === "string" || typeof params.requestId === "number" ? { requestId: params.requestId } : {}) });
    }
    if (!withheld) tasks.observe(method, params);
    if (isRoot && method === "turn/started") {
      state.queuePausedAfterInterrupt = false;
      const startedTurn = asRecord(params.turn)?.id;
      if (!busy()) {
        // A turn we did not prompt (a drained queue submission): adopt it.
        state.spontaneous = true;
      }
      if (typeof startedTurn === "string") {
        state.codexTurnId = startedTurn;
      }
    }
    if (isRoot && method === "turn/completed") {
      state.queuePausedAfterInterrupt = asRecord(params.turn)?.status === "interrupted";
      abortFallback.clear();
      state.active = null;
      state.spontaneous = false;
      state.codexTurnId = null;
    }
    const safeNative = asRecord(nativeRecord.body.native);
    if (isRoot && method === "thread/settings/updated") {
      settingsWaiter?.({ params, visible: safeNative !== null && (asRecord(params.threadSettings) === null || asRecord(safeNative.threadSettings) !== null) });
    }
    // Withheld notifications still drive transport correlation. Only root turn status drives a public fold.
    const rootTurn = isRoot && (method === "turn/started" || method === "turn/completed");
    if (withheld && !rootTurn) return;
    const error = method === "error" ? asRecord(params.error) : null;
    const withheldError = error !== null && Object.getOwnPropertyNames(error).some(credentials.matches);
    let projectionParams = params;
    if (withheld) projectionParams = { turn: { status: terminalStatus.byokTurnStatus } };
    else if (withheldItem) projectionParams = { ...params, item: undefined };
    else if (withheldError) projectionParams = { ...params, error: undefined };
    if (method === "thread/tokenUsage/updated") projectionParams = { ...params, tokenUsage: safeNative?.tokenUsage };
    if (method === "account/rateLimits/updated") projectionParams = { ...params, rateLimits: safeNative?.rateLimits };
    const { state: nextProjection, commands } = foldCodexNotification(state.projection, method, projectionParams);
    state.projection = nextProjection;
    const links = newSessionLinks(kernel, commands.flatMap((command) => command.kind === "link" ? [command.edge] : []));
    for (const command of commands) {
      switch (command.kind) {
        case "frame":
          const events = [...command.body.events, ...links];
          if (draftTail !== "" && !events.some(event => event.kind === "text_delta")) {
            const event = { kind: "text_delta" as const, text: draftTail };
            readyText.add(event);
            events.push(event);
          }
          const body = { ...command.body, ...(method === "thread/tokenUsage/updated" ? { native: params } : {}), events, byokRoot: isRoot, ...terminalStatus };
          kernel.frame(body, {
            ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
            ...(command.spanId === undefined ? {} : { spanId: command.spanId }),
          });
          break;
        case "link":
          break;
        default:
          break;
      }
    }
    if (isRoot && method === "turn/completed") turnProcesses.turnCompleted(params);
    } catch (error) {
      client.kill(); // BYOK change: A required fold failure is visible and terminates the session.
      throw error;
    }
  };
  // BYOK change: Opted-in native requests use the caller-owned lifecycle; absent opt-in keeps bounded refusal.
  const onServerRequest = (id: number | string, method: string, params: JsonRecord): void => {
    // BYOK change: Record ids follow the kernel string contract; the wire reply echoes the original id.
    const publicId = typeof id === "string" && credentials.redact(id) !== id
      ? `native:redacted:${randomUUID()}` : `native:${typeof id}:${JSON.stringify(id)}`;
    const request = kernel.request("toApp", { kind: "native", type: method, native: params }, { id: publicId });
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
          record({ kind: 'rejected', code: 'error', reason: 'native reply transport failed' });
          client.kill();
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
      kernel.respond(request.id, body);
    };
    const timer = setTimeout(() => {
      finish({ kind: "rejected", code: "error", reason: `codex ${method} response deadline exceeded` });
      client.kill();
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
  client.onExit((code, reason) => {
    abortFallback.clear();
    turnProcesses.exited();
    // The exit is an outcome only oar observes: it answers our dispose when
    // we caused it, and stands alone when the app-server died on its own.
    kernel.processExited(code, reason);
    state.active = null;
    state.spontaneous = false;
    state.codexTurnId = null;
  });
  if (readback.resumeEffort !== null) {
    // The resumed thread runs another level: set it on the loaded thread and
    // take codex's pushed settings (a recorded frame) as the word on it.
    const requested = readback.resumeEffort;
    const { promise: reported, resolve } = Promise.withResolvers<SettingsReadback | null>();
    settingsWaiter = resolve;
    const timer = setTimeout(() => {
      resolve(null);
    }, CODEX_SETTINGS_REPORT_MS);
    try {
      await updateThreadEffort(client, threadId, requested, version);
      const readback = await reported;
      const refusal = codexResumeEffortRefusal(requested, readback?.params ?? null, readback?.visible);
      if (refusal !== null) { throw refusal; }
    } finally { clearTimeout(timer); settingsWaiter = null; }
  }
  // Last, so an open refused above leaves the user's thread unrenamed.
  await nameThread(client, threadId, codexThreadName(openMethod, options, started), (native) => { kernel.frame({ type: "thread/name/set/error", native, events: [] }); });

  /** Turn a plan builder into a Session control member. */
  const via = <Args extends unknown[]>(plan: (...args: Args) => RpcControlPlan) =>
    async (...args: Args): Promise<ControlResult> => {
      const result = await rpcControl(kernel, client, plan(...args));
      return result;
    };
  const capabilities = { queue: { durable: true }, attribution: "nested", images: true } as const;
  const promptPlan = (input: string, inputOptions?: InputOptions): RpcControlPlan => ({
    body: { kind: "prompt", input, ...inputOptions },
    gate: (request) => {
      const refused = busy() ? { kind: "rejected", code: "busy", reason: "busy" } as const : inputImagesRefusal(capabilities, inputOptions?.images);
      if (refused !== null) {
        return refused;
      }
      // Hold the slot while the RPC is in flight so a concurrent prompt is busy.
      state.active = request;
      return null;
    },
    method: "turn/start",
    params: () => ({ threadId, input: codexUserInput(input, inputOptions?.images), clientUserMessageId: inputOptions?.inputId, ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }) }),
    onReply: (reply) => {
      const turnId = asRecord(reply.turn)?.id;
      if (typeof turnId !== "string") {
        state.active = null;
        return { kind: "rejected", code: "runtime_refused", reason: "codex turn/start returned no turn id", native: reply };
      }
      state.codexTurnId = turnId;
      return { kind: "accepted", native: reply };
    },
    onError: (message, native) => {
      state.active = null;
      return codexControlRefusal(message, native);
    },
  });
  const steerPlan = (input: string, inputOptions?: InputOptions): RpcControlPlan => {
    const expectedTurnId = state.codexTurnId;
    return {
      body: { kind: "steer", input, ...inputOptions },
      gate: () => compaction.busy() ? { kind: "rejected", code: "busy", reason: "Manual compaction is still in progress" } : (!busy() || expectedTurnId === null ? { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" } : inputImagesRefusal(capabilities, inputOptions?.images)),
      method: "turn/steer",
      params: () => ({ threadId, input: codexUserInput(input, inputOptions?.images), expectedTurnId, clientUserMessageId: inputOptions?.inputId }),
      onReply: (reply) => {
        if (expectedTurnId !== null && inputOptions?.inputId !== undefined) {
          state.projection = { ...state.projection, inputs: acceptCodexSteer(state.projection.inputs, expectedTurnId, inputOptions.inputId) };
        }
        return { kind: "accepted", native: reply };
      },
      onError: (message, native) => codexControlRefusal(`not_steerable: ${message}`, native),
    };
  };
  // The reply carries the runtime's submission id; it is retained on the response.
  const queuePlan = (input: string, inputOptions?: InputOptions): RpcControlPlan => ({
    body: { kind: "queue", input, ...inputOptions },
    gate: () => codexQueueRefusal({ compacting: compaction.busy(), interrupted: state.queuePausedAfterInterrupt, hasSchema: options.outputSchema !== undefined, images: inputOptions?.images }),
    method: "thread/queue/add",
    params: () => ({ threadId, input: codexUserInput(input, inputOptions?.images), clientUserMessageId: inputOptions?.inputId ?? randomUUID() }),
    onReply: (reply) => ({ kind: "accepted", native: reply }),
    onError: (message, native) => codexControlRefusal(message, native),
  });
  // An early or late interrupt can be refused; turn/completed is the outcome.
  const abortPlan = (): RpcControlPlan => {
    let refused: (() => void) | null = null;
    const turnId = compaction.busy() ? compactOperation?.turnId() ?? null : state.codexTurnId;
    return {
      body: { kind: "abort" },
      gate: () => {
        if (compaction.busy() && turnId === null) {
          return { kind: "rejected", code: "busy", reason: "Codex has not yet reported the compaction turn id required by turn/interrupt" };
        }
        if (!busy() || turnId === null) {
          return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
        }
        return null;
      },
      onPending: (accept) => { refused = abortFallback.arm(accept); },
      method: "turn/interrupt",
      params: () => ({ threadId, turnId }),
      onReply: (reply) => ({ kind: "accepted", native: reply }),
      onError: (message, native) => {
        refused?.();
        return codexControlRefusal(message, native);
      },
    };
  };

  // BYOK change: The upstream credentials.seal guard without sealSession: a control's thrown error is redacted.
  // As upstream, compact also redacts its outcome: its reasons can carry native error text.
  const guard = <Args extends unknown[], Result>(method: (...args: Args) => Promise<Result>, cleanResult = false) =>
    async (...args: Args): Promise<Result> => {
      try { const result = await method(...args); return cleanResult ? redactValue(result) : result; } catch (error) { throw redactValue(error); }
    };
  // BYOK change: no nativeSessionFile; the SDK bridge exposes no native session file locator.
  const session: CodexAdapterSession = { // BYOK change: raw adapter without sealSession/observe dependencies.
    id: kernel.sessionId,
    capabilities,
    compact: guard(compaction.compact, true),
    prompt: guard(via(turnProcesses.prompting(promptPlan))),
    steer: guard(via(steerPlan)),
    queue: guard(via(queuePlan)),
    // No withdraw: the queue is codex's own, and thread/queue/delete is experimental and not live-verified (docs/runtimes/input-cancellation.md).
    abort: guard(via(turnProcesses.aborting(abortPlan))),
    stopTask: guard(tasks.stop),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    dispose: guard(() => kernel.dispose(async () => {
      client.kill();
      // Wait for release of the process and its resources. Turn cleanup is synchronous.
      await client.exited;
    })),
  };
  return session;
  } catch (error) {
    // BYOK change: No Session can dispose a failed open; the adapter's close owns the
    // disposal receipt, so this path starts the kill without awaiting a quiescence
    // promise that a failed owned-tree disposal cannot settle.
    killForOpen();
    throw missingDirectoryError(error, options.cwd);
  }
}
