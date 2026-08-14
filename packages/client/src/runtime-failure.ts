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

  constructor(input: RuntimeExecutionFailureInput, options?: ErrorOptions) {
    if (!isRuntimeFailurePhase(input.phase)
      || !isRuntimeFailureCategory(input.category)
      || !isRuntimeRetryDisposition(input.retry)
      || typeof input.reason !== 'string'
      || input.reason.length === 0) {
      throw new TypeError('invalid RuntimeExecutionFailure input');
    }
    super(input.reason, options);
    this.name = 'RuntimeExecutionFailure';
    this.phase = input.phase;
    this.category = input.category;
    this.retry = input.retry;
    Object.defineProperty(this, RUNTIME_EXECUTION_FAILURE_BRAND, { value: true });
    Object.freeze(this);
  }
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
    readonly message?: unknown;
  };
  return candidate[RUNTIME_EXECUTION_FAILURE_BRAND] === true
    && isRuntimeFailurePhase(candidate.phase)
    && isRuntimeFailureCategory(candidate.category)
    && isRuntimeRetryDisposition(candidate.retry)
    && typeof candidate.message === 'string'
    && candidate.message.length > 0;
}

export interface RuntimeFailureProjection {
  reason: string;
  retryable: boolean;
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
  };
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
  if (isRuntimeExecutionFailure(value) && value.phase === expectedPhase) {
    return { ...projectRuntimeExecutionFailure(value), contractViolation: false };
  }
  return {
    reason: RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON[expectedPhase],
    retryable: false,
    contractViolation: true,
  };
}
