import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPreparedToolSurfaceAssembler } from '../daemon/prepared-tool-surface';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import { createPiInputPreparationCompiler, resolvePinnedPiRuntimeIdentity } from '../adapters/pi/input-preparation';
import { inputPreparationRuntimeIdentityString } from '../input-preparation';
import { preparedCompileRequest } from './fixtures/prepared-compile-snapshot';

describe('memory-only preparation through the real descriptor process and compiler', () => {
  it('counts precisely the selected memory schemas with no task credentials or Host MCP server', async () => {
    // The packaged host exposes the finite __byok_sdk_helper re-entry before
    // its own runtime parser.
    const installPath = await fs.realpath(fileURLToPath(new URL('../../dist/bin/byok-pi-prepared.js', import.meta.url)));
    const compiler = createPiInputPreparationCompiler(resolvePinnedPiRuntimeIdentity());
    const assembler = createPreparedToolSurfaceAssembler({
      toolsetRegistry: new McpToolsetRegistry({}),
      runtimeEnv: () => ({ PATH: '/usr/bin:/bin' }),
      agentMemoryDescribe: { command: process.execPath, args: [installPath, '__byok_sdk_helper', 'agent-memory-describe'] },
      memoryAvailable: () => true,
    });
    for (const mode of ['read', 'read-write'] as const) {
      const result = await assembler.assemble({
        agentMemory: mode, requiredToolsets: [],
        runtimeIdentity: inputPreparationRuntimeIdentityString(compiler.runtime),
      });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      const expected = mode === 'read' ? ['memory_recall'] : ['memory_recall', 'memory_save'];
      expect(result.surface.tools.map(tool => tool.name)).toEqual(expected);
      expect(Object.keys(result.surface.toolExecutors)).toEqual(expected);
      expect(result.surface.toolsetDefinitionRevisions).toEqual({});
      const request = preparedCompileRequest();
      const compiled = await compiler.compile({
        ...request,
        snapshot: { ...request.snapshot, tools: result.surface.tools },
        toolExecutors: result.surface.toolExecutors,
      });
      const body = JSON.parse(compiled.requestBody) as { tools: { function: { name: string } }[] };
      expect(body.tools.map(tool => tool.function.name)).toEqual(expected);
      expect(compiled.requestBody).not.toContain('BYOK_AGENT_MEMORY_CONTEXT');
      expect(compiled.requestBody).not.toContain('BYOK_STORE_DIR');
    }
  }, 30_000);
});
