// ==== @byok-sdk/cloud-do dist/agent-do.d.ts ====
import { DurableObject } from 'cloudflare:workers';
import { type PlatformProfileId } from './platform-credentials';
import { SessionRuntime, type CloudRenewRequest, type CloudRenewResult, type CloudRunSettlement } from './session-runtime';
import type { CloudToolDispatcher } from './tools';
import type { InvocationTerminalState, InvocationRow } from './invocation-ledger';
import { type AdmissionIdentity, type InboxRow, type TranscriptCursor, type TranscriptRun } from './cloud-state';
import { type CloudWakeAdmission } from './wake-runner';
export { CLOUD_HARNESS_SETTINGS } from './session-runtime';
/** One named DO owns one Harness; 4b adds platform-only text model submissions. */
export declare class AgentDO extends DurableObject<Record<string, unknown>> {
    #private;
    /** The consuming Worker supplies trusted code. No executable function is persisted. */
    protected createDispatcher(_id: string): CloudToolDispatcher | undefined;
    /** Post-commit notification. Consumer failures never change the invocation outcome. */
    protected onInvocationSettled(_id: string, _state: InvocationTerminalState): void | Promise<void>;
    protected projectInvocation(_row: InvocationRow): {
        key: string;
        dataJson: string;
    } | undefined;
    /** The consumer owns billing truth and fences every pending admission key on release. */
    protected admitWake(_items: readonly InboxRow[], _signal: AbortSignal, _key: string, _admission: AdmissionIdentity): CloudWakeAdmission | Promise<CloudWakeAdmission>;
    protected instructions(_profile: PlatformProfileId): string | undefined;
    protected renew(_request: CloudRenewRequest, _signal: AbortSignal): CloudRenewResult | Promise<CloudRenewResult>;
    protected settleRun(_run: CloudRunSettlement, _signal: AbortSignal): void | Promise<void>;
    protected sessionRuntime(): SessionRuntime;
    configureSession(input: unknown): Promise<Response>;
    readInvocation(id: string): Promise<InvocationRow | undefined>;
    enqueue(input: unknown): Promise<Response>;
    /** The platform supplies retryCount. This handler never replaces a live owner. */
    alarm(info?: AlarmInvocationInfo): Promise<void>;
    events(input?: {
        after?: number;
    }): Promise<Response>;
    readSnapshot(): Promise<{
        highWater: number;
        trimmedThrough: number;
        inbox: InboxRow[];
        runs: import("./cloud-state").RunRow[];
        invocations: Array<Pick<InvocationRow, 'seq' | 'invocationId' | 'toolName' | 'state' | 'errorCode'>>;
    }>;
    readRuns(input?: {
        after?: number;
        limit?: number;
    }): Promise<import("./cloud-state").RunRow[]>;
    readInbox(input?: {
        after?: number;
        limit?: number;
    }): Promise<InboxRow[]>;
    readInvocations(input?: {
        after?: number;
        limit?: number;
    }): Promise<Pick<InvocationRow, "errorCode" | "invocationId" | "seq" | "state" | "toolName">[]>;
    readTranscript(input?: {
        after?: TranscriptCursor;
        limit?: number;
    }): Promise<{
        runs: TranscriptRun[];
        items: import("./cloud-state").TranscriptItem[];
        next: TranscriptCursor;
    }>;
    readRunOutput(conversationId: number, input?: {
        entryId?: number;
        offset?: number;
    }): Promise<{
        entryId: import("@earendil-works/pi-durable").EntryId;
        offset: number;
        nextOffset: number;
        done: boolean;
        text: string;
    }>;
    cancelActiveRun(): Promise<Response>;
    cancelInboxItem(seq: number): Promise<Response>;
    open(): Promise<{
        scheduling: "closing" | "paused" | "running";
    }>;
    /** D1: every call allocates a new ownerless conversation, including after a restart. */
    openExecution(): Promise<{
        conversationId: number;
    }>;
    /** Passive native pi entries prove storage without starting a model or tool task. */
    appendExecution(conversationId: number, text: string): Promise<void>;
    readExecution(conversationId: number): Promise<string[]>;
    /** Binding/RPC-only. The consumer authorizes identity before obtaining this stub.
     * Errors are structured Responses so the same code/status survive DO RPC. */
    submit(input: unknown): Promise<Response>;
}
// ==== @byok-sdk/cloud-do dist/cloud-state.d.ts ====
import { type CloudDoErrorCode } from './errors';
import { type CloudInboxAdmission, type InboxSource } from './inbox-admission';
import type { CloudOperationGuard } from './input-guard';
import type { ExecutionRow, InvocationRow } from './invocation-ledger';
import type { PlatformProfileId } from './platform-credentials';
export type InboxState = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled' | 'expired';
export interface InboxRow {
    seq: number;
    dedupKey: string;
    payloadDigest: string;
    source: InboxSource;
    profile: PlatformProfileId;
    payloadJson: string | null;
    availableAt: number;
    expiresAt: number;
    state: InboxState;
    runId: number | null;
    attempts: number;
    errorCode: CloudDoErrorCode | null;
    createdAt: number;
    settledAt: number | null;
    inputDurable: number;
    revision: number | null;
}
export interface RunRow extends ExecutionRow {
    trigger: 'submit' | 'wake';
    requestId: string | null;
    submissionId: number | null;
    state: 'starting' | 'running' | 'completed' | 'failed' | 'interrupted';
    errorCode: CloudDoErrorCode | null;
    startedAt: number | null;
    settledAt: number | null;
    reservation: 'none' | 'pending' | 'held' | 'released';
    eligibilityJson: string | null;
    admissionDigest: string | null;
    admittedSeqs: string | null;
    settlementAck: number | null;
    revision: number | null;
    membershipPending: number | null;
}
export interface TranscriptCursor {
    horizon: number;
    run: number | null;
    item: number | null;
}
export interface TranscriptTurn {
    seq: number;
    runId: number | null;
    state: InboxState | null;
    errorCode: CloudDoErrorCode | null;
    revision: number | null;
    text: string | null;
}
export interface TranscriptItem {
    seq: number;
    dedupKey: string;
    state: InboxState;
    errorCode: CloudDoErrorCode | null;
    runId: number | null;
    attempts: number;
    revision: number | null;
    text: string | null;
}
export interface TranscriptInvocation {
    invocationId: string;
    toolName: string;
    state: InvocationRow['state'];
    errorCode: CloudDoErrorCode | null;
    revision: number | null;
}
export interface TranscriptRun {
    nativeRunId: number;
    revision: number | null;
    state: RunRow['state'];
    errorCode: CloudDoErrorCode | null;
    trigger: RunRow['trigger'];
    settlementAck: boolean;
    claimedSeqs: number[];
    turns: TranscriptTurn[];
    text?: string;
    truncated?: boolean;
    invocations: TranscriptInvocation[];
}
export interface TranscriptPlan {
    runs: Array<{
        run: RunRow;
        turns: TranscriptTurn[];
        invocations: TranscriptInvocation[];
    }>;
    items: TranscriptItem[];
    next: TranscriptCursor;
}
export interface AdmissionIdentity {
    digest: string;
    seqs: number[];
}
export interface CloudEventRow {
    seq: number;
    eventKey: string;
    type: string;
    conversationId: number | null;
    ref: string | null;
    dataJson: string;
    createdAt: number;
}
export interface CloudEventInput {
    eventKey: string;
    type: string;
    conversationId?: number;
    ref?: string;
    data: Record<string, unknown>;
    createdAt?: number;
}
export interface CloudEventMeta {
    trimmedThrough: number;
    highWater: number;
}
export interface SchedulingState {
    busy?: boolean;
    repairRetrying?: boolean;
}
export interface RunSettlement {
    state: 'completed' | 'failed' | 'interrupted';
    errorCode?: CloudDoErrorCode;
    text?: string;
    entryId?: number;
    /** The caller derives this only from the durable pre-recovery eligibility snapshot. */
    requeue?: boolean;
}
export interface RunHistory {
    input: unknown;
    reply: string;
}
export interface InboxInput {
    seq: number;
    source: InboxSource;
    text: string;
}
export type InvocationProjection = (row: InvocationRow) => {
    key: string;
    dataJson: string;
} | undefined;
export declare const CLOUD_CONTEXT_BYTES = 48000;
export declare function inboxInput(rows: readonly InboxRow[]): InboxInput[];
export declare function admissionIdentity(rows: readonly InboxRow[]): AdmissionIdentity;
/** Accept only the committed native wake input shape. */
export declare function runInputSeqs(entries: readonly unknown[]): number[];
/** Fit inbox first. Add the newest history prefix, then emit it in chronological order. */
export declare function composeCloudInput(rows: readonly InboxRow[], historyNewestFirst?: readonly RunHistory[]): string;
export declare function utf8Prefix(text: string, maxBytes: number): string;
/** Visible SQL state. Sync helpers can participate in the caller's transaction. */
export declare class CloudState {
    private readonly storage;
    private scheduling;
    constructor(storage: DurableObjectStorage);
    private rows;
    ensureSchema(): void;
    private migrate;
    readInboxItem(seq: number): InboxRow | undefined;
    run(conversationId: number): RunRow | undefined;
    unsettledRuns(): RunRow[];
    completedRuns(): RunRow[];
    invocationRowsForRun(id: number): InvocationRow[];
    private stamp;
    claimedSeqs(id: number): number[];
    markInputDurable(id: number, seqs: readonly number[]): void;
    pendingBackfills(before?: number): RunRow[];
    applyBackfill(id: number, seqs: readonly number[]): void;
    unackedRuns(): RunRow[];
    ackSettlement(id: number, guard: CloudOperationGuard, now?: number): boolean;
    /** Read-only preflight also works before this DO has initialized its schema. */
    validateEnqueue(input: CloudInboxAdmission, guard: CloudOperationGuard, now?: number): void;
    private enqueueIdentity;
    enqueue(input: CloudInboxAdmission, guard: CloudOperationGuard, now?: number, options?: SchedulingState): Promise<{
        accepted: boolean;
        row: InboxRow;
    }>;
    /** Selection never skips another profile or a prefix item that exceeds the budget. */
    selectBatch(now?: number, guard?: CloudOperationGuard): InboxRow[];
    startRun(id: number, trigger: 'submit' | 'wake', deadlineAt: number, guard: CloudOperationGuard, now?: number): RunRow;
    markRunning(id: number, guard: CloudOperationGuard, now?: number): void;
    recordSubmission(id: number, submissionId: number): void;
    markReservation(id: number, reservation: RunRow['reservation'], guard: CloudOperationGuard, now?: number, admission?: AdmissionIdentity): void;
    captureEligibility(originalStale?: ReadonlySet<number>): RunRow[];
    claim(id: number, seqs: readonly number[], profile: PlatformProfileId, guard: CloudOperationGuard, now?: number): InboxRow[];
    private settleItem;
    failQueued(seqs: readonly number[], code: CloudDoErrorCode, guard: CloudOperationGuard, now?: number): void;
    cancelQueued(seq: number, guard: CloudOperationGuard, now?: number): InboxRow | undefined;
    expireQueued(guard: CloudOperationGuard, now?: number): number;
    settleRun(id: number, outcome: RunSettlement, guard: CloudOperationGuard, now?: number): RunRow | undefined;
    /** The caller must wrap this and its state write in one transaction. */
    appendEvent(event: CloudEventInput, guard: CloudOperationGuard): CloudEventRow;
    eventMeta(): CloudEventMeta;
    eventPage(after: number, limit?: number): CloudEventRow[];
    private pageLimit;
    /** Capture ownership and payloads before any asynchronous pi context read. */
    planTranscript(after: TranscriptCursor | undefined, limit: number): TranscriptPlan;
    readRun(id: number): RunRow | undefined;
    readRuns(options?: {
        after?: number;
        limit?: number;
    }): RunRow[];
    readInbox(options?: {
        after?: number;
        limit?: number;
    }): InboxRow[];
    readInvocations(options?: {
        after?: number;
        limit?: number;
    }): Array<Pick<InvocationRow, 'seq' | 'invocationId' | 'toolName' | 'state' | 'errorCode'>>;
    private pageAfter;
    snapshot(): {
        highWater: number;
        trimmedThrough: number;
        inbox: InboxRow[];
        runs: RunRow[];
        invocations: Array<Pick<InvocationRow, 'seq' | 'invocationId' | 'toolName' | 'state' | 'errorCode'>>;
    };
    setDelivery(id: string, state: 'delivered' | 'undelivered', taskId: number | null, entryId: number | null, guard: CloudOperationGuard, now?: number): void;
    projectInvocation(row: InvocationRow, project: InvocationProjection | undefined, guard: CloudOperationGuard, now?: number): void;
    private projectionFailed;
    private trimPrefix;
    retention(now?: number): {
        events: number;
        inbox: number;
    };
    setSchedulingState(options: SchedulingState): void;
    nextAlarm(now?: number, busy?: boolean): number | null;
    /** This is the only alarm mutation path. Async enqueue calls it inside its storage transaction. */
    rearmAlarm(options?: SchedulingState, now?: number): Promise<void>;
}
// ==== @byok-sdk/cloud-do dist/errors.d.ts ====
declare const status: {
    readonly CLOUD_REQUEST_INVALID: 400;
    readonly CLOUD_INBOX_FULL: 429;
    readonly CLOUD_INBOX_CONFLICT: 409;
    readonly CLOUD_INBOX_EXPIRED: 409;
    readonly CLOUD_INBOX_TOO_LARGE: 400;
    readonly CLOUD_WAKE_EXHAUSTED: 409;
    readonly CLOUD_WAKE_EMPTY: 409;
    readonly CLOUD_EVENT_CURSOR_EXPIRED: 410;
    readonly CLOUD_EVENTS_BUSY: 429;
    readonly CLOUD_USER_CREDENTIAL_REJECTED: 400;
    readonly CLOUD_MODEL_CREDENTIAL_UNAVAILABLE: 503;
    readonly CLOUD_MODEL_RESPONSE_REJECTED: 502;
    readonly CLOUD_MODEL_REQUEST_FAILED: 502;
    readonly CLOUD_SESSION_CONFLICT: 409;
    readonly CLOUD_TOOL_NOT_AVAILABLE: 400;
    readonly CLOUD_TOOL_INVOCATION_CONFLICT: 409;
    readonly CLOUD_TOOL_ARGUMENT_INVALID: 400;
    readonly CLOUD_TOOL_LIMIT: 400;
    readonly CLOUD_STEP_LIMIT: 400;
    readonly CLOUD_BUDGET_EXCEEDED: 400;
    readonly CLOUD_TOOL_RESULT_LIMIT: 502;
    readonly CLOUD_TOOL_USAGE_INVALID: 502;
    readonly CLOUD_TOOL_BUSY: 409;
    readonly CLOUD_TOOL_TIMEOUT: 504;
    readonly CLOUD_EXECUTION_TIMEOUT: 504;
    readonly CLOUD_EXECUTION_INTERRUPTED: 409;
    readonly CLOUD_EXECUTION_ABORTED: 409;
    readonly CLOUD_TOOL_FAILED: 502;
};
export type CloudDoErrorCode = keyof typeof status;
/** Never attach an upstream exception, request, response, env, or credential. */
export declare class CloudDoError extends Error {
    readonly code: CloudDoErrorCode;
    readonly status: number;
    readonly retryable = false;
    constructor(code: CloudDoErrorCode);
}
export declare function safeCloudError(error: unknown): CloudDoError;
export declare function cloudErrorResponse(error: unknown): Response;
export {};
// ==== @byok-sdk/cloud-do dist/identity.d.ts ====
import type { AgentDO } from './agent-do';
export interface AgentIdentity {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly agentId: string;
}
export interface SessionIdentity extends AgentIdentity {
    readonly sessionId: string;
}
export declare function agentObjectName(identity: AgentIdentity): Promise<string>;
/** Call only after the platform has authorized the tenant/workspace/agent identity. */
export declare function getAgentObject(namespace: DurableObjectNamespace<AgentDO>, identity: AgentIdentity): Promise<DurableObjectStub<AgentDO>>;
export declare function sessionObjectName(identity: SessionIdentity): Promise<string>;
/** The consuming platform authorizes all four identity fields before this lookup. */
export declare function getSessionObject(namespace: DurableObjectNamespace<AgentDO>, identity: SessionIdentity): Promise<DurableObjectStub<AgentDO>>;
// ==== @byok-sdk/cloud-do dist/inbox-admission.d.ts ====
import { type PlatformProfileId } from './platform-credentials';
export type InboxSource = 'message' | 'schedule' | 'invocation';
export interface CloudInboxAdmission {
    readonly dedupKey: string;
    readonly source: InboxSource;
    readonly text: string;
    readonly profile: PlatformProfileId;
    readonly availableAt?: number;
    readonly expiresAt?: number;
}
export declare const INBOX_DAY = 86400000;
/** Freeze the wire schema before credential reads or storage writes. */
export declare function admitCloudInbox(input: unknown, now?: number): CloudInboxAdmission;
// ==== @byok-sdk/cloud-do dist/index.d.ts ====
export { AgentDO } from './agent-do';
export type { CloudWakeAdmission } from './wake-runner';
export type { InboxRow, RunRow, CloudEventRow, CloudEventMeta } from './cloud-state';
export type { TranscriptCursor, TranscriptRun, TranscriptTurn, TranscriptItem } from './cloud-state';
export type { CloudRenewRequest, CloudRenewResult, CloudRunSettlement } from './session-runtime';
export { agentObjectName, getAgentObject, type AgentIdentity } from './identity';
export { sessionObjectName, getSessionObject, type SessionIdentity } from './identity';
export { CLOUD_SAFE_REPLAY_TOOLS, CLOUD_LIVE_IPO_TOOLS, type CloudToolResult, type CloudToolDefinition, type CloudToolDispatcher, type CloudDispatchContext, type CloudToolCallContext } from './tools';
export { DurableObjectSqliteDatabase, openDurableObjectStorage } from './storage';
declare const _default: {
    fetch: () => Response;
};
export default _default;
// ==== @byok-sdk/cloud-do dist/input-guard.d.ts ====
import { type PlatformProfileId } from './platform-credentials';
/** Keep the existing pre-storage text guard shared by submission and tool data. */
export declare function admitCloudText(env: Readonly<Record<string, unknown>>, text: string, selected?: PlatformProfileId): Promise<void>;
/** Check decoded JSON values before any part enters pi or the invocation ledger. */
export declare function admitCloudPayload(env: Readonly<Record<string, unknown>>, value: unknown, selected?: PlatformProfileId): Promise<void>;
/** Keys belong to one operation. Dispose the guard when that operation ends. */
export interface CloudOperationGuard {
    guardText(text: string): void;
    /** Decode first. Check every key and value before admitted re-serialization. */
    guardPayload(dataJson: string): string;
    dispose(): void;
}
export declare function prepareCloudGuard(env: Readonly<Record<string, unknown>>, selected?: PlatformProfileId): Promise<CloudOperationGuard>;
// ==== @byok-sdk/cloud-do dist/invocation-ledger.d.ts ====
import { type CloudDoErrorCode } from './errors';
import type { CloudOperationGuard } from './input-guard';
export type InvocationState = 'accepted' | 'running' | 'succeeded' | 'failed' | 'aborted' | 'interrupted' | 'timed_out';
export type InvocationTerminalState = Exclude<InvocationState, 'accepted' | 'running'>;
export interface InvocationInput {
    invocationId: string;
    sessionId: string;
    conversationId: number;
    assistantEntryId: number;
    toolCallId: string;
    toolName: string;
    argsDigest: string;
    argsJson: string;
    replay: 'safe' | 'unsafe';
    deadlineAt: number;
}
export interface InvocationRow extends InvocationInput {
    seq: number;
    state: InvocationState;
    attempt: number;
    replayCount: number;
    abortRequested: number;
    resultJson: string | null;
    settledAt: number | null;
    settledEventSeq: number | null;
    errorCode: CloudDoErrorCode | null;
    mode: 'inline' | 'job';
    segmentStartedAt: number | null;
    nextSegmentAt: number | null;
    jobStateJson: string | null;
    progressJson: string | null;
    deliveredState?: 'delivered' | 'undelivered';
    taskId?: number | null;
    resultEntryId?: number | null;
}
export interface ExecutionRow {
    conversationId: number;
    deadlineAt: number;
    steps: number;
    tools: number;
    inputTokens: number;
    outputTokens: number;
    credits: number;
    sentRequests: number;
    fatalCode: CloudDoErrorCode | null;
    aborted: number;
}
export interface InvocationFinishOptions {
    /** An old attempt cannot settle an invocation claimed by recovery. */
    attempt?: number;
    clientConnected?: boolean;
    /** Ledger recovery may settle after the old native conversation was aborted. */
    recovery?: boolean;
    creditCap?: number;
}
export interface InvocationLedgerOptions {
    started?(row: InvocationRow, guard?: CloudOperationGuard): void;
    startedCommitted?(row: InvocationRow): void;
    /** Runs inside the state transaction. Errors roll back state and events together. */
    terminal?(row: InvocationRow, recovery: boolean): {
        seq: number;
        createdAt: number;
    } | void;
    /** Post-commit notification cannot affect the invocation outcome. */
    committed?(row: InvocationRow): void;
}
/** Host tables share the DO database with the pi_ tables. No function enters storage. */
export declare class InvocationLedger {
    #private;
    private readonly storage;
    private readonly options;
    constructor(storage: DurableObjectStorage, options?: InvocationLedgerOptions);
    /** The host calls this only after credential and identity preflight. */
    ensureSchema(): void;
    read(id: string): InvocationRow | undefined;
    pending(): InvocationRow[];
    begin(input: InvocationInput, guard?: CloudOperationGuard): {
        kind: 'started' | 'pending' | 'settled';
        row: InvocationRow;
    };
    finish(id: string, state: InvocationTerminalState, result?: Record<string, unknown>, errorCode?: CloudDoErrorCode, now?: number, options?: InvocationFinishOptions): InvocationRow | undefined;
    /** Claim before network replay. A second restart never dispatches a claimed row again. */
    claimRecovery(now?: number): InvocationRow[];
    forConversation(conversationId: number): InvocationRow[];
    startExecution(conversationId: number, deadlineAt: number): ExecutionRow;
    execution(conversationId: number): ExecutionRow | undefined;
    failExecution(conversationId: number, code: CloudDoErrorCode): ExecutionRow | undefined;
    abortExecution(conversationId: number, code: CloudDoErrorCode): ExecutionRow | undefined;
    private executionRejection;
    countModel(conversationId: number, maxSteps?: number, now?: number, budget?: {
        inputBytes: number;
        inputTokens: number;
        outputTokens: number;
    }): ExecutionRow;
    addModelUsage(conversationId: number, input: number, output: number): void;
    /** This mark records durable dispatch intent. It does not prove network receipt. */
    markModelSent(conversationId: number): void;
    countTool(conversationId: number, taskId: string, maxTools?: number, now?: number): ExecutionRow;
}
// ==== @byok-sdk/cloud-do dist/platform-credentials.d.ts ====
/** The platform reads one key. It does not own a local credential store. */
export type ModelProviderSecretName = `model-${string}-api-key`;
export interface PlatformCredentialReader {
    get(name: ModelProviderSecretName): Promise<string | undefined>;
}
export declare const PLATFORM_PROFILES: Readonly<{
    zai_openai: Readonly<{
        vendor: "zai";
        baseUrl: "https://api.z.ai/api/coding/paas/v4";
        model: "glm-5.3-flash";
        binding: "AIPHABEE_ZAI_API_KEY";
        secretName: "model-zai_openai-api-key";
    }>;
    deepseek_direct: Readonly<{
        vendor: "deepseek";
        baseUrl: "https://api.deepseek.com";
        model: "deepseek-v4-flash";
        binding: "AIPHABEE_DEEPSEEK_API_KEY";
        secretName: "model-deepseek_direct-api-key";
    }>;
}>;
export type PlatformProfileId = keyof typeof PLATFORM_PROFILES;
export type PlatformProfile = (typeof PLATFORM_PROFILES)[PlatformProfileId];
export declare function platformProfile(id: unknown): PlatformProfileId;
/** A small bounded ASCII token, never whitespace/control characters or a header fragment. */
export declare function requirePlatformKey(value: unknown): string;
/** The concrete reader returns a valid key or rejects with a fixed error. */
export declare function platformCredentialReader(env: Readonly<Record<string, unknown>>): {
    get(name: ModelProviderSecretName): Promise<string>;
};
// ==== @byok-sdk/cloud-do dist/session-runtime.d.ts ====
import { Harness, type AgentChange } from '@earendil-works/pi-durable';
import { type CloudDoErrorCode } from './errors';
import { type CloudOperationGuard } from './input-guard';
import { CloudState, type RunRow } from './cloud-state';
import { InvocationLedger, type InvocationRow, type InvocationTerminalState } from './invocation-ledger';
import { type PlatformProfileId } from './platform-credentials';
import { type CloudToolDispatcher } from './tools';
export declare const CLOUD_HARNESS_SETTINGS: {
    readonly compaction: {
        readonly enabled: false;
    };
    readonly retry: {
        readonly enabled: false;
        readonly maxRetries: 0;
    };
    readonly stream: {
        readonly maxRetries: 0;
    };
};
export interface ExecutionLease {
    conversationId?: number;
    trigger?: 'submit' | 'wake';
    readonly profile: PlatformProfileId;
    readonly deadlineAt: number;
    readonly controller: AbortController;
    connected: boolean;
    timer?: ReturnType<typeof setTimeout>;
    guard?: CloudOperationGuard;
    liveOwner: boolean;
    settled: boolean;
}
export interface CloudRenewRequest {
    nativeRunId: number;
    requestId: string | null;
    kind: 'model' | 'tool';
    toolName?: string;
    recovery: boolean;
}
export type CloudRenewResult = {
    ok: true;
} | {
    ok: false;
    code: CloudDoErrorCode;
};
export interface CloudRunSettlement {
    nativeRunId: number;
    requestId: string | null;
    trigger: RunRow['trigger'];
    state: 'completed' | 'failed' | 'interrupted';
    errorCode: CloudDoErrorCode | null;
    reservation: RunRow['reservation'];
    admissionDigest: string | null;
    admittedSeqs: readonly number[];
    claimedSeqs: readonly number[];
    usage: Readonly<{
        steps: number;
        sentRequests: number;
        inputTokens: number;
        outputTokens: number;
        credits: number;
    }>;
}
/** Bound consumer work even when it ignores the supplied signal. */
export declare function raceLease<T>(work: Promise<T>, lease: ExecutionLease): Promise<T>;
export interface RuntimeOptions {
    createDispatcher(id: string): CloudToolDispatcher | undefined;
    projectInvocation?(row: InvocationRow): {
        key: string;
        dataJson: string;
    } | undefined;
    onCommit?(): void;
    onInvocationSettled?(id: string, state: InvocationTerminalState): void | Promise<void>;
    instructions?(profile: PlatformProfileId): string | undefined;
    renew?(request: CloudRenewRequest, signal: AbortSignal): CloudRenewResult | Promise<CloudRenewResult>;
    settleRun?(run: CloudRunSettlement, signal: AbortSignal): void | Promise<void>;
}
export interface RunOutcome {
    state: 'completed' | 'failed' | 'interrupted';
    errorCode?: CloudDoErrorCode;
    text?: string;
    entryId?: number;
    requeue?: boolean;
}
/** One physical DO owns this runtime. Native pi owns all model and task scheduling. */
export declare class SessionRuntime {
    #private;
    private readonly state;
    private readonly env;
    private readonly options;
    readonly ledger: InvocationLedger;
    readonly cloud: CloudState;
    constructor(state: DurableObjectState, env: Readonly<Record<string, unknown>>, options: RuntimeOptions);
    get recovering(): boolean;
    get activeLease(): ExecutionLease | undefined;
    get hasLiveOwner(): boolean;
    get busy(): boolean;
    get repairRetrying(): boolean;
    prepareGuard(profile?: PlatformProfileId): Promise<CloudOperationGuard>;
    /** Binding/RPC callers authorize the session before calling this immutable configuration operation. */
    configure(input: unknown): Promise<void>;
    open(selected?: PlatformProfileId): Promise<Harness>;
    ready(selected?: PlatformProfileId): Promise<Harness>;
    agentChange(profile: PlatformProfileId, guard: CloudOperationGuard): AgentChange;
    reserve(profile: PlatformProfileId, guard?: CloudOperationGuard): ExecutionLease;
    attach(lease: ExecutionLease, conversationId: number, trigger?: 'submit' | 'wake', guard?: CloudOperationGuard | undefined): void;
    cancel(lease: ExecutionLease, code?: CloudDoErrorCode): void;
    release(lease: ExecutionLease, retryCount?: number): Promise<void>;
    recordSubmission(conversationId: number, submissionId: number): void;
    markReservation(conversationId: number, reservation: 'pending' | 'held' | 'none', admission?: {
        digest: string;
        seqs: number[];
    }): void;
    claimWake(lease: ExecutionLease, seqs: readonly number[], profile?: "deepseek_direct" | "zai_openai"): import("./cloud-state").InboxRow[];
    settle(lease: ExecutionLease, outcome: RunOutcome): Promise<void>;
    cancelActive(code?: CloudDoErrorCode): boolean;
    /** Only an owner that exited may be repaired. A live provider run is never adjudicated here. */
    repairPendingRuns(retryCount?: number): Promise<boolean>;
    deliverSettlementsForAlarm(retryCount?: number, providedGuard?: CloudOperationGuard): Promise<void>;
    fatal(conversationId: number): CloudDoErrorCode | undefined;
    readInvocation(id: string): InvocationRow | undefined;
}
// ==== @byok-sdk/cloud-do dist/storage.d.ts ====
import { type SqliteDatabase, type SqliteExecutor, type SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';
import type { Storage } from '@earendil-works/pi-durable';
/** Construction returns pi's native Storage interface. */
type DurableStorageFactory<Location> = (location: Location) => Promise<Storage>;
/** One adapter per DO database: unrelated reads, writes, transactions and close share this queue. */
export declare class DurableObjectSqliteDatabase implements SqliteDatabase {
    private readonly storage;
    private tail;
    private closed;
    constructor(storage: DurableObjectStorage);
    private queued;
    private executor;
    exec(sql: string): Promise<void>;
    run(sql: string, ...params: SqliteValue[]): Promise<void>;
    get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined>;
    all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]>;
    transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}
export declare const openDurableObjectStorage: DurableStorageFactory<DurableObjectStorage>;
export {};
// ==== @byok-sdk/cloud-do dist/tools.d.ts ====
import type { JsonValue } from '@earendil-works/pi-ai';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import { type CloudDoErrorCode } from './errors';
import type { SessionIdentity } from './identity';
export declare const CLOUD_SAFE_REPLAY_TOOLS: readonly ["load_financial_analysis_skill", "resolve_security", "guarded_screen", "search_f10_datasets", "query_f10_dataset", "get_security_profile", "get_quote_snapshot", "get_corporate_actions", "get_financial_statements", "get_financial_facts", "get_financial_ratios", "get_sdi_disclosures", "get_directorate", "get_ownership", "get_related_warrants"];
export declare const CLOUD_LIVE_IPO_TOOLS: readonly ["get_ipo_profile", "search_ipo_calendar", "get_ipo_timetable", "get_ipo_offering", "get_ipo_allotment", "screen_ipos", "compare_ipos"];
export interface CloudToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly parameters: ToolRegistration['parameters'];
    readonly execution: 'read_only_live' | 'skill' | 'scaffold' | 'pure';
    readonly resolverRpc?: string;
    readonly mode?: 'inline' | 'job';
    readonly requiredCapabilities?: readonly string[];
}
export interface CloudDispatchContext {
    readonly identity: SessionIdentity;
    readonly principal: {
        readonly accountId: string;
        readonly workspaceId: string;
        readonly channel: string;
    };
    readonly scopes: readonly string[];
    readonly dispatcherId: string;
    readonly call?: {
        readonly invocationId: string;
        readonly conversationId: number;
        readonly toolCallId: string;
        readonly attempt: number;
    };
    /** Session-local lookup can return a non-terminal invocation. */
    readonly lookup?: (invocationId: string) => {
        toolName: string;
        state: string;
        errorCode: string | null;
        resultJson: string | null;
        conversationId: number;
        toolCallId: string;
        settledAt: number | null;
        settledEventSeq: number | null;
    } | undefined;
}
/** Runtime calls supply these fields. Configuration remains source compatible. */
export interface CloudToolCallContext extends CloudDispatchContext {
    readonly call: NonNullable<CloudDispatchContext['call']>;
    readonly lookup: NonNullable<CloudDispatchContext['lookup']>;
}
export type CloudToolResult = Record<string, unknown> & {
    modelView?: JsonValue;
};
export interface CloudToolDispatcher {
    readonly pureTools?: readonly string[];
    readonly domainErrors?: readonly string[];
    readonly modelViews?: boolean;
    readonly tools: readonly CloudToolDefinition[];
    execute(context: CloudDispatchContext, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CloudToolResult>;
}
export declare const CLOUD_DOMAIN_ERROR_CODES: Readonly<Record<string, CloudDoErrorCode>>;
/** Admission does not grant resolver access. The trusted dispatcher checks access at execution. */
export declare function admitCloudTools(tools: readonly CloudToolDefinition[], pureTools?: readonly string[]): readonly CloudToolDefinition[];
/** Copy policy values so consumer mutation cannot change an installed policy. */
export declare function admitCloudDispatcher(dispatcher: CloudToolDispatcher): CloudToolDispatcher;
export declare function dispatcherDigest(dispatcher: CloudToolDispatcher): Promise<string>;
/** This policy is stored in the ledger only. Native pi registrations always use unsafe. */
export declare function replayForTool(name: string): 'safe' | 'unsafe';
export declare function canonicalArgs(args: Record<string, unknown>): string;
export declare function invocationId(conversationId: number, assistantEntryId: number, toolCallId: string): Promise<string>;
export declare function argsDigest(toolName: string, args: Record<string, unknown>): Promise<string>;
// ==== @byok-sdk/cloud-do dist/wake-runner.d.ts ====
import type { Conversation, Harness } from '@earendil-works/pi-durable';
import { type AdmissionIdentity, type InboxRow, type RunHistory } from './cloud-state';
import { type CloudDoErrorCode } from './errors';
import { type RunOutcome, type SessionRuntime } from './session-runtime';
export type CloudWakeAdmission = {
    accepted: true;
    reservation: 'held' | 'none';
} | {
    accepted: false;
    code: CloudDoErrorCode;
};
export type WakeAdmission = (items: readonly InboxRow[], signal: AbortSignal, key: string, admission: AdmissionIdentity) => CloudWakeAdmission | Promise<CloudWakeAdmission>;
export declare function cloudRunHistory(runtime: SessionRuntime, harness: Harness): Promise<RunHistory[]>;
export declare function committedRunOutcome(conversation: Conversation, runtime: SessionRuntime, status: string, detail?: unknown): Promise<RunOutcome>;
/** Each invocation of this function owns a fresh conversation and one shared runtime lease. */
export declare function runCloudWake(runtime: SessionRuntime, harness: Harness, env: Readonly<Record<string, unknown>>, admit: WakeAdmission, notify: () => void, retryCount?: number): Promise<boolean>;
