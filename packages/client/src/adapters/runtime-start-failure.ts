import type * as OarErrors from '../runtime/acp-session-runtime';
import { RuntimeExecutionFailure, isRuntimeExecutionFailure, runtimeFailureClassOf, type RuntimeExecutionFailureInput } from '../runtime-failure';

/** A runtime's own error types, mapped before the untyped fallback; `undefined` leaves the error untyped. */
export type RuntimeStartClassifier = (error: unknown) => Omit<RuntimeExecutionFailureInput, 'phase' | 'reason'> | undefined;

/** The one start-failure table: typed failures keep their axes, then the runtime classifier, then the owned-process exit decides. */
export function runtimeStartFailure(error: unknown, context: { readonly classify?: RuntimeStartClassifier; readonly exitedOnItsOwn: boolean; readonly runtime: string }): RuntimeExecutionFailure {
  const { classify, exitedOnItsOwn, runtime } = context;
  if (isRuntimeExecutionFailure(error)) {
    return new RuntimeExecutionFailure({ phase: 'start', category: error.category, retry: error.retry, failure: error.failure, reason: error.message }, { cause: error });
  }
  const reason = error instanceof Error ? error.message : `${runtime} open failed`;
  const classified = classify?.(error);
  if (classified) return new RuntimeExecutionFailure({ phase: 'start', reason, ...classified }, { cause: error });
  return new RuntimeExecutionFailure({ phase: 'start', category: 'infrastructure', retry: 'retryable', reason, failure: { class: exitedOnItsOwn ? 'runtime_exited' : 'unknown' } }, { cause: error });
}

export interface OarStartErrorClasses {
  readonly SessionNotFoundError: abstract new (...args: never[]) => OarErrors.SessionNotFoundError;
  readonly SessionUnavailableError: abstract new (...args: never[]) => OarErrors.SessionUnavailableError;
  readonly UnsupportedOptionError: abstract new (...args: never[]) => OarErrors.UnsupportedOptionError;
  readonly RuntimeFailureError: abstract new (...args: never[]) => OarErrors.RuntimeFailureError;
}

export function oarStartClassifier(classes: OarStartErrorClasses): RuntimeStartClassifier {
  return (error) => {
    if (error instanceof classes.SessionNotFoundError || error instanceof classes.UnsupportedOptionError || error instanceof classes.SessionUnavailableError) {
      const retryable = error instanceof classes.SessionUnavailableError && error.reason === 'in_use';
      return { category: retryable ? 'infrastructure' : 'authority', retry: retryable ? 'retryable' : 'non-retryable' };
    }
    if (error instanceof classes.RuntimeFailureError) return { category: 'authority', retry: 'non-retryable', failure: { class: runtimeFailureClassOf(error.failure) } };
    return undefined;
  };
}
