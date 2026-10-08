import type {
  PreparedToolBindingResult,
  PreparedToolSurfaceAssembler,
  PreparedToolSurfaceInput,
  PreparedToolSurfaceRefusal,
  PreparedToolSurfaceResult,
} from '../../daemon/prepared-tool-surface';

/**
 * A recording stand-in for the ONE prepared-tool-surface entry
 * (`daemon/prepared-tool-surface.ts`), for the suites whose subject is the
 * orchestration around it — authority, durability, idempotency, the control
 * frame — rather than the observation itself.
 *
 * It spawns nothing, so a test that asserts "this path did not probe" can
 * simply count calls. `prepared-tool-surface.test.ts` drives the REAL entry
 * against real MCP server children; nothing here re-implements what that
 * entry does.
 */
export interface RecordingToolSurface extends PreparedToolSurfaceAssembler {
  readonly assembleCalls: PreparedToolSurfaceInput[];
  readonly bindingCalls: { readonly requiredToolsets: readonly string[] }[];
  /**
   * The spawn-free binding digest this stand-in answers with. Mutable so a
   * test can simulate what a `toolsets.reload` does between a preparation and
   * its replay.
   */
  toolBindingDigest: string;
  /** When set, both methods answer this refusal instead of a surface. */
  refusal: PreparedToolSurfaceRefusal | undefined;
}

export function recordingToolSurface(
  options: { readonly toolNames?: readonly string[] } = {},
): RecordingToolSurface {
  const toolNames = options.toolNames ?? ['mcp__teamserver__list', 'mcp__teamserver__post'];
  const state: RecordingToolSurface = {
    assembleCalls: [],
    bindingCalls: [],
    toolBindingDigest: 'binding-digest-1',
    refusal: undefined,
    async resolveBinding(input): Promise<PreparedToolBindingResult> {
      state.bindingCalls.push({ requiredToolsets: [...input.requiredToolsets] });
      if (state.refusal !== undefined) return state.refusal;
      return {
        ok: true,
        binding: {
          agentMemory: input.agentMemory,
          requiredToolsets: [...input.requiredToolsets],
          toolsetDefinitionRevisions: Object.fromEntries(
            input.requiredToolsets.map((id) => [id, `sha256:${'9'.repeat(64)}`]),
          ),
          servers: [],
          toolBindingDigest: state.toolBindingDigest,
          launchEnv: Object.freeze({ PATH: '/usr/bin:/bin' }),
        },
      };
    },
    async assemble(input): Promise<PreparedToolSurfaceResult> {
      state.assembleCalls.push({ ...input, requiredToolsets: [...input.requiredToolsets] });
      if (state.refusal !== undefined) return state.refusal;
      return {
        ok: true,
        surface: {
          memory: null,
          tools: toolNames.map((name) => ({
            name,
            description: `${name} description`,
            parameters: { type: 'object', properties: {} },
          })),
          toolExecutors: Object.fromEntries(toolNames.map((name, index) => [name, `${index}`.repeat(64).slice(0, 64)])),
          observationDigest: 'observation-digest-1',
          toolBindingDigest: state.toolBindingDigest,
          toolNames: [...toolNames].sort(),
          toolsetDefinitionRevisions: Object.fromEntries(
            input.requiredToolsets.map((id) => [id, `sha256:${'9'.repeat(64)}`]),
          ),
        },
      };
    },
  };
  return state;
}
