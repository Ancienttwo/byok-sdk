const status = {
  CLOUD_REQUEST_INVALID: 400,
  CLOUD_USER_CREDENTIAL_REJECTED: 400,
  CLOUD_MODEL_CREDENTIAL_UNAVAILABLE: 503,
  CLOUD_MODEL_RESPONSE_REJECTED: 502,
  CLOUD_MODEL_REQUEST_FAILED: 502,
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
  if (error instanceof CloudDoError) return new CloudDoError(error.code);
  // DO RPC does not preserve the local Error subclass. Use only the fixed message.
  // Accept exact codes only. Never copy the remote exception's stack or cause.
  if (error instanceof Error && Object.hasOwn(status, error.message)) return new CloudDoError(error.message as CloudDoErrorCode);
  return new CloudDoError('CLOUD_MODEL_REQUEST_FAILED');
}

export function cloudErrorResponse(error: unknown): Response {
  const safe = safeCloudError(error);
  return Response.json({ error: { code: safe.code, retryable: false } }, { status: safe.status });
}
