import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  realToolImplementationFsProbe,
  type ToolImplementationFsProbe,
  type ToolImplementationAuthority,
} from '@byok-sdk/implementation-identity';
import { createPreparedToolSurfaceAssembler } from '../daemon/prepared-tool-surface';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import { createPiInputPreparationCompiler, resolveInstalledPiRuntimeIdentity } from '../adapters/pi/input-preparation';
import { inputPreparationRuntimeIdentityString } from '../input-preparation';
import { preparedCompileRequest } from './fixtures/prepared-compile-snapshot';
import { trustedCwd } from './fixtures/launch-cwd';

describe('memory-only preparation through the real descriptor process and compiler', () => {
  it('counts precisely the selected memory schemas with no task credentials or Host MCP server', async () => {
    // Real artifact/interpreter bytes and stat tuples; ownership alone is the
    // established test seam. This does not attest a production installation.
    const probe: ToolImplementationFsProbe = {
      ...realToolImplementationFsProbe,
      async lstat(target) {
        const stat = await realToolImplementationFsProbe.lstat(target);
        return { ...stat, uid: 0, mode: stat.mode & ~0o222 };
      },
    };
    // The packaged host exposes the finite __byok_sdk_helper re-entry before
    // its own runtime parser; the identity subject here remains SDK helper.
    const installPath = await fs.realpath(fileURLToPath(new URL('../../dist/bin/byok-pi-prepared.js', import.meta.url)));
    const interpreter = await fs.realpath(process.execPath);
    const launchCwd = await trustedCwd();
    const closureDigest = await probe.digest(installPath);
    const interpreterDigest = await probe.digest(interpreter);
    const authority: ToolImplementationAuthority = {
      async resolve(locator) {
        if (locator.subject.kind !== 'sdk-helper' || !('entry' in locator)) throw new Error('memory-only must not resolve a Host MCP identity');
        return {
          kind: 'attested', authority: 'host-install-record', manifestRevision: 'memory-test',
          form: 'interpreter+bundle', installPath, closureKind: 'artifact', closureDigest,
          interpreter: { path: interpreter, digest: interpreterDigest, loadCommandsDigest: 'a'.repeat(64) },
          launchArgv: ['__byok_sdk_helper', locator.entry!], launchCwd,
        };
      },
    };
    const compiler = createPiInputPreparationCompiler(resolveInstalledPiRuntimeIdentity());
    const assembler = createPreparedToolSurfaceAssembler({
      toolsetRegistry: new McpToolsetRegistry({}),
      runtimeEnv: () => ({ PATH: '/usr/bin:/bin' }),
      toolImplementationAuthority: authority,
      toolImplementationFsProbe: probe,
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
