import type { RuntimePreparedLaunchExpectationV1 } from '../../types';

/**
 * The ONE `prompt_prepared` command shape, written once.
 *
 * Two callers need the SAME bytes for opposite reasons: `pi-adapter.ts` writes
 * this frame to the prepared host's stdin, and
 * `daemon/input-preparation-service.ts` measures it against the runtime's RPC
 * frame cap before it admits a preparation at all. A second literal in either
 * place would make the measured frame and the written frame two different
 * objects that only happen to agree today — which is exactly the class of drift
 * an admission check is supposed to rule out.
 */
export type PreparedPromptCommandV1 = {
  /**
   * First key on purpose. `PiRpcClient.send` builds the wire object as
   * `{...command, id}`, and a key that is already present keeps its insertion
   * position under that spread — so a command that states its own `id` is
   * serialized byte-for-byte as it was built here, which is what makes the
   * measured frame and the written frame the same frame.
   */
  readonly id: string;
  readonly type: 'prompt_prepared';
  /**
   * The prepared envelope, verbatim and UNINTERPRETED — `unknown` for the same
   * reason `pi-adapter.ts` reads it as `unknown`: the prepared host's verifier
   * (`./input-preparation.ts` `verifyPreparedPiInput`) is the only authority on
   * what those bytes mean, and a local structural type here would be a second one.
   */
  readonly input: unknown;
  readonly expected: {
    readonly digest: string;
    readonly model: RuntimePreparedLaunchExpectationV1['model'];
    readonly binding: RuntimePreparedLaunchExpectationV1['binding'];
    readonly toolManifestDigest: string;
  };
};

/**
 * The correlation id the prepared lane's one command carries.
 *
 * Stated rather than assigned by the transport: the service measures this frame
 * long before any process exists to assign an id, and a measurement taken on a
 * frame with a different id than the one eventually written is a measurement of
 * something else. Both call sites pass this constant.
 */
export const PREPARED_PROMPT_COMMAND_ID = 'prepared-1';

/**
 * Build the exact `prompt_prepared` RPC command for one prepared artifact.
 *
 * `expected` is the independently trusted expectation the prepared host's verifier
 * requires — it comes from the durable record at launch and from the freshly
 * compiled facts at admission, never from `envelope`.
 */
export function buildPreparedPromptCommand(
  envelope: unknown,
  expected: RuntimePreparedLaunchExpectationV1,
  id: string,
): PreparedPromptCommandV1 {
  return {
    id,
    type: 'prompt_prepared',
    input: envelope,
    expected: {
      digest: expected.envelopeDigest,
      model: expected.model,
      binding: expected.binding,
      toolManifestDigest: expected.toolManifestDigest,
    },
  };
}

/**
 * The one response a `prompt_prepared` command receives, emitted at the byte-gate
 * verdict. Success means D was verified on the first provider request and is
 * being sent; it is written before the provider replies, so later outcomes are
 * reported by the ordinary session events and never by a second frame.
 *
 * Defined here because the official RPC protocol has no `prompt_prepared`
 * command: the SDK's prepared host answers it before handing the transport to
 * the official RPC loop.
 */
export type PreparedPromptResponseV1 =
  | {
      readonly id: string;
      readonly type: 'response';
      readonly command: 'prompt_prepared';
      readonly success: true;
      readonly data: { readonly sessionId: string; readonly preparedDigest: string };
    }
  | {
      readonly id: string | undefined;
      readonly type: 'response';
      readonly command: 'prompt_prepared';
      readonly success: false;
      readonly error: string;
      readonly code: string;
    };

/** Parse the exact `prompt_prepared` frame: `id`, `type`, `input`, `expected` and nothing else. */
export function parsePreparedPromptCommand(
  line: string,
): { readonly id: string; readonly input: object; readonly expected: object } | { readonly id: string | undefined; readonly error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (cause) {
    return { id: undefined, error: `the first frame is not JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { id: undefined, error: 'the first frame is not an object' };
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' && record.id.trim().length > 0 ? record.id : undefined;
  if (record.type !== 'prompt_prepared') return { id, error: 'the first frame of a prepared host must be prompt_prepared' };
  if (Object.keys(record).some((key) => !['id', 'type', 'input', 'expected'].includes(key))) {
    return { id, error: 'prompt_prepared accepts only id, type, input and expected' };
  }
  if (id === undefined) return { id, error: 'prompt_prepared requires a non-empty id' };
  for (const key of ['input', 'expected'] as const) {
    const value = record[key];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { id, error: `prompt_prepared requires an object "${key}"` };
    }
  }
  return { id, input: record.input as object, expected: record.expected as object };
}

/**
 * Read exactly one LF-terminated frame from `stream`, bounded by `maxBytes`,
 * then pause the stream and push any bytes after the LF back onto it, so the
 * reader attached next sees the stream exactly as if nothing had been read.
 * The caller resumes the stream once that reader is attached.
 */
export function readFirstJsonlFrame(stream: NodeJS.ReadStream | NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const readable = stream as NodeJS.ReadableStream & { unshift(chunk: Buffer): void };
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      readable.off('data', onData);
      readable.off('end', onEnd);
      readable.off('error', onError);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        size += buffer.length;
        chunks.push(buffer);
        if (size > maxBytes) {
          cleanup();
          readable.pause();
          reject(new Error(`the first frame exceeds the ${maxBytes}-byte frame limit`));
        }
        return;
      }
      if (size + newline + 1 > maxBytes) {
        cleanup();
        readable.pause();
        reject(new Error(`the first frame exceeds the ${maxBytes}-byte frame limit`));
        return;
      }
      chunks.push(buffer.subarray(0, newline));
      const rest = buffer.subarray(newline + 1);
      cleanup();
      readable.pause();
      if (rest.length > 0) readable.unshift(rest);
      const line = Buffer.concat(chunks).toString('utf8');
      resolve(line.endsWith('\r') ? line.slice(0, -1) : line);
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error('the input ended before a complete first frame'));
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    readable.on('data', onData);
    readable.on('end', onEnd);
    readable.on('error', onError);
  });
}

/** SDK-owned terminal frame for a refused continuation, before native error events. */
export const PREPARED_GATE_REFUSAL_CODES = [
  'prepared_body_drift', 'prepared_endpoint_mismatch', 'prepared_context_drift',
  'prepared_session_unarmed', 'prepared_headers_invalid', 'prepared_transport_repeated',
] as const;
export type PreparedGateRefusalCode = typeof PREPARED_GATE_REFUSAL_CODES[number];
export interface PreparedRunRefusalFrame {
  readonly type: 'prepared_run_refused';
  readonly code: PreparedGateRefusalCode;
  readonly sequence: number;
}
