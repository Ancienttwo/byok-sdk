/**
 * Compile and verify a frozen provider request without executing it.
 *
 * This is the BYOK-owned replacement for the fork's prepared-input seam, built
 * on the official public surface only:
 *
 * - compile: hand an explicit context to the official provider adapter with a
 *   transport that captures the body and refuses to send, so the exact request
 *   bytes are produced with no network, no session and no task;
 * - certify: classify every top-level key against the recorded shape table, and
 *   refuse anything unaccounted for;
 * - verify: compare the body the session is about to send against the frozen
 *   one, so a drift in identity or content is rejected at the send point.
 *
 * Measured basis: the same official serializer reproduces a session's first
 * request byte-for-byte from an explicit context plus a minimal option set, and
 * the agent-loop callbacks a session injects do not affect the body. See
 * docs/researches/2026-09-19-official-pi-op2u-upstream-request.md §14.
 */
import { createHash } from 'node:crypto';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { assertRequestShape, type RequestShapeReport } from './request-shape';

/** Marker thrown by the capture transport to stop the adapter after it serialized. */
class CaptureComplete extends Error {}

export interface CompilePreparedRequestInput {
  /** Provider api id, e.g. `openai-completions`. Must have a recorded shape table. */
  api: string;
  /** Explicit model, as resolved by the caller. */
  model: unknown;
  /** Fully resolved context: system prompt, messages and tools. */
  context: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] };
  /** Explicit provider options. Anything the body depends on must be here. */
  options: Record<string, unknown>;
}

export interface PreparedRequest {
  api: string;
  /** Exact bytes the frozen request would put on the wire. */
  body: string;
  /** SHA-256 over `body`, usable as a stable identity. */
  digest: string;
  /** Which keys the request carries, and which the caller cannot account for. */
  shape: RequestShapeReport;
}

/** Thrown when a body about to be sent is not the frozen one. */
export class PreparedRequestDriftError extends Error {
  readonly code = 'prepared_request_drift';
  readonly expectedDigest: string;
  readonly observedDigest: string;

  constructor(expectedDigest: string, observedDigest: string) {
    super(
      `prepared request drift: expected ${expectedDigest.slice(0, 12)}…, observed ${observedDigest.slice(0, 12)}…. ` +
        'The frozen request is not what this session is about to send.',
    );
    this.name = 'PreparedRequestDriftError';
    this.expectedDigest = expectedDigest;
    this.observedDigest = observedDigest;
  }
}

/** SHA-256 of a request body, in the same form the prepared envelope uses. */
export function requestDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Produce the frozen request bytes for an explicit context.
 *
 * Pure in effect: the only work is serialization by the official adapter. The
 * transport refuses every call, so nothing leaves the process, and an unknown
 * request key fails closed before the caller can believe it is covered.
 */
export async function compilePreparedRequest(input: CompilePreparedRequestInput): Promise<PreparedRequest> {
  let body: string | undefined;
  const stream = streamSimple(input.model as never, input.context as never, {
    ...input.options,
    fetch: (async (_url: unknown, init: { body?: unknown }) => {
      body = typeof init?.body === 'string' ? init.body : undefined;
      throw new CaptureComplete('mock-custom-fetch: capture complete');
    }) as never,
  } as never);
  // The adapter reports failures through the resolved result, not a rejection.
  await stream.result().catch(() => undefined);
  if (body === undefined || body.length === 0) {
    throw new Error(`compilePreparedRequest: ${input.api} produced no request body`);
  }
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const shape = assertRequestShape(input.api, parsed);
  return { api: input.api, body, digest: requestDigest(body), shape };
}

/**
 * Verify the body a session is about to send against the frozen one.
 *
 * Comparison only: this never rebuilds or repairs a request, so a mismatch is a
 * refusal rather than a substitution.
 */
export function verifyPreparedRequest(prepared: PreparedRequest, observedBody: string): void {
  const observedDigest = requestDigest(observedBody);
  if (observedDigest !== prepared.digest) {
    throw new PreparedRequestDriftError(prepared.digest, observedDigest);
  }
}
