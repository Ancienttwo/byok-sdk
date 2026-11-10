import type * as OarErrors from '../runtime/acp-session-runtime';
import { RuntimeExecutionFailure, isRuntimeExecutionFailure, runtimeFailureClassOf } from '../runtime-failure';

export interface OarStartErrorClasses {
  readonly SessionNotFoundError: abstract new (...args: never[]) => OarErrors.SessionNotFoundError;
  readonly SessionUnavailableError: abstract new (...args: never[]) => OarErrors.SessionUnavailableError;
  readonly UnsupportedOptionError: abstract new (...args: never[]) => OarErrors.UnsupportedOptionError;
  readonly RuntimeFailureError: abstract new (...args: never[]) => OarErrors.RuntimeFailureError;
}

export function oarStartFailure(error: unknown, context: { readonly classes: OarStartErrorClasses; readonly exitedOnItsOwn: boolean; readonly runtime: string }): RuntimeExecutionFailure {
  const { classes, exitedOnItsOwn, runtime } = context;
  if (isRuntimeExecutionFailure(error)) {
    return new RuntimeExecutionFailure({ phase: 'start', category: error.category, retry: error.retry, failure: error.failure, reason: error.message }, { cause: error });
  }
  if (error instanceof classes.SessionNotFoundError || error instanceof classes.UnsupportedOptionError || error instanceof classes.SessionUnavailableError) {
    const retryable = error instanceof classes.SessionUnavailableError && error.reason === 'in_use';
    return new RuntimeExecutionFailure({ phase: 'start', category: retryable ? 'infrastructure' : 'authority', retry: retryable ? 'retryable' : 'non-retryable', reason: error.message }, { cause: error });
  }
  if (error instanceof classes.RuntimeFailureError) {
    return new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable', reason: error.message, failure: { class: runtimeFailureClassOf(error.failure) } }, { cause: error });
  }
  return new RuntimeExecutionFailure({ phase: 'start', category: 'infrastructure', retry: 'retryable', reason: error instanceof Error ? error.message : `${runtime} open failed`, failure: { class: exitedOnItsOwn ? 'runtime_exited' : 'unknown' } }, { cause: error });
}
