// BYOK change: Modified from OAR bc1b2ac for an injected process, a required explicit environment, a record consumer and session credential redaction without sealSession (Apache-2.0).
/* oxlint-disable import/max-dependencies -- Native launch, controls, projection and the credential boundary meet here. */
/* oxlint-disable eslint/require-await -- Session controls return kernel promises directly. */
import { randomUUID } from "node:crypto";

// BYOK change: the narrow bridge reads the same declaration as Runtime.sessionCapabilities.
export const dshSessionCapabilities = () => ({ images: false } as const);
import type { AvailableInstallation } from "../../contracts/installation.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { ResumeCwdError } from "../../contracts/resume-cwd-error.js";
import { RuntimeFailureError } from "../../contracts/runtime-failure-error.js";
import { ModelConfirmationError } from "../../contracts/model-confirmation-error.js";
import { SessionNotFoundError } from "../../contracts/session-not-found-error.js";
import type { AdapterSession, ControlResult, InputOptions, RawEvent, ResponseBody, SessionOptions } from "../../contracts/session.js";
import { createAbortFallback } from "../../shared/abort-fallback.js";
import { withInputImages } from "../../shared/input-images.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { sameDirectory } from "../../shared/same-directory.js";
import { checkSessionName, refuseSessionOptions } from "../../shared/session-options.js";
// BYOK change: Build the session credential redactor directly; upstream withSessionCredentials imports sealSession.
import { sessionCredentialRedactor, type CredentialRedactor } from "../../shared/credential-redactor.js";
import { createSessionKernel } from "../../shared/session-kernel.js";
import { DshCommandError, dshControl, type DshControl } from "./control.js";
import { launchDsh, type DshLaunch, type DshLineProcess, type SpawnDshLineProcess } from "./launch.js";
import { dshMcpRows } from "./mcp.js";
import { dshAgentOptions, dshRefusedSessionOptions, type DshAgentOptions } from "./options.js";
import { dshOpenedFrame, foldDsh, initialDshProjection, redactDshRecord } from "./projection.js";

const OPEN_TIMEOUT_MS = 60_000;
const DISPOSE_TIMEOUT_MS = 8000;

// BYOK change: the caller owns the process and the launch; the environment is required and explicit.
export type DshSessionOptions = Pick<SessionOptions, "cwd" | "model" | "effort" | "resume" | "mcpServers" | "name" | "disallowedTools" | "systemPrompt" | "appendSystemPrompt" | "retainedBytes"> & { readonly launch: DshLaunch };

// BYOK change: the session always carries steer.
export interface DshAdapterSession extends AdapterSession {
  steer(input: string, options?: InputOptions): Promise<ControlResult>;
}

export interface DshSessionHooks {
  /** BYOK change: Caller-resolved credentials for redaction before retention and diagnostic delivery. */
  readonly credentialsForRedaction?: readonly string[];
  /** The session id, before any record is delivered; a throw fails the open. */
  readonly onReady?: (sessionId: string) => void;
  /** BYOK change: Check the root request route before sanitizing it for observers. */
  readonly onRouteMismatch?: () => void;
  /** A kernel observer from seq 0. The kernel swallows its errors, so it fails the session itself. */
  readonly onRecord?: (record: RawEvent) => void;
}

/** Typed opening refusals from native evidence; anything else keeps its own message and native error as cause. */
function openFailure(error: unknown, sessionId: string, resuming: boolean): unknown {
  if (!(error instanceof DshCommandError)) { return error; }
  if (error.native.name === "SessionPersistenceNotFoundError") {
    return new SessionNotFoundError(sessionId, `DSH has no saved session ${sessionId}`, { method: "sessionPersistence.open", native: error.native });
  }
  if ((error.code === "native_method_unavailable" || error.code === "option_not_applied") && (error.capability === "name" || error.capability === "disallowedTools")) {
    return new UnsupportedOptionError(error.capability, error.message);
  }
  if (error.code === "prompt_not_applied" && (error.capability === "systemPrompt" || error.capability === "appendSystemPrompt")) {
    return new UnsupportedOptionError(error.capability, error.message);
  }
  if (error.code === "native_method_unavailable") {
    if (error.capability === "confirming a reasoning effort") { return new UnsupportedOptionError("effort", error.message); }
    if (error.capability === "systemPrompt" || error.capability === "appendSystemPrompt") { return new UnsupportedOptionError(error.capability, error.message); }
    if (error.capability === "session MCP") { return new UnsupportedOptionError("mcpServers", error.message); }
    if (error.capability === "goals") { return new UnsupportedOptionError(error.capability, error.message); }
    if (error.capability === "confirming a model") { return new UnsupportedOptionError("model", error.message); }
    return resuming ? new UnsupportedOptionError("resume", error.message) : new RuntimeFailureError("invalid_request", error.message, { cause: error });
  }
  if (error.code === "UNSUPPORTED_REASONING_EFFORT") { return new UnsupportedOptionError("effort", error.message); }
  if (error.code === "UNKNOWN_MODEL" || error.code === "NO_ADAPTER") { return new RuntimeFailureError("model_unavailable", error.message, { cause: error }); }
  return error;
}

/** Where the runtime already reports its selection, a request it did not take is refused rather than run on another route. */
function refuseUnappliedRoute(opened: JsonRecord, requested: DshAgentOptions, requestedModel: string | undefined): void {
  const reported = asRecord(opened.model);
  if (reported === null) { return; }
  if (requestedModel !== undefined && requested.provider !== undefined && (reported.provider !== requested.provider || reported.model !== requested.model)) {
    throw new ModelConfirmationError(`DSH did not apply model ${requested.provider}/${String(requested.model)}: it reports ${String(reported.provider)}/${String(reported.model)}`, {
      requested: requestedModel,
      reported: typeof reported.provider === "string" && typeof reported.model === "string" ? `${reported.provider}/${reported.model}` : null,
    });
  }
  if (requested.reasoningEffort !== undefined && reported.reasoningEffort !== requested.reasoningEffort) {
    throw new UnsupportedOptionError("effort", `DSH did not apply effort ${requested.reasoningEffort}: it reports ${String(reported.reasoningEffort)}`);
  }
}

/** Native resume has no cwd override: the session runs where it was saved, whatever process cwd it resumes from. */
async function savedRoute(control: DshControl, sessionId: string, cwd: string): Promise<JsonRecord | undefined> {
  const saved = await control.request("peek", { sessionId }, OPEN_TIMEOUT_MS);
  const savedCwd = asRecord(saved.header)?.cwd;
  if (typeof savedCwd !== "string") { throw new UnsupportedOptionError("resume", `DSH's saved session ${sessionId} names no working directory to compare`); }
  if (!sameDirectory(savedCwd, cwd)) {
    throw new ResumeCwdError(`session ${sessionId} lives in ${savedCwd} and DSH resumes it only there; the resume names ${cwd}`, {
      sessionId, requestedCwd: cwd, reason: "other_cwd", savedCwd,
    });
  }
  return asRecord(saved.route) ?? undefined;
}

function refusalOf(error: unknown): ResponseBody {
  if (!(error instanceof DshCommandError)) { return { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) }; }
  if (error.code === "busy") { return { kind: "rejected", code: "busy", reason: "busy" }; }
  if (error.code === "no_active_turn") { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
  if (error.code === "native_method_unavailable") { return { kind: "rejected", code: "unsupported", reason: error.message, native: error.native }; }
  return { kind: "rejected", code: "runtime_refused", reason: error.message, native: error.native };
}

const inputFields = (text: string, inputId: string | undefined): JsonRecord => ({ text, ...(inputId === undefined ? {} : { inputId }) });

async function open(spawnLineProcess: SpawnDshLineProcess, command: string, options: DshSessionOptions, hooks: DshSessionHooks, credentials: CredentialRedactor, mcpRows: readonly JsonRecord[]): Promise<DshAdapterSession> {
  const sessionId = options.resume ?? randomUUID();
  const agentOptions = dshAgentOptions(options);
  // BYOK change: the record consumer observes from seq 0: it registers before any frame.
  const kernel = createSessionKernel(sessionId, record => {
    const safe = redactDshRecord(record, credentials);
    if (safe.kind !== "frame") return safe;
    const body = { ...safe.body, byokRoot: record.sessionId === sessionId && record.agentPath.length === 0 };
    return { ...safe, body };
  }, options.retainedBytes);
  if (hooks.onRecord !== undefined) { kernel.rawEvents(hooks.onRecord); }
  hooks.onReady?.(sessionId);
  let projection = initialDshProjection(sessionId);
  const child: DshLineProcess = await launchDsh(spawnLineProcess, command, options.launch, mcpRows);
  const fallback = createAbortFallback(() => { child.kill(); });
  const control = dshControl(child, (message) => {
    const { state, frame } = foldDsh(projection, message);
    projection = state;
    if (frame.sessionId === undefined && options.model !== undefined && hooks.onRouteMismatch !== undefined
      && frame.body.events.some(event => event.kind === "model" && event.model !== options.model)) {
      hooks.onRouteMismatch();
      return;
    }
    kernel.frame(frame.body, frame.sessionId === undefined ? undefined : { sessionId: frame.sessionId });
    if (frame.sessionId === undefined && frame.body.events.some((event) => event.kind === "turn_ended")) { fallback.clear(); }
  });
  child.onExit((code) => {
    fallback.clear();
    kernel.processExited(code);
  });
  const fields = { sessionId, agentOptions: { ...agentOptions },
    ...(options.disallowedTools === undefined ? {} : { disallowedTools: options.disallowedTools }),
    ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    ...(options.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: options.appendSystemPrompt }),
  };
  let opened: JsonRecord = {};
  try {
    await control.ready;
    if (options.resume === undefined) { opened = await control.request("open", { ...fields, cwd: options.cwd }, OPEN_TIMEOUT_MS); }
    else {
      const route = await savedRoute(control, sessionId, options.cwd);
      opened = await control.request("resume", { ...fields, ...(route === undefined ? {} : { route }) }, OPEN_TIMEOUT_MS);
    }
    refuseUnappliedRoute(opened, agentOptions, options.model);
    if (opened.sessionId !== sessionId) { throw new Error(`DSH opened ${String(opened.sessionId)}, not ${sessionId}`); }
    if (options.name !== undefined) { await control.request("name", { sessionId, name: options.name, resuming: options.resume !== undefined }, OPEN_TIMEOUT_MS); }
  } catch (error) {
    child.kill();
    await child.exited;
    throw openFailure(error, sessionId, options.resume !== undefined);
  }
  kernel.frame(dshOpenedFrame(opened));
  if (asRecord(opened.methods)?.steer !== true) {
    child.kill();
    await child.exited;
    throw new RuntimeFailureError("invalid_request", "This DSH does not provide steer(), which the SDK declares");
  }

  const capabilities = { queue: { durable: false }, attribution: "nested", images: false } as const;
  const inboxMethods = asRecord(opened.inboxMethods) ?? {};
  const send = async (method: string, payload: JsonRecord): Promise<ResponseBody> => {
    try { return { kind: "accepted", native: await control.request(method, { sessionId, ...payload }) }; }
    catch (error) { return refusalOf(error); }
  };
  const active = (): boolean => projection.sessions[sessionId]?.turnOpen === true;

  // BYOK change: The upstream credentials.seal guard without sealSession: a control's thrown error is redacted.
  const guard = <Args extends unknown[], Result>(method: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      try { return await method(...args); } catch (error) { throw credentials.redactValue(error); }
    };
  const session: DshAdapterSession = {
    id: sessionId, capabilities,
    prompt: guard(async (text: string, inputOptions?: InputOptions): Promise<ControlResult> => kernel.control({ kind: "prompt", input: text, ...inputOptions }, async () => {
      if (active()) { return { kind: "rejected", code: "busy", reason: "busy" }; }
      return withInputImages(capabilities, inputOptions?.images, async () => send("prompt", inputFields(text, inputOptions?.inputId)));
    })),
    // BYOK change: steer is required; a dsh without it refuses here, so the SDK's static capability holds. The bridge reports `no_active_turn`.
    steer: guard(async (text: string, inputOptions?: InputOptions): Promise<ControlResult> => kernel.control({ kind: "steer", input: text, ...inputOptions }, async () =>
      withInputImages(capabilities, inputOptions?.images, async () => send("steer", inputFields(text, inputOptions?.inputId))))),
    // A control the runtime cannot do is an absent member; `dsh/opened` keeps the inventory that says why.
    queue: guard(async (text: string, inputOptions?: InputOptions): Promise<ControlResult> => kernel.control({ kind: "queue", input: text, ...inputOptions }, async () =>
      withInputImages(capabilities, inputOptions?.images, async () => send("queue", inputFields(text, inputOptions?.inputId))))),
    ...(inboxMethods.remove === true ? {
      withdraw: guard(async (inputId: string): Promise<ControlResult> => kernel.control({ kind: "withdraw", inputId }, async () => {
        const answer = await send("withdraw", { messageId: inputId });
        return answer.kind === "accepted" && asRecord(answer.native)?.removed === false
          ? { kind: "rejected", code: "not_queued", reason: "no held input with this inputId is waiting" } : answer;
      })),
    } : {}),
    abort: guard(async (): Promise<ControlResult> => kernel.control({ kind: "abort" }, async () => {
      // BYOK change: a tool the cancel orphans stays known to the SDK process-tree authority. A failed read sends no cancel.
      try { child.observeDescendants(); }
      catch (error) { return { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) }; }
      const disarm = fallback.arm();
      const answer = await send("cancel", {});
      if (answer.kind !== "accepted") { disarm(); }
      return answer;
    })),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(), graph: () => kernel.graph(),
    dispose: guard(() => kernel.dispose(async () => {
      // Native disposal records its own turn end and flushes the log; the
      // process owner then bounds shutdown and removes anything left.
      try { await control.request("dispose", {}, DISPOSE_TIMEOUT_MS); }
      catch (error) {
        kernel.frame({ type: "dsh/dispose-failed", native: error instanceof DshCommandError ? error.native : { message: String(error) }, events: [] });
      }
      child.kill();
      await child.exited;
    })),
  };
  return session;
}

/** One owned DSH process per session, reached through a private bridge plugin. */
export async function dshSession(spawnLineProcess: SpawnDshLineProcess, installation: AvailableInstallation, options: DshSessionOptions, hooks: DshSessionHooks = {}): Promise<DshAdapterSession> {
  // BYOK change: Upstream withSessionCredentials without sealSession, over the caller's explicit environment.
  const credentials = sessionCredentialRedactor({ ...options, env: options.launch.env });
  for (const value of hooks.credentialsForRedaction ?? []) { credentials.addExplicit(value); }
  try {
    refuseSessionOptions(dshRefusedSessionOptions, options);
    checkSessionName(options);
    // Checked before spawning anything: both refusals name what they refuse.
    dshAgentOptions(options);
    const mcpRows = dshMcpRows(options.mcpServers, options.cwd);
    if (installation.via !== "executable") { throw new Error("DSH requires its executable installation"); }
    return await open(spawnLineProcess, installation.command, options, hooks, credentials, mcpRows);
  } catch (error) { throw credentials.redactValue(error); }
}
