import type { RuntimeFailureClass, TaskFailure } from '@byok-sdk/protocol';
import { RUNTIME_FAILURE_CLASSES } from '@byok-sdk/protocol/constants';

/** Closed lifecycle phases for failures after an offer has been admitted. */
export type RuntimeFailurePhase = 'start' | 'run';

/** Closed semantic axis. Retryability is explicit and is never inferred from this field. */
export type RuntimeFailureCategory = 'semantic' | 'infrastructure' | 'authority';

/** The adapter's explicit retry judgment consumed by TaskRunner. */
export type RuntimeRetryDisposition = 'retryable' | 'non-retryable';

/** Disposal is deliberately separate from start/run retryability authority. */
export type RuntimeDisposalStage = 'signal' | 'quiescence' | 'cleanup';

export interface RuntimeDisposalFailureInput {
  stage: RuntimeDisposalStage;
  /** Audit-safe operational reason. It must not contain task instructions or provider credentials. */
  reason: string;
}

export interface RuntimeExecutionFailureInput {
  phase: RuntimeFailurePhase;
  category: RuntimeFailureCategory;
  retry: RuntimeRetryDisposition;
  /** Stable operator-facing reason. Provider diagnostics may be included, but are never parsed by TaskRunner. */
  reason: string;
  /**
   * The runtime's failure class, from structured runtime evidence only (#869);
   * omitted means `unknown`. `resetsAt` exists only on `quota`, only when the
   * runtime reported it, written as `Date#toISOString` writes it.
   */
  failure?: TaskFailure;
}

// Both public package entries are emitted as independent ESM bundles. A
// global symbol keeps failures created through `@byok-sdk/client/adapters`
// recognizable by TaskRunner loaded through `@byok-sdk/client`; `instanceof`
// would split authority across the two constructor copies.
const RUNTIME_EXECUTION_FAILURE_BRAND = Symbol.for('@byok-sdk/client/RuntimeExecutionFailure/v1');
const RUNTIME_DISPOSAL_FAILURE_BRAND = Symbol.for('@byok-sdk/client/RuntimeDisposalFailure/v1');

/**
 * Expected failure of an owned runtime-resource disposal barrier. This never
 * carries task retryability: semantic terminal authority may already have
 * been published when disposal begins.
 */
export class RuntimeDisposalFailure extends Error {
  readonly stage: RuntimeDisposalStage;

  constructor(input: RuntimeDisposalFailureInput, options?: ErrorOptions) {
    if (!isRuntimeDisposalStage(input.stage) || typeof input.reason !== 'string' || input.reason.length === 0) {
      throw new TypeError('invalid RuntimeDisposalFailure input');
    }
    super(input.reason, options);
    this.name = 'RuntimeDisposalFailure';
    this.stage = input.stage;
    Object.defineProperty(this, RUNTIME_DISPOSAL_FAILURE_BRAND, { value: true });
    Object.freeze(this);
  }
}

function isRuntimeDisposalStage(value: unknown): value is RuntimeDisposalStage {
  return value === 'signal' || value === 'quiescence' || value === 'cleanup';
}

export function isRuntimeDisposalFailure(value: unknown): value is RuntimeDisposalFailure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    readonly [RUNTIME_DISPOSAL_FAILURE_BRAND]?: unknown;
    readonly stage?: unknown;
    readonly message?: unknown;
  };
  return candidate[RUNTIME_DISPOSAL_FAILURE_BRAND] === true
    && isRuntimeDisposalStage(candidate.stage)
    && typeof candidate.message === 'string'
    && candidate.message.length > 0;
}

/**
 * The only expected post-admission failure value accepted from a runtime
 * adapter. Diagnostic AgentEvents remain observability; this value alone is
 * terminal control authority.
 */
export class RuntimeExecutionFailure extends Error {
  readonly phase: RuntimeFailurePhase;
  readonly category: RuntimeFailureCategory;
  readonly retry: RuntimeRetryDisposition;
  readonly failure: TaskFailure;

  constructor(input: RuntimeExecutionFailureInput, options?: ErrorOptions) {
    const failure = input.failure ?? UNKNOWN_FAILURE;
    if (!isRuntimeFailurePhase(input.phase)
      || !isRuntimeFailureCategory(input.category)
      || !isRuntimeRetryDisposition(input.retry)
      || typeof input.reason !== 'string'
      || input.reason.length === 0
      || !isTaskFailure(failure)) {
      throw new TypeError('invalid RuntimeExecutionFailure input');
    }
    super(input.reason, options);
    this.name = 'RuntimeExecutionFailure';
    this.phase = input.phase;
    this.category = input.category;
    this.retry = input.retry;
    this.failure = Object.freeze({ ...failure });
    Object.defineProperty(this, RUNTIME_EXECUTION_FAILURE_BRAND, { value: true });
    Object.freeze(this);
  }
}

const UNKNOWN_FAILURE: TaskFailure = Object.freeze({ class: 'unknown' });

/** A class string a runtime reported, or `unknown` when it is none of the closed classes. */
export function runtimeFailureClassOf(value: unknown): RuntimeFailureClass {
  return (RUNTIME_FAILURE_CLASSES as readonly unknown[]).includes(value) ? value as RuntimeFailureClass : 'unknown';
}

const WIRE_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The wire's strict `TaskFailureSchema`, without zod: adapter bundles carry none. */
function isTaskFailure(value: unknown): value is TaskFailure {
  if (typeof value !== 'object' || value === null) return false;
  const { class: failureClass, resetsAt, ...rest } = value as Record<string, unknown>;
  return Object.keys(rest).length === 0
    && runtimeFailureClassOf(failureClass) === failureClass
    && (resetsAt === undefined || (failureClass === 'quota' && typeof resetsAt === 'string'
      && WIRE_DATETIME.test(resetsAt) && !Number.isNaN(Date.parse(resetsAt)) && new Date(resetsAt).toISOString() === resetsAt));
}

function isRuntimeFailurePhase(value: unknown): value is RuntimeFailurePhase {
  return value === 'start' || value === 'run';
}

function isRuntimeFailureCategory(value: unknown): value is RuntimeFailureCategory {
  return value === 'semantic' || value === 'infrastructure' || value === 'authority';
}

function isRuntimeRetryDisposition(value: unknown): value is RuntimeRetryDisposition {
  return value === 'retryable' || value === 'non-retryable';
}

export function isRuntimeExecutionFailure(value: unknown): value is RuntimeExecutionFailure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    readonly [RUNTIME_EXECUTION_FAILURE_BRAND]?: unknown;
    readonly phase?: unknown;
    readonly category?: unknown;
    readonly retry?: unknown;
    readonly failure?: unknown;
    readonly message?: unknown;
  };
  return candidate[RUNTIME_EXECUTION_FAILURE_BRAND] === true
    && isRuntimeFailurePhase(candidate.phase)
    && isRuntimeFailureCategory(candidate.category)
    && isRuntimeRetryDisposition(candidate.retry)
    && isTaskFailure(candidate.failure)
    && typeof candidate.message === 'string'
    && candidate.message.length > 0;
}

export interface RuntimeFailureProjection {
  reason: string;
  retryable: boolean;
  failure: TaskFailure;
}

function retryableFromDisposition(disposition: RuntimeRetryDisposition): boolean {
  switch (disposition) {
    case 'retryable':
      return true;
    case 'non-retryable':
      return false;
  }
}

/**
 * Exhaustive wire projection for a valid typed failure. A failure from the
 * wrong phase is an invalid adapter state and must be handled as an untyped
 * contract violation by the caller.
 */
export function projectRuntimeExecutionFailure(failure: RuntimeExecutionFailure): RuntimeFailureProjection {
  return {
    reason: failure.message,
    retryable: retryableFromDisposition(failure.retry),
    failure: failure.failure,
  };
}

const TOOL_EXECUTION_UNSUPPORTED_BRAND = Symbol.for('@byok-sdk/client/ToolExecutionUnsupportedError/v1');

/** Local opt-in rejected before execution; never a retryable runtime outage. */
export class ToolExecutionUnsupportedError extends Error {
  readonly runtimeId: string;
  readonly code = 'tool_execution_hook_unsupported';
  constructor(runtimeId: string, reason: string) {
    super(`tool_execution_hook_unsupported: ${runtimeId}: ${reason}`);
    this.runtimeId = runtimeId;
    this.name = 'ToolExecutionUnsupportedError';
    Object.defineProperty(this, TOOL_EXECUTION_UNSUPPORTED_BRAND, { value: true });
    Object.freeze(this);
  }
}

function isToolExecutionUnsupported(value: unknown): value is ToolExecutionUnsupportedError {
  return typeof value === 'object' && value !== null
    && (value as Record<symbol, unknown>)[TOOL_EXECUTION_UNSUPPORTED_BRAND] === true
    && typeof (value as ToolExecutionUnsupportedError).runtimeId === 'string'
    && typeof (value as ToolExecutionUnsupportedError).message === 'string';
}

export const RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON = Object.freeze({
  start: 'runtime adapter contract violation during start',
  run: 'runtime adapter contract violation during run',
} satisfies Record<RuntimeFailurePhase, string>);

/**
 * Validate an adapter boundary. Unknown values and typed failures reported
 * for the wrong phase fail closed; their source value is returned only as a
 * local diagnostic cause and never influences wire semantics.
 */
export function projectRuntimeBoundaryFailure(
  value: unknown,
  expectedPhase: RuntimeFailurePhase,
): RuntimeFailureProjection & { contractViolation: boolean } {
  if (expectedPhase === 'start' && isToolExecutionUnsupported(value)) {
    return { reason: value.message, retryable: false, failure: UNKNOWN_FAILURE, contractViolation: false };
  }
  if (isRuntimeExecutionFailure(value) && value.phase === expectedPhase) {
    return { ...projectRuntimeExecutionFailure(value), contractViolation: false };
  }
  return {
    reason: RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON[expectedPhase],
    retryable: false,
    failure: UNKNOWN_FAILURE,
    contractViolation: true,
  };
}

/** A failed startup whose process tree has not yielded a disposal receipt. */
export class RuntimeStartupDisposalFailure extends Error {
  readonly retryDisposal: () => Promise<void>;
  constructor(retryDisposal: () => Promise<void>, options?: ErrorOptions) {
    super('runtime startup failed and process ownership remains quarantined', options);
    this.name = 'RuntimeStartupDisposalFailure';
    this.retryDisposal = retryDisposal;
    Object.defineProperty(this, Symbol.for('@byok-sdk/client/RuntimeStartupDisposalFailure/v1'), { value: true });
    Object.freeze(this);
  }
}

export function isRuntimeStartupDisposalFailure(value: unknown): value is RuntimeStartupDisposalFailure {
  return typeof value === 'object' && value !== null
    && (value as Record<symbol, unknown>)[Symbol.for('@byok-sdk/client/RuntimeStartupDisposalFailure/v1')] === true
    && typeof (value as RuntimeStartupDisposalFailure).retryDisposal === 'function';
}
