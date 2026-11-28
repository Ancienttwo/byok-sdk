import { RuntimeExecutionFailure } from '../../runtime-failure.js';

export const CURSOR_LOGIN_REQUIRED = 'Cursor login required. Run cursor-agent login.';

export function cursorAuthFailure(): RuntimeExecutionFailure {
  return new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable', reason: CURSOR_LOGIN_REQUIRED, failure: { class: 'auth' } });
}

const UNSUPPORTED_OPTIONS = [
  'systemPrompt', 'appendSystemPrompt', 'outputSchema', 'launchArgs', 'fork',
  'nativeInteractions', 'approvalChannel', 'serviceTier', 'serviceTierFallback', 'preparedLane',
] as const;

export function unsupportedCursorOption(input: unknown): string | undefined {
  const options = input as Partial<Record<(typeof UNSUPPORTED_OPTIONS)[number], unknown>>;
  return UNSUPPORTED_OPTIONS.find(name => options[name] !== undefined);
}

/** Check the original authority before any env filtering could erase evidence of credentials. */
export function cursorMcpHasCredentials(server: {
  readonly env?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, unknown>>;
}): boolean {
  return Object.keys(server.env ?? {}).length > 0 || Object.keys(server.headers ?? {}).length > 0;
}
