import type { TerminalProjectionSelection } from '@byok-sdk/protocol';
import { inputPreparationDigest, type InputPreparationToolV1 } from '../input-preparation';
import { AGENT_RESULT_TOOL_DESCRIPTION, AGENT_RESULT_TOOL_NAME } from '../sdk-reserved-mcp';

/** One schema-bound SDK tool, shared by preparation and prepared launch. */
export function preparedResultProjection(selection: TerminalProjectionSelection | undefined, runtimeIdentity: string): {
  readonly tools: readonly InputPreparationToolV1[];
  readonly toolExecutors: Readonly<Record<string, string>>;
} {
  if (selection?.mode !== 'result-document') return { tools: [], toolExecutors: {} };
  return {
    tools: [{ name: AGENT_RESULT_TOOL_NAME, description: AGENT_RESULT_TOOL_DESCRIPTION, parameters: selection.schema as Readonly<Record<string, unknown>> }],
    toolExecutors: {
      [AGENT_RESULT_TOOL_NAME]: inputPreparationDigest({
        kind: 'sdk-submit-result', version: 1, runtimeIdentity, selection,
      }),
    },
  };
}
