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
   * The native envelope, verbatim and UNINTERPRETED — `unknown` for the same
   * reason `pi-adapter.ts` reads it as `unknown`: the native compiler is the
   * only authority on what those bytes mean, and a local structural type here
   * would be a second one.
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
 * `expected` is the independently trusted expectation the native verifier
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
