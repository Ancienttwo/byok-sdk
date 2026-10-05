const status = {
  CLOUD_REQUEST_INVALID: 400,
  CLOUD_INBOX_FULL: 429,
  CLOUD_INBOX_CONFLICT: 409,
  CLOUD_INBOX_EXPIRED: 409,
  CLOUD_INBOX_TOO_LARGE: 400,
  CLOUD_WAKE_EXHAUSTED: 409,
  CLOUD_WAKE_EMPTY: 409,
  CLOUD_EVENT_CURSOR_EXPIRED: 410,
  CLOUD_EVENTS_BUSY: 429,
  CLOUD_USER_CREDENTIAL_REJECTED: 400,
  CLOUD_MODEL_CREDENTIAL_UNAVAILABLE: 503,
  CLOUD_MODEL_RESPONSE_REJECTED: 502,
  CLOUD_MODEL_REQUEST_FAILED: 502,
  CLOUD_SESSION_CONFLICT: 409,
  CLOUD_TOOL_NOT_AVAILABLE: 400,
  CLOUD_TOOL_INVOCATION_CONFLICT: 409,
  CLOUD_TOOL_ARGUMENT_INVALID: 400,
  CLOUD_TOOL_LIMIT: 400,
  CLOUD_STEP_LIMIT: 400,
  CLOUD_BUDGET_EXCEEDED: 400,
  CLOUD_TOOL_RESULT_LIMIT: 502,
  CLOUD_TOOL_USAGE_INVALID: 502,
  CLOUD_TOOL_BUSY: 409,
  CLOUD_TOOL_TIMEOUT: 504,
  CLOUD_EXECUTION_TIMEOUT: 504,
  CLOUD_EXECUTION_INTERRUPTED: 409,
  CLOUD_EXECUTION_ABORTED: 409,
  CLOUD_TOOL_FAILED: 502,
} as const;

export type CloudDoErrorCode = keyof typeof status;

/** Never attach an upstream exception, request, response, env, or credential. */
export class CloudDoError extends Error {
  readonly status: number;
  readonly retryable = false;
  constructor(readonly code: CloudDoErrorCode) {
    super(code);
    this.name = 'CloudDoError';
    this.status = status[code];
  }
}

export function safeCloudError(error: unknown): CloudDoError {
  try {
    if (error instanceof CloudDoError) {
      const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
      if (typeof code === 'string' && Object.hasOwn(status, code)) return new CloudDoError(code as CloudDoErrorCode);
    }
    // RPC erases the subclass. Read data properties only; do not invoke upstream getters.
    if (error instanceof Error) {
      const message = Object.getOwnPropertyDescriptor(error, 'message')?.value;
      if (typeof message === 'string' && Object.hasOwn(status, message)) return new CloudDoError(message as CloudDoErrorCode);
    }
  } catch { /* An upstream Proxy or accessor cannot escape the fixed error boundary. */ }
  return new CloudDoError('CLOUD_MODEL_REQUEST_FAILED');
}

export function cloudErrorResponse(error: unknown): Response {
  const safe = safeCloudError(error);
  return Response.json({ error: { code: safe.code, retryable: false } }, { status: safe.status });
}
