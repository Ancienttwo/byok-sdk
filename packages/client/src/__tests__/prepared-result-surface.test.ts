import type { TerminalProjectionSelection } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { createPiInputPreparationCompiler, resolvePinnedPiRuntimeIdentity } from '../adapters/pi/input-preparation';
import { createPreparedToolSurfaceAssembler, fingerprintPreparedToolSurface } from '../daemon/prepared-tool-surface';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import { inputPreparationRuntimeIdentityString } from '../input-preparation';
import { AGENT_RESULT_TOOL_NAME } from '../sdk-reserved-mcp';

function selection(required: readonly string[]): TerminalProjectionSelection {
  return {
    mode: 'result-document', contract: 'test.prepared-result.v1',
    schema: {
      type: 'object', additionalProperties: false, required: [...required],
      properties: { schemaVersion: { const: 'test.prepared-result.v1' }, text: { type: 'string' } },
    },
  } as TerminalProjectionSelection;
}

const compiler = createPiInputPreparationCompiler(resolvePinnedPiRuntimeIdentity());
const runtimeIdentity = inputPreparationRuntimeIdentityString(compiler.runtime);
const MODEL = {
  id: 'glm-4.6', name: 'Synthetic GLM 4.6', api: 'openai-completions' as const, provider: 'zai',
  baseUrl: 'https://api.z.ai/api/coding/paas/v4', reasoning: false, input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
};

async function surfaceFor(terminalProjection: TerminalProjectionSelection | undefined) {
  const assembled = await createPreparedToolSurfaceAssembler({ toolsetRegistry: new McpToolsetRegistry({}), runtimeEnv: () => ({}) })
    .assemble({ agentMemory: 'none', requiredToolsets: [], runtimeIdentity, ...(terminalProjection === undefined ? {} : { terminalProjection }) });
  if (!assembled.ok) throw new Error(`${assembled.code}: ${assembled.detail}`);
  const compiled = await compiler.compile({
    snapshot: { prompt: { systemPrompt: 'Summarise.' }, messages: [{ role: 'user', content: 'Frozen input.', timestamp: 1 }], tools: assembled.surface.tools },
    model: MODEL, options: { cacheRetention: 'none', maxTokens: 512 },
    binding: { inputIdentity: 'in', runtimeIdentity, policyIdentity: 'pol', profileRevision: 'prof' },
    toolExecutors: assembled.surface.toolExecutors,
  });
  return { surface: assembled.surface, compiled };
}

describe('a prepared SummaryJob is a one-tool submit_result record', () => {
  it('counts exactly submit_result, carrying the frozen schema as its input schema', async () => {
    const selected = selection(['schemaVersion', 'text']);
    const { surface } = await surfaceFor(selected);
    expect(surface.tools.map(tool => tool.name)).toEqual([AGENT_RESULT_TOOL_NAME]);
    expect(surface.tools[0]!.parameters).toEqual((selected as { schema: unknown }).schema);
    const fingerprinted = await fingerprintPreparedToolSurface({
      agentMemory: 'none', memory: null, observation: {}, runtimeIdentity, toolsetDefinitionRevisions: {}, terminalProjection: selected,
    });
    if (!fingerprinted.ok) throw new Error(fingerprinted.message);
    expect(fingerprinted.fingerprint.toolNames).toEqual([AGENT_RESULT_TOOL_NAME]);
  });

  it('has no tool at all when no result selection is frozen (no extractor path, no implicit tool)', async () => {
    const { surface } = await surfaceFor(undefined);
    expect(surface.tools).toEqual([]);
  });

  it('changes toolManifestDigest and the observation digest with the schema, and keeps both for an identical schema', async () => {
    const a = await surfaceFor(selection(['schemaVersion', 'text']));
    const same = await surfaceFor(selection(['schemaVersion', 'text']));
    const other = await surfaceFor(selection(['schemaVersion']));
    expect(same.compiled.toolManifestDigest).toBe(a.compiled.toolManifestDigest);
    expect(same.surface.observationDigest).toBe(a.surface.observationDigest);
    expect(other.compiled.toolManifestDigest).not.toBe(a.compiled.toolManifestDigest);
    expect(other.surface.observationDigest).not.toBe(a.surface.observationDigest);
  });
});
