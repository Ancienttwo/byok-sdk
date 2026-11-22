// BYOK change: Modified from OAR bc1b2ac for a caller-owned process, a record consumer, caller-answered app requests and session credential redaction without sealSession (Apache-2.0).
import { writeHeldInput, type HeldStreamJsonInput } from "./held-input.js";

// BYOK change: the narrow bridge reads the same declaration as Runtime.sessionCapabilities.
export const claudeSessionCapabilities = () => ({ steer: true, images: true } as const);
import { streamJsonTaskControl } from "./task-control.js";
import { streamJsonCompaction } from "./compaction.js";
/* oxlint-disable import/max-dependencies -- The driver composes protocol, input and process-lifetime mechanisms. */
import type { AdapterSession, ControlResult, InputOptions, RawEvent, RequestRecord, RuntimeEventBody } from "../../contracts/session.js";
import { createAbortFallback } from "../abort-fallback.js";
import { withInputImages } from "../input-images.js";
import { enqueueHeld, withdrawControl } from "../held-input.js";
import { asRecord, parseJson, type JsonRecord } from "../json.js";
// BYOK change: the injected line process, one credential redactor per open and the upstream kernel; no SessionCredentials or executable manager.
import type { LineProcess } from "../../runtimes/codex/app-server-client.js";
import { isProjectedToolInput, redactRuntimeRecord, type CredentialRedactor, type CredentialRedactionTail } from "../credential-redactor.js";
import { createSessionKernel } from "../session-kernel.js";
import { redactJoinedText } from "../redact-text.js";
import { toolContent } from "../tool-output.js";
import { streamJsonUserMessage, streamJsonPrompted } from "./input-lifecycle.js";
import { foldStreamJsonStdout } from "./projection.js";
import { streamJsonAbortRequested, type StreamJsonProjectionState, type StreamJsonSessionState } from "./state.js";
import type { StreamJsonSessionProfile } from "./profile.js";

/**
 * BYOK change: an interrupt write not acknowledged within the kill fallback's own bound is treated as written,
 * because its bytes can still reach Claude. Every Claude turn has the kill fallback, so once it is armed the
 * requested abort happens within 10 s either way. ACP rolls a timed-out write back instead (#2044): there the
 * kill disposes the whole session.
 */
const INTERRUPT_WRITE_TIMEOUT_MS = 10_000;

/** BYOK change: caller hooks. The record consumer sees every record; the caller alone answers a runtime request. */
export interface StreamJsonSessionHooks {
  readonly onRecord?: (record: RawEvent) => void;
  /** The SDK resumes with the runtime's original root session identity. */
  readonly onSessionInit?: (sessionId: string) => void;
  readonly onRequestCancelled?: (requestId: string) => void;
  /** Every `toApp` request, whatever its type. `respond` writes the native reply and records it; a request never answered stays unanswered. */
  readonly onAppRequest?: (request: { readonly id: string; readonly type: string; readonly native: JsonRecord }, respond: (reply: JsonRecord) => Promise<void>) => void;
  /** Runs before the native interrupt is written; a throw rejects the abort with code `error` and writes no interrupt. */
  readonly beforeInterrupt?: () => void;
}

const streamJsonMessageTypes = new Set(["command_lifecycle", "assistant", "stream_event", "user", "result", "system", "control_response", "control_request", "control_cancel_request", "rate_limit_event"]);
const streamJsonContentTypes = new Set(["text", "thinking", "redacted_thinking", "tool_use", "tool_result"]);
const streamJsonEventTypes = new Set(["message_start", "message_stop", "content_block_start", "content_block_stop", "content_block_delta"]);
const streamJsonDeltaTypes = new Set(["text_delta", "thinking_delta", "input_json_delta"]);
const streamJsonResultTypes = new Set(["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]);
const streamJsonAbortReasons = new Set(["aborted_streaming", "aborted_tools"]);
const streamJsonContextFields = new Set(["tokens", "contextWindow", "percent"]);
const streamJsonDraftEnvelope = new Set(["type", "event", "session_id", "parent_tool_use_id", "api_message_id", "uuid"]);
const streamJsonAssistantEnvelope = new Set(["type", "message", "session_id", "parent_tool_use_id", "uuid", "error", "isReplay", "tool_use_result"]);
const streamJsonMessageFields = new Set(["id", "role", "content", "model", "usage"]);
const streamJsonToolResultFields = new Set(["type", "tool_use_id", "is_error", "content"]);
const streamJsonUsageFields = new Set(["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens", "server_tool_use", "cache_creation"]);
const streamJsonResultFields = new Set(["type", "subtype", "session_id", "parent_tool_use_id", "is_error", "terminal_reason", "result", "usage", "modelUsage", "stop_reason", "api_error_status", "permission_denials", "num_turns", "duration_ms", "duration_api_ms", "total_cost_usd", "fast_mode_state", "structured_output", "errors"]);

interface StreamTextTails {
  readonly drafts: Map<string, CredentialRedactionTail>;
  readonly assistant: Map<string, CredentialRedactionTail>;
  readonly projected: Map<string, CredentialRedactionTail>;
  readonly messages: Map<string, { id: unknown; published: boolean }>;
}

function redactTextPart(tails: Map<string, CredentialRedactionTail>, lane: string, text: string, credentials: CredentialRedactor): string {
  const { ready, pending } = credentials.redactChunk(text, tails.get(lane));
  if (pending === undefined) tails.delete(lane);
  else tails.set(lane, pending);
  return ready;
}

/** Encoded fragments can span frames. The complete assistant tool block carries the usable input. */
export function redactStreamJsonRecord<T extends RawEvent>(record: T, credentials: CredentialRedactor, textTails?: StreamTextTails): T {
  let safe = record;
  const native = record.kind === "frame" ? asRecord(record.body.native) : null;
  const lane = JSON.stringify(record.agentPath);
  const draftTails = textTails?.drafts;
  const assistantTails = textTails?.assistant;
  let terminalText: { text: string; continues: boolean } | undefined;
  let sanitizedText = false;
  let sanitizedFragment: "content_block" | "delta" | undefined;
  const hasOpaqueCredentialKey = (object: JsonRecord | null, fields?: ReadonlySet<string>): boolean => object !== null
    && Object.getOwnPropertyNames(object).some(key => fields?.has(key) !== true && credentials.matches(key));
  if (textTails !== undefined && record.kind === "frame" && record.body.type === "assistant" && native?.type === "assistant"
    && credentials.hasProtectedValues()) {
    const message = asRecord(native.message);
    if (Array.isArray(message?.content)) {
      const currentMessage = textTails.messages.get(lane);
      const continues = currentMessage?.id === message.id;
      let published = continues && currentMessage?.published === true;
      if (!continues) {
        const previous = textTails.assistant.get(lane);
        const text = credentials.finishRedaction(previous);
        if (text !== "") terminalText = { text, continues: currentMessage?.published === true };
        textTails.assistant.delete(lane);
      }
      const withoutSnapshot = hasOpaqueCredentialKey(native, streamJsonAssistantEnvelope) || hasOpaqueCredentialKey(message, streamJsonMessageFields);
      let withheldText = withoutSnapshot;
      const content = message.content.map((block: unknown) => {
        const part = asRecord(block);
        if (part?.type === "thinking") {
          const { thinking: _omitted, ...rest } = part;
          return rest;
        }
        if (part?.type !== "text" || typeof part.text !== "string") return block;
        if (withoutSnapshot || hasOpaqueCredentialKey(part)) {
          withheldText = true;
          return block;
        }
        const ready = redactTextPart(textTails.assistant, lane, part.text, credentials);
        published ||= ready.trim() !== "";
        return ready === part.text ? block : { ...part, text: ready };
      });
      textTails.messages.set(lane, { id: message.id, published });
      const events = record.body.events.flatMap<RuntimeEventBody>(event => {
        if (event.kind === "reasoning") return [];
        if (event.kind !== "text_delta") return [event];
        // Projected suffixes do not carry a block index. Keep the surviving native blocks authoritative.
        if (withheldText) return [];
        const ready = redactTextPart(textTails.projected, lane, event.text, credentials);
        return ready === "" ? [] : [{ ...event, text: ready }];
      });
      sanitizedText = true;
      safe = { ...record, body: { ...record.body, native: { ...native, message: { ...message, content } }, events } };
    }
  }
  if (credentials.hasProtectedValues() && record.kind === "frame" && record.body.type === "stream_event") {
    const event = asRecord(native?.event);
    const isStart = event?.type === "content_block_start";
    const delta = asRecord(isStart ? event.content_block : event?.delta);
    const textField = delta?.type === "text" || delta?.type === "text_delta" ? "text" : undefined;
    const fragmentField = isStart ? "content_block" : "delta";
    if (event?.type === "message_start" || event?.type === "message_stop") draftTails?.delete(lane);
    if (draftTails !== undefined && (isStart || event?.type === "content_block_delta") && typeof event.index === "number"
      && textField !== undefined && typeof delta?.text === "string") {
      const withheldText = hasOpaqueCredentialKey(native, streamJsonDraftEnvelope) || hasOpaqueCredentialKey(event) || hasOpaqueCredentialKey(delta);
      const ready = withheldText ? "" : redactTextPart(draftTails, lane, delta.text, credentials);
      const events = record.body.events.flatMap<RuntimeEventBody>(projected => {
        if (projected.kind !== "text_delta") return [projected];
        if (withheldText) return [];
        const text = textTails === undefined ? ready : redactTextPart(textTails.projected, lane, projected.text, credentials);
        return text === "" ? [] : [{ ...projected, text }];
      });
      sanitizedText = true;
      sanitizedFragment = fragmentField;
      safe = { ...record, body: { ...record.body, native: { ...native, event: { ...event, [fragmentField]: { ...delta, text: ready } } }, events } };
    }
    if ((isStart && delta?.type === "thinking") || (event?.type === "content_block_delta" && delta?.type === "thinking_delta")) {
      const { thinking: _omitted, ...rest } = delta;
      safe = { ...record, body: { ...record.body, native: { ...native, event: { ...event, [fragmentField]: rest } },
        events: record.body.events.filter(projected => projected.kind !== "reasoning") } };
    }
    if (event?.type === "content_block_delta" && delta?.type === "input_json_delta") {
      const { partial_json: _omitted, ...rest } = delta;
      safe = { ...record, body: { ...record.body, native: { ...native, event: { ...event, delta: rest } },
        events: record.body.events.filter(projected => projected.kind !== "tool_call_input_delta") } };
    }
  }
  if (safe.kind === "frame" && native !== null && credentials.hasProtectedValues()) {
    const isContentMessage = native.type === "assistant" || native.type === "user";
    const message = isContentMessage ? asRecord(native.message) : null;
    const draft = native.type === "stream_event" ? asRecord(native.event) : null;
    const draftBlock = draft?.type === "content_block_start" ? asRecord(draft.content_block) : null;
    const blocks: readonly unknown[] = Array.isArray(message?.content) ? message.content : draftBlock === null ? [] : [draftBlock];
    const envelope = isContentMessage ? streamJsonAssistantEnvelope : streamJsonDraftEnvelope;
    const withheldMessage = hasOpaqueCredentialKey(native, envelope) || hasOpaqueCredentialKey(message, streamJsonMessageFields) || hasOpaqueCredentialKey(draft);
    const withheldCalls = new Set<unknown>();
    for (const block of blocks) {
      const part = asRecord(block);
      if (part?.type === "tool_use" && (withheldMessage || hasOpaqueCredentialKey(part))) withheldCalls.add(part.id ?? "unknown");
      if (part?.type === "tool_result" && (withheldMessage || hasOpaqueCredentialKey(part, streamJsonToolResultFields))) withheldCalls.add(part.tool_use_id);
    }
    if (withheldCalls.size !== 0) {
      const events = safe.body.events.filter(event => !("callId" in event) || !withheldCalls.has(event.callId));
      safe = { ...safe, body: { ...safe.body, events } };
    }
  }
  let redacted = redactRuntimeRecord(safe, credentials.redactValue, path => isProjectedToolInput(safe, path), (path, value) => {
    const [body, native, field, group, block, member] = path;
    if (body !== "body" || safe.kind !== "frame") return false;
    if (sanitizedText && native === "events" && typeof field === "number" && path.length === 4
      && group === "text" && safe.body.events[field]?.kind === "text_delta") return true;
    if (native !== "native" || record.kind !== "frame") return false;
    if (sanitizedFragment !== undefined && field === "event" && path.length === 5 && group === sanitizedFragment && block === "text") return true;
    if (sanitizedText && record.body.type === "assistant" && field === "message" && group === "content"
      && typeof block === "number" && member === "text" && path.length === 6) {
      const content = asRecord(asRecord(record.body.native)?.message)?.content;
      if (Array.isArray(content) && asRecord(content[block])?.type === "text") return true;
    }
    if (path.length === 3) {
      if (field === "type") return streamJsonMessageTypes.has(value);
      if (asRecord(record.body.native)?.type === "result") {
        if (field === "subtype") return streamJsonResultTypes.has(value);
        if (field === "terminal_reason") return streamJsonAbortReasons.has(value);
      }
    }
    const types = asRecord(record.body.native);
    if (types?.type === "stream_event" && record.body.type === "stream_event") {
      if (path.length === 4 && field === "event" && group === "type") return streamJsonEventTypes.has(value);
      if (path.length === 5 && field === "event" && group === "delta" && block === "type") {
        return asRecord(types.event)?.type === "content_block_delta" && streamJsonDeltaTypes.has(value);
      }
    }
    return (types?.type === "assistant" || types?.type === "user") && path.length === 6 && field === "message"
      && group === "content" && typeof block === "number" && member === "type" && streamJsonContentTypes.has(value);
  }, (path, key) => {
    const [body, nativeKey, section, entry, index] = path;
    if (body === "body" && nativeKey === "events" && typeof section === "number" && entry === "usage" && index === "context"
      && path.length === 5 && record.kind === "frame" && record.body.events[section]?.kind === "usage") return streamJsonContextFields.has(key);
    if (body !== "body" || nativeKey !== "native") return false;
    if (native?.type === "stream_event" && path.length === 2 && streamJsonDraftEnvelope.has(key)) return true;
    if (native?.type === "assistant" || native?.type === "user") {
      if (path.length === 2 && streamJsonAssistantEnvelope.has(key)) return true;
      if (path.length === 3 && section === "message" && streamJsonMessageFields.has(key)) return true;
    }
    if (native?.type === "user" && path.length === 5 && section === "message" && entry === "content" && typeof index === "number") {
      const blocks = asRecord(native.message)?.content;
      return Array.isArray(blocks) && asRecord(blocks[index])?.type === "tool_result" && streamJsonToolResultFields.has(key);
    }
    if (native?.type !== "result") return false;
    return (path.length === 2 && streamJsonResultFields.has(key))
      || (path.length === 3 && section === "usage" && streamJsonUsageFields.has(key))
      || (path.length === 4 && section === "modelUsage" && key === "contextWindow");
  });
  if (redacted.kind === "frame" && safe.kind === "frame" && native?.type === "user") {
    const original = asRecord(native.message)?.content;
    const packet = asRecord(redacted.body.native);
    const message = asRecord(packet?.message);
    const sanitized = message?.content;
    if (Array.isArray(original)) {
      const { content, input } = redactJoinedText(original, sanitized, credentials.redact);
      const events = redacted.body.events.map((event, index) => {
        if (event.kind === "user_message") return { ...event, input };
        const source = safe.kind === "frame" ? safe.body.events[index] : undefined;
        if (event.kind !== "tool_call_ended" || source?.kind !== "tool_call_ended" || original === sanitized) return event;
        const slot = original.findIndex(block => {
          const part = asRecord(block);
          return part?.type === "tool_result" && part.tool_use_id === source.callId;
        });
        const block = Array.isArray(sanitized) ? sanitized[slot] : undefined;
        if (slot < 0 || original[slot] === block) return event;
        const { content: _original, ...rest } = event;
        const output = toolContent(asRecord(block)?.content);
        return output === undefined ? rest : { ...rest, content: output };
      });
      const updated = message !== null && content !== sanitized ? { ...packet, message: { ...message, content } } : redacted.body.native;
      redacted = { ...redacted, body: { ...redacted.body, native: updated, events } };
    }
  }
  if (redacted.kind === "frame" && native?.type === "result" && asRecord(redacted.body.native) === null && record.kind === "frame") {
    // Keep terminal evidence even if an opaque native key requires withholding the native map.
    const fields = Object.fromEntries(Object.entries(native).filter(([key]) => streamJsonResultFields.has(key)));
    const result = redactStreamJsonRecord({ ...record, body: { ...record.body, native: fields, events: [] } }, credentials).body.native;
    const body = { ...redacted.body, byokResult: result };
    redacted = { ...redacted, body };
  }
  if (redacted.kind !== "frame") return redacted;
  if (textTails !== undefined && assistantTails !== undefined && native?.type === "result") {
    draftTails?.delete(lane);
    const projectedTail = credentials.finishRedaction(textTails.projected.get(lane));
    textTails.projected.delete(lane);
    if (projectedTail !== "") {
      redacted = { ...redacted, body: { ...redacted.body,
        events: [{ kind: "text_delta", text: projectedTail }, ...redacted.body.events] } };
    }
    const tail = credentials.finishRedaction(assistantTails.get(lane));
    const message = textTails.messages.get(lane);
    assistantTails.delete(lane);
    textTails.messages.delete(lane);
    if (tail !== "") terminalText = { text: tail, continues: message?.published === true };
  }
  if (terminalText === undefined || redacted.kind !== "frame") return redacted;
  const body = { ...redacted.body, byokTextTail: terminalText };
  return { ...redacted, body };
}

/** Shared line protocol driver. A runtime launches its own process and supplies its own readbacks. */
export async function streamJsonSession<S extends StreamJsonProjectionState>(
  child: LineProcess,
  sessionId: string,
  credentials: CredentialRedactor, // BYOK change: the caller builds it with sessionCredentialRedactor.
  profile: StreamJsonSessionProfile<S>,
  hooks: StreamJsonSessionHooks = {},
  retainedBytes?: number, // BYOK change: the caller's retained-record budget; old frame payloads are elided past it.
): Promise<AdapterSession> {
  // BYOK change: the upstream kernel with the redactor as its redact hook; the record consumer is registered before any record is appended.
  const textTails: StreamTextTails = { drafts: new Map(), assistant: new Map(), projected: new Map(), messages: new Map() };
  const kernel = createSessionKernel(sessionId, record => redactStreamJsonRecord(record, credentials, textTails), retainedBytes);
  if (hooks.onRecord !== undefined) { kernel.rawEvents(hooks.onRecord); }
  const tasks = profile.stopTask === undefined ? undefined : streamJsonTaskControl(kernel, child, profile.stopTask);
  const nativeUserMessage = profile.userMessage ?? streamJsonUserMessage;
  const userMessage: typeof nativeUserMessage = (input, id, images) => {
    for (const image of images ?? []) credentials.addImage(image.data);
    return nativeUserMessage(input, id, images);
  };
  const state: StreamJsonSessionState<S> = { child, active: null, projection: profile.initial };
  // Hold queues until turn end; active-turn writes may steer or become an irreversible native queue.
  const commandLifecycle = profile.projection.commandLifecycle !== false;
  const writtenQueues = new Map<string, RequestRecord>();
  const heldQueue: HeldStreamJsonInput[] = [];
  let dispatching = false;
  const nativeBusy = (): boolean => state.active !== null || state.projection.nativeTurnActive;
  const compaction = streamJsonCompaction(kernel, profile, state, drainHeld, () => heldQueue.length > 0);
  const busy = (): boolean => dispatching || nativeBusy() || compaction?.busy() === true;
  let canCancelQueued = false;
  const abortFallback = createAbortFallback(() => { child.kill(); });
  const pendingInterrupts = new Map<string, () => void>();
  // BYOK change: interrupts of this turn not refused; the abort mark stands while one remains.
  const aborting = new Set<string>();
  const withdrawAbort = (requestId: string): void => {
    if (aborting.delete(requestId) && aborting.size === 0) { state.projection = { ...state.projection, abortRequested: false }; }
  };
  // BYOK change: a root result that arrives while an interrupt's write or answer is pending waits,
  // with every later line except control responses, until each pending interrupt settles;
  // the result is then folded with the mark the accepted interrupts leave.
  // The SDK Claude lane has no Qwen root-result readback. Keep the interrupt
  // barrier as the owner of the held result and preserve each line’s receipt time.
  let heldLines: Array<{ line: string; receivedAt: number }> | null = null;
  let exited = false;
  // BYOK change: once the kill fallback fires, nothing more is dispatched to the process it kills.
  let killing = false;
  const releaseHeld = (): void => {
    if (heldLines === null || (pendingInterrupts.size > 0 && !exited)) { return; }
    const lines = heldLines;
    heldLines = null;
    for (const [index, { line, receivedAt }] of lines.entries()) {
      // receive can hold again, for a new abort's interrupt.
      const again = heldLines as typeof lines | null;
      if (again !== null) { again.push(...lines.slice(index)); return; }
      receive(line, receivedAt);
    }
  };
  // BYOK change: no upstream cancellation observation window; the caller's beforeInterrupt runs synchronously before the interrupt.
  function drainHeld(): void {
    if (exited || killing || kernel.unreachable() !== null || busy() || heldQueue[0]?.accepted !== true) { return; }
    const next = heldQueue.shift();
    if (next === undefined) { return; }
    dispatching = true;
    const { inputId: _inputId, ...options } = next.options;
    const request = kernel.request("toRuntime", { kind: "prompt", input: next.input, ...options, carries: [next.inputId ?? next.request.id] });
    const response = writeHeldInput(state, next, { kernel, commandLifecycle, writtenQueues, held: heldQueue, userMessage, advance: () => { dispatching = false; } });
    dispatching = false;
    kernel.respond(request.id, response);
    if (response.kind === "accepted") { drainHeld(); }
  }
  // The fold translates and attributes facts; this driver owns transport, busy and queue drain.
  child.onLine((line) => {
    receive(line, Date.now());
    releaseHeld();
  });
  function receive(line: string, receivedAt: number): void {
    const message = asRecord(parseJson(line));
    if (message === null) { return; }
    if (heldLines !== null && message.type !== "control_response") { heldLines.push({ line, receivedAt }); return; }
    if (message.type === "result" && (typeof message.parent_tool_use_id !== "string" || message.parent_tool_use_id.length === 0) && pendingInterrupts.size > 0 && !exited) {
      heldLines = [{ line, receivedAt }];
      return;
    }
    if (message.type === "system" && message.subtype === "init" && typeof message.parent_tool_use_id !== "string" && Array.isArray(message.capabilities)) {
      canCancelQueued = profile.cancelQueuedCapability !== undefined && message.capabilities.includes(profile.cancelQueuedCapability);
    }
    if (message.type === "control_cancel_request" && typeof message.request_id === "string") hooks.onRequestCancelled?.(message.request_id);
    if (tasks?.consume(message) === true || profile.consume(message)) { return; }
    const { state: nextProjection, commands } = foldStreamJsonStdout(profile.projection, state.projection, message);
    state.projection = nextProjection;
    if (message.type === "command_lifecycle" && message.state === "queued" && typeof message.command_uuid === "string") {
      const queued = writtenQueues.get(message.command_uuid);
      if (queued !== undefined && state.active === null) { state.active = queued; }
    }
    if (message.type === "command_lifecycle" && (message.state === "completed" || message.state === "cancelled") && typeof message.command_uuid === "string") {
      writtenQueues.delete(message.command_uuid);
    }
    let ended = false;
    let dropped = false;
    for (const command of commands) {
      switch (command.kind) {
        case "frame": {
          const nativeResponse = profile.compaction?.responseTo?.(message);
          const correlated = command.agentPath.length === 0 && nativeResponse !== undefined && nativeResponse === compaction?.requestId();
          const closes = command.agentPath.length === 0 && (correlated || command.body.events.some((event) => event.kind === "turn_ended"));
          if (closes) {
            abortFallback.clear();
            aborting.clear();
            if (state.projection.pendingInputId === null) { state.active = null; }
            if (correlated && state.projection.nativeTurnActive) {
              state.projection = { ...state.projection, nativeTurnActive: false, turnActive: false };
            }
          }
          const cancelled = command.body.events.find((event) => event.kind === "input_dropped");
          if (command.agentPath.length === 0 && cancelled?.kind === "input_dropped" && cancelled.inputId !== undefined) {
            writtenQueues.delete(cancelled.inputId);
            if (state.active !== null && cancelled.inputId === (state.active.body.kind === "compact" ? state.active.id : ("inputId" in state.active.body ? state.active.body.inputId : undefined))) { state.active = null; }
          }
          if (command.agentPath.length === 0 && message.type === "system" && message.subtype === "init"
            && typeof message.session_id === "string" && message.session_id.length > 0) {
            hooks.onSessionInit?.(message.session_id);
          }
          const record = kernel.frame(correlated ? { ...command.body, responseTo: nativeResponse } : command.body, { agentPath: command.agentPath, receivedAt });
          if (record.agentPath.length > 0) { break; }
          ended ||= closes;
          dropped ||= cancelled !== undefined;
          break;
        }
        case "respond": {
          const refused = pendingInterrupts.get(command.requestId);
          if (refused !== undefined) {
            pendingInterrupts.delete(command.requestId);
            if (command.body.kind === "rejected") { refused(); }
            kernel.respond(command.requestId, command.body);
          } else {
            // Preserve late/duplicate stdout after exit without answering a request twice.
            kernel.frame({ type: "control_response", native: message, events: [] });
          }
          break;
        }
        case "toApp": {
          kernel.request("toApp", { kind: "native", type: command.type, native: command.native }, { id: command.id });
          // BYOK change: every runtime request goes to the caller, whatever its type; profile.permissionResponse is not read.
          // Without a hook, or when the hook does not answer, the request stays unanswered: nothing here allows by default.
          hooks.onAppRequest?.({ id: command.id, type: command.type, native: message }, async (reply) => {
            await child.writeAcknowledged(`${JSON.stringify(reply)}\n`);
            kernel.respond(command.id, { kind: "accepted", native: reply });
          });
          break;
        }
        default:
          break;
      }
    }
    if (dropped && !ended && !busy()) {
      abortFallback.clear();
      aborting.clear();
      if (state.projection.pendingInputId === null) { state.active = null; }
    }
    if (ended || (dropped && !busy())) { drainHeld(); }
  }
  // BYOK change: the injected line process reports no cleanup reason; only the profile's exit reason is recorded.
  child.onExit((code) => {
    abortFallback.clear();
    // BYOK change: the exit refuses every pending interrupt, so a held result is published as Claude reported it.
    exited = true;
    for (const requestId of pendingInterrupts.keys()) { withdrawAbort(requestId); }
    releaseHeld();
    aborting.clear();
    // An exit before fallback still precedes the rejected pending controls.
    const reason = profile.exitReason?.();
    kernel.processExited(code, reason);
    state.active = null;
    state.projection = { ...state.projection, nativeTurnActive: false, turnActive: false };
    for (const requestId of pendingInterrupts.keys()) {
      pendingInterrupts.delete(requestId);
      kernel.respond(requestId, { kind: "rejected", code: "runtime_exited", reason: "runtime exited" });
    }
    tasks?.end();
    profile.exited(code);
  });
  // BYOK change: an open failure is redacted; the caller owns the process and releases it.
  try {
    await profile.open({ current: () => state.projection, replace: (projection) => { state.projection = projection; }, report: (body) => { kernel.frame(body); } });
  } catch (error) { throw credentials.redactValue(error); }
  let interruptCounter = 0;
  const capabilities = profile.capabilities;
  // BYOK change: the upstream credentials.seal guard without sealSession: a control's thrown error is redacted.
  const guard = <Args extends unknown[], Result>(method: (...args: Args) => Promise<Result>, cleanResult = false) =>
    async (...args: Args): Promise<Result> => {
      try { const result = await method(...args); return cleanResult ? credentials.redactValue(result) : result; } catch (error) { throw credentials.redactValue(error); }
    };
  const session: AdapterSession = { // BYOK change: raw adapter session without sealSession.
    id: kernel.sessionId,
    capabilities,
    ...(compaction === null ? {} : { compact: guard(compaction.compact, true) }),
    ...(tasks === undefined ? {} : { stopTask: guard(tasks.stop) }),
    prompt: guard(async (input: string, inputOptions?: InputOptions): Promise<ControlResult> => {
      const body = { kind: "prompt" as const, input, ...inputOptions };
      return kernel.control(body, (request) => {
        if (busy() || heldQueue.length > 0) { return { kind: "rejected", code: "busy", reason: "busy" }; }
        return withInputImages(capabilities, inputOptions?.images, (images) => {
          state.active = request;
          state.projection = streamJsonPrompted(state.projection, inputOptions?.inputId, true, commandLifecycle);
          child.write(userMessage(input, inputOptions?.inputId, images));
          return { kind: "accepted" };
        });
      });
    }),
    ...(profile.steer ? {
      steer: guard(async (input: string, inputOptions?: InputOptions): Promise<ControlResult> => {
        return kernel.control({ kind: "steer", input, ...inputOptions }, () => {
          if (compaction?.busy() === true) { return { kind: "rejected", code: "busy", reason: "Manual compaction is still in progress" }; }
          if (!nativeBusy()) { return { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" }; }
          return withInputImages(capabilities, inputOptions?.images, (images) => {
            child.write(userMessage(input, inputOptions?.inputId, images));
            return { kind: "accepted" };
          });
        });
      }),
    } : {}),
    queue: guard(async (input: string, inputOptions?: InputOptions): Promise<ControlResult> => {
      const result = await kernel.control({ kind: "queue", input, ...inputOptions }, (request) =>
        withInputImages(capabilities, inputOptions?.images, (images) => {
          const unreachable = kernel.unreachable();
          if (unreachable !== null) { return unreachable; }
          enqueueHeld(heldQueue, { request, input, ...(inputOptions?.inputId === undefined ? {} : { inputId: inputOptions.inputId }), options: { ...inputOptions }, images });
          return { kind: "accepted", queued: "adapter" };
        }));
      const entry = heldQueue.find(next => next.request.id === result.request.id);
      if (entry !== undefined && result.response.body.kind === "accepted") { entry.accepted = true; }
      drainHeld();
      return result;
    }),
    withdraw: guard(async (inputId: string) => { const result = await withdrawControl(kernel, heldQueue)(inputId); drainHeld(); return result; }),
    abort: guard(async (): Promise<ControlResult> => {
      // The matching control_response answers interrupt; the result frame ends the turn.
      interruptCounter += 1;
      const requestId = `interrupt-${interruptCounter}`;
      // Record by hand so the fold can answer this id from control_response; gate reachability here.
      const blocked = kernel.unreachable() ?? (compaction?.busy() === true && !compaction.admitted()
        ? { kind: "rejected", code: "busy", reason: "Claude has not yet dispatched the compact command that abort would cancel" } as const : null);
      const request = kernel.request("toRuntime", { kind: "abort" }, { id: requestId });
      if (blocked !== null || (!nativeBusy() && compaction?.busy() !== true && !(canCancelQueued && state.projection.unstartedInputs.size > 0))) {
        return { request, response: kernel.respond(request.id, blocked ?? { kind: "rejected", code: "no_active_turn", reason: "no active turn" }) };
      }
      // BYOK change: the caller's synchronous hook replaces the upstream cancellation observation; no interrupt goes out unless it returns.
      try { hooks.beforeInterrupt?.(); }
      catch (error) {
        return { request, response: kernel.respond(request.id, { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) }) };
      }
      state.projection = streamJsonAbortRequested(state.projection);
      aborting.add(requestId);
      const { promise, resolve } = Promise.withResolvers<ControlResult>();
      const unsubscribe = kernel.rawEvents((record) => {
        if (record.kind === "response" && record.requestId === requestId) {
          resolve({ request, response: record });
        }
      });
      // BYOK change: pending until its write and Claude's answer settle. A refusal withdraws its
      // fallback attempt and its share of the abort mark; the fallback is armed only once the write is acknowledged.
      let withdrawFallback = (): void => {};
      pendingInterrupts.set(requestId, () => { withdrawFallback(); withdrawAbort(requestId); });
      const line = `${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "interrupt", ...(canCancelQueued && state.projection.unstartedInputs.size > 0 ? { cancel_queued: true } : {}) },
      })}\n`;
      let timer: NodeJS.Timeout | undefined;
      void Promise.race([
        (async () => { await child.writeAcknowledged(line); })(),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, INTERRUPT_WRITE_TIMEOUT_MS); timer.unref(); }),
      ]).then(() => {
        clearTimeout(timer);
        // An answer can precede the acknowledgement; an accepted interrupt is still bounded.
        if (!aborting.has(requestId)) { return; }
        // A repeated abort during termination is taken over synchronously too.
        // The held result is published at the exit, after the kill, so no queued input reaches this process.
        withdrawFallback = abortFallback.arm(() => {
          killing = true;
          if (pendingInterrupts.delete(requestId)) { kernel.respond(requestId, { kind: "accepted" }); }
        });
      }, (error: unknown) => {
        clearTimeout(timer);
        // A write that failed was never written: it leaves the turn as it was, no mark, no fallback kill.
        const refused = pendingInterrupts.get(requestId);
        if (refused === undefined) { return; }
        pendingInterrupts.delete(requestId);
        refused();
        kernel.respond(requestId, { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) });
        releaseHeld();
      });
      const result = await promise;
      unsubscribe();
      return result;
    }),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    // BYOK change: the injected line process has no resources reader, and the SDK profile exposes no model request.
    ...(profile.contextBreakdown === undefined ? {} : { contextBreakdown: profile.contextBreakdown }),
    dispose: guard(() => kernel.dispose(async () => {
      profile.disposing();
      tasks?.end();
      if (profile.close === undefined) { child.kill(); }
      else { await profile.close(busy()); }
      await child.exited;
    }, () => { profile.disposing(); })),
  };
  return session;
}
