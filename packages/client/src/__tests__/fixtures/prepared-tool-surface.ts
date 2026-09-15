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
   * test can simulate what a `toolsets.reload` or a re-measured implementation
   * does between a preparation and its replay.
   */
  toolBindingDigest: string;
  /** Per-tool implementation kinds the artifact summary records. */
  toolImplementationKinds: Record<string, string>;
  /** When set, both methods answer this refusal instead of a surface. */
  refusal: PreparedToolSurfaceRefusal | undefined;
}

export function recordingToolSurface(
  options: { readonly toolNames?: readonly string[]; readonly attested?: boolean } = {},
): RecordingToolSurface {
  const toolNames = options.toolNames ?? ['mcp__teamserver__list', 'mcp__teamserver__post'];
  const kind = options.attested === true ? 'attested' : 'unavailable:resolver_unconfigured';
  const state: RecordingToolSurface = {
    assembleCalls: [],
    bindingCalls: [],
    toolBindingDigest: 'binding-digest-1',
    toolImplementationKinds: Object.fromEntries(toolNames.map((name) => [name, kind])),
    refusal: undefined,
    async resolveBinding(input): Promise<PreparedToolBindingResult> {
      state.bindingCalls.push({ requiredToolsets: [...input.requiredToolsets] });
      if (state.refusal !== undefined) return state.refusal;
      return {
        ok: true,
        binding: {
          requiredToolsets: [...input.requiredToolsets],
          launch: { launchCwd: '/', launcher: null },
          toolsetDefinitionRevisions: Object.fromEntries(
            input.requiredToolsets.map((id) => [id, `sha256:${'9'.repeat(64)}`]),
          ),
          servers: [],
          toolBindingDigest: state.toolBindingDigest,
        },
      };
    },
    async assemble(input): Promise<PreparedToolSurfaceResult> {
      state.assembleCalls.push({ ...input, requiredToolsets: [...input.requiredToolsets] });
      if (state.refusal !== undefined) return state.refusal;
      return {
        ok: true,
        surface: {
          tools: toolNames.map((name) => ({
            name,
            description: `${name} description`,
            parameters: { type: 'object', properties: {} },
          })),
          toolExecutors: Object.fromEntries(toolNames.map((name, index) => [name, `${index}`.repeat(64).slice(0, 64)])),
          observationDigest: 'observation-digest-1',
          toolBindingDigest: state.toolBindingDigest,
          launch: { launchCwd: '/', launcher: null },
          toolImplementationKinds: { ...state.toolImplementationKinds },
          toolsetDefinitionRevisions: Object.fromEntries(
            input.requiredToolsets.map((id) => [id, `sha256:${'9'.repeat(64)}`]),
          ),
        },
      };
    },
  };
  return state;
}
