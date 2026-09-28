import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionMode, PermissionPolicy } from '@byok-sdk/protocol';
import {
  preparedToolBindingDigest,
  preparedToolSurfaceObservationDigest,
  type InputPreparationToolV1,
} from '../input-preparation';
import { classifyMcpToolsetServerObservation } from '../mcp/observation';
import type { McpToolsetServerObservation } from '../mcp/observation';
import { probeMcpServer } from '../daemon/mcp-tools-probe';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import {
  createPreparedToolSurfaceAssembler,
  type PreparedToolSurface,
} from '../daemon/prepared-tool-surface';
import {
  TOOL_IMPLEMENTATION_RESOLVER_UNCONFIGURED,
  type ToolImplementationIdentityV1,
} from '../daemon/tool-implementation-identity';
import type { McpLaunchAttestation } from '../daemon/trusted-launch-cwd';
import {
  assemblePreparedPiToolSurface,
  preparedNativeToolSelection,
  type PreparedPiServerBinding,
  type PreparedPiToolSurfaceInput,
} from '../adapters/pi/prepared-tools';
import type { McpToolCallHost } from '../adapters/pi/mcp-tools';
import { preparedMemoryProjection, type PreparedAgentMemoryState } from '../daemon/prepared-agent-memory';
import { validatePreparedAgentMemoryObservation } from '../agent-memory/prepared-capability';
import { AGENT_MEMORY_MCP_SERVER_INFO, AGENT_MEMORY_TOOLS } from '../bin/agent-memory-mcp-server';

/**
 * The launch half of a prepared tool surface
 * (`adapters/pi/prepared-tools.ts`), driven against the REAL daemon assembler,
 * a REAL MCP server child and the REAL launch boundary of this machine.
 *
 * The properties, stated as properties:
 *
 * - Assembling a launch surface from the same device facts reproduces the
 *   preparation's own two digests exactly. This is the whole point of the
 *   shared formula: if either side grew its own serializer, this case is the
 *   first thing that breaks.
 * - Anything the preparation bound that has since moved — a tool schema, a
 *   toolset definition revision, an implementation identity — refuses by name
 *   instead of launching a surface the artifact does not describe.
 * - The Pi-native half is selected from the WHOLE admitted policy, not from its
 *   mode, and while no preparation counts a native tool a policy that selects
 *   one is refused rather than silently dropped.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
const RUNTIME_IDENTITY = '@byok-sdk/pi-coding-agent@0.85.1002+test.1';

/** Never reached by these cases: the surface is refused or assembled, never called. */
const UNUSED_HOST: McpToolCallHost = {
  async call() {
    throw new Error('a prepared tool surface assembly must not call a tool');
  },
};

function fixtureServer(): { command: string; args: string[] } {
  return { command: process.execPath, args: [FIXTURE, '{}'] };
}

function registry(): McpToolsetRegistry {
  return new McpToolsetRegistry({
    team: {
      mcpServers: { teamserver: fixtureServer() },
      readOnlyTools: { teamserver: ['echo'] },
    },
  });
}

interface DeviceFacts {
  readonly counted: PreparedToolSurface;
  readonly observation: Readonly<Record<string, McpToolsetServerObservation>>;
  readonly launch: McpLaunchAttestation;
  readonly servers: readonly PreparedPiServerBinding[];
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
  readonly implementations: Readonly<Record<string, ToolImplementationIdentityV1>>;
}

/**
 * Everything one device knows for one preparation, gathered exactly the way
 * production gathers it: the daemon assembles and counts the surface, and the
 * task runner separately observes the same servers for the adapter to carry
 * down. Two observations of one deterministic server, as in production.
 */
async function deviceFacts(permissionMode: PermissionMode): Promise<DeviceFacts> {
  const toolsets = registry();
  const assembler = createPreparedToolSurfaceAssembler({
    toolsetRegistry: toolsets,
    runtimeEnv: () => ({ PATH: process.env.PATH ?? '' }),
  });
  const assembled = await assembler.assemble({
    agentMemory: 'none',
    requiredToolsets: ['team'],
    permissionMode,
    runtimeIdentity: RUNTIME_IDENTITY,
  });
  if (!assembled.ok) throw new Error(`the daemon refused to assemble the counted surface: ${assembled.detail}`);

  const launch = assembled.surface.launch;
  const observed = await probeMcpServer('teamserver', fixtureServer(), {
    label: 'MCP toolset server "teamserver"',
    env: { PATH: process.env.PATH ?? '' },
    cwd: launch.launchCwd,
    timeoutMs: 10_000,
  });
  const observation = Object.freeze({
    teamserver: classifyMcpToolsetServerObservation(observed, {
      toolsetId: 'team',
      readOnlyTools: ['echo'],
    }),
  });
  const server = fixtureServer();
  return {
    counted: assembled.surface,
    observation,
    launch,
    servers: [{ serverName: 'teamserver', toolsetId: 'team', command: server.command, args: server.args }],
    toolsetDefinitionRevisions: assembled.surface.toolsetDefinitionRevisions,
    implementations: Object.freeze({ teamserver: TOOL_IMPLEMENTATION_RESOLVER_UNCONFIGURED }),
  };
}

function launchInput(
  facts: DeviceFacts,
  policy: PermissionPolicy,
  overrides: Partial<PreparedPiToolSurfaceInput> = {},
): PreparedPiToolSurfaceInput {
  return {
    policy,
    countedPermissionMode: policy.mode,
    agentMemory: 'none',
    memory: null,
    observation: facts.observation,
    toolsetDefinitionRevisions: facts.toolsetDefinitionRevisions,
    servers: facts.servers,
    launch: facts.launch,
    toolImplementations: facts.implementations,
    runtimeIdentity: RUNTIME_IDENTITY,
    expectedToolBindingDigest: facts.counted.toolBindingDigest,
    expectedObservationDigest: facts.counted.observationDigest,
    host: UNUSED_HOST,
    ...overrides,
  };
}

const READONLY_NO_NATIVE: PermissionPolicy = { mode: 'readonly', allowTools: [] };

const MEMORY = {
  implementation: {
    descriptor: { kind: 'attested', authority: 'host-install-record', manifestRevision: 'descriptor', form: 'compiled-executable', installPath: '/descriptor', closureDigest: 'a'.repeat(64), closureKind: 'artifact', launchArgv: ['__byok_sdk_helper', 'agent-memory-describe'], launchCwd: '/', launchEnvNamesDigest: 'b'.repeat(64), loaderEnvValuesDigest: 'c'.repeat(64), installStat: { dev: 1, ino: 1, size: 1, mtimeMs: 1, mode: 0o100555, uid: 0, gid: 0 } },
    execution: { kind: 'attested', authority: 'host-install-record', manifestRevision: 'execution', form: 'compiled-executable', installPath: '/execution', closureDigest: 'd'.repeat(64), closureKind: 'artifact', launchArgv: ['__byok_sdk_helper', 'agent-memory-mcp'], launchCwd: '/', launchEnvNamesDigest: 'e'.repeat(64), loaderEnvValuesDigest: 'f'.repeat(64), installStat: { dev: 1, ino: 2, size: 1, mtimeMs: 1, mode: 0o100555, uid: 0, gid: 0 } },
  },
  observation: validatePreparedAgentMemoryObservation({
    serverInfo: AGENT_MEMORY_MCP_SERVER_INFO,
    protocolVersion: '2025-03-26',
    tools: AGENT_MEMORY_TOOLS.map(({ name, description, inputSchema, _meta }) => ({ name, description, inputSchema, _meta })),
  }),
} as unknown as PreparedAgentMemoryState;

describe('the prepared pi tool surface', () => {
  it('reproduces the digests the preparation counted, from the same device facts', async () => {
    const facts = await deviceFacts('readonly');
    const surface = await assemblePreparedPiToolSurface(launchInput(facts, READONLY_NO_NATIVE));
    if (!surface.ok) throw new Error(`${surface.code}: ${surface.message}`);

    expect(surface.toolBindingDigest).toBe(facts.counted.toolBindingDigest);
    expect(surface.observationDigest).toBe(facts.counted.observationDigest);
    // The readonly classification narrowed the manifest to the one tool the
    // operator declared read-only, and the launch registered exactly that.
    expect(surface.toolNames).toEqual(facts.counted.tools.map((tool) => tool.name));
    expect(surface.toolNames).toEqual(['mcp__teamserver__echo']);
    for (const entry of surface.tools) {
      expect(entry.identity).toBe(facts.counted.toolExecutors[entry.name]);
      expect(entry.tool.name).toBe(entry.name);
    }
  }, 30_000);

  it('refuses a tool schema that moved since the preparation was counted', async () => {
    const facts = await deviceFacts('readonly');
    const drifted = {
      teamserver: {
        ...facts.observation.teamserver!,
        tools: facts.observation.teamserver!.tools.map((tool) => ({
          ...tool,
          inputSchema: { type: 'object', properties: { text: { type: 'number' } } },
        })),
      },
    };
    const surface = await assemblePreparedPiToolSurface(
      launchInput(facts, READONLY_NO_NATIVE, { observation: drifted }),
    );
    expect(surface.ok).toBe(false);
    if (surface.ok) return;
    expect(surface.code).toBe('tool_observation_drift');
  }, 30_000);

  it('refuses a toolset definition revision that moved since the preparation was counted', async () => {
    const facts = await deviceFacts('readonly');
    const surface = await assemblePreparedPiToolSurface(
      launchInput(facts, READONLY_NO_NATIVE, {
        toolsetDefinitionRevisions: { team: `sha256:${'9'.repeat(64)}` },
      }),
    );
    expect(surface.ok).toBe(false);
    if (surface.ok) return;
    expect(surface.code).toBe('tool_binding_drift');
  }, 30_000);

  it('refuses a projected server that arrives without its resolved implementation identity', async () => {
    const facts = await deviceFacts('readonly');
    const surface = await assemblePreparedPiToolSurface(
      launchInput(facts, READONLY_NO_NATIVE, { toolImplementations: {} }),
    );
    expect(surface.ok).toBe(false);
    if (surface.ok) return;
    // Refused while the executor fingerprints are built, which is strictly
    // earlier than the binding digest and names the server that is missing:
    // "nobody resolved this" and "the resolver said unavailable" are different
    // facts, and only the second one is a fingerprint input.
    expect(surface.code).toBe('tool_surface_unfingerprintable');
    expect(surface.message).toContain('teamserver');
  }, 30_000);

  it('refuses an admitted mode other than the one the manifest was counted for', async () => {
    const facts = await deviceFacts('readonly');
    const surface = await assemblePreparedPiToolSurface(
      launchInput(facts, { mode: 'auto', allowTools: [] }, { countedPermissionMode: 'readonly' }),
    );
    expect(surface.ok).toBe(false);
    if (surface.ok) return;
    expect(surface.code).toBe('permission_mode_mismatch');
  }, 30_000);

  it('selects the native half from the whole admitted policy, not from its mode alone', () => {
    const readAll = preparedNativeToolSelection({ mode: 'readonly' });
    if (!readAll.ok) throw new Error(readAll.message);
    expect(readAll.selection?.names).toContain('read');
    expect(readAll.selection?.names).toContain('grep');

    // Same mode, different allowTools: a narrower selection.
    const narrowed = preparedNativeToolSelection({ mode: 'readonly', allowTools: ['read'] });
    if (!narrowed.ok) throw new Error(narrowed.message);
    expect(narrowed.selection?.names).toEqual(['read']);

    // Same mode and allowTools, different denyTools: narrower again.
    const denied = preparedNativeToolSelection({ mode: 'readonly', allowTools: ['read', 'grep'], denyTools: ['grep'] });
    if (!denied.ok) throw new Error(denied.message);
    expect(denied.selection?.names).toEqual(['read']);

    // And the empty selection is an absence, not an empty list.
    const none = preparedNativeToolSelection(READONLY_NO_NATIVE);
    if (!none.ok) throw new Error(none.message);
    expect(none.selection).toBeUndefined();
  });

  it('refuses a policy that selects native tools while no preparation counts them', async () => {
    const facts = await deviceFacts('readonly');
    const surface = await assemblePreparedPiToolSurface(
      launchInput(facts, { mode: 'readonly', allowTools: ['read'] }),
    );
    expect(surface.ok).toBe(false);
    if (surface.ok) return;
    expect(surface.code).toBe('native_tools_uncounted');
    // The refusal names the tools, so an operator reading it knows which half
    // of Q1's Main set is missing rather than only that something is.
    expect(surface.message).toContain('read');
  }, 30_000);

  it('refuses a permission mode the pi runtime cannot express at all', async () => {
    const facts = await deviceFacts('readonly');
    const surface = await assemblePreparedPiToolSurface(
      launchInput(facts, { mode: 'confirm' }, { countedPermissionMode: 'confirm' }),
    );
    expect(surface.ok).toBe(false);
    if (surface.ok) return;
    expect(surface.code).toBe('policy_inexpressible');
  }, 30_000);

  it('assembles memory-only read with a runtime-worker call, without a Host MCP identity', async () => {
    const launch = { launchCwd: '/', launcher: null } as McpLaunchAttestation;
    const memoryProjection = preparedMemoryProjection('read', MEMORY, RUNTIME_IDENTITY);
    const expectedToolBindingDigest = preparedToolBindingDigest({
      agentMemory: 'read', memoryImplementation: MEMORY.implementation, launch,
      toolsetDefinitionRevisions: {}, servers: [],
    });
    const expectedObservationDigest = preparedToolSurfaceObservationDigest({
      agentMemory: 'read', memory: MEMORY, launch, permissionMode: 'readonly', runtimeIdentity: RUNTIME_IDENTITY,
      toolsetDefinitionRevisions: {}, tools: memoryProjection.tools, toolExecutors: memoryProjection.toolExecutors, implementations: {},
    });
    const memoryCall = { call: vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"path":"MEMORY.md"}' }] })) };
    const surface = await assemblePreparedPiToolSurface({
      policy: READONLY_NO_NATIVE, countedPermissionMode: 'readonly', agentMemory: 'read', memory: MEMORY,
      observation: {}, toolsetDefinitionRevisions: {}, servers: [], launch, toolImplementations: {}, runtimeIdentity: RUNTIME_IDENTITY,
      expectedToolBindingDigest, expectedObservationDigest, host: UNUSED_HOST, memoryCall,
    });
    if (!surface.ok) throw new Error(`${surface.code}: ${surface.message}`);
    expect(surface.toolNames).toEqual(['memory_recall']);
    const result = await surface.tools[0]!.tool.execute('call-1', { path: 'MEMORY.md' }, undefined);
    expect(memoryCall.call).toHaveBeenCalledExactlyOnceWith('memory_recall', { path: 'MEMORY.md' }, undefined);
    expect(result.details).toMatchObject({ toolsetId: '@byok-sdk/agent-memory', serverName: 'byokagentmemory', toolName: 'memory_recall' });
  });

  it('refuses a sealed memory descriptor that drifted after preparation', async () => {
    const launch = { launchCwd: '/', launcher: null } as McpLaunchAttestation;
    const original = preparedMemoryProjection('read', MEMORY, RUNTIME_IDENTITY);
    const expectedToolBindingDigest = preparedToolBindingDigest({
      agentMemory: 'read', memoryImplementation: MEMORY.implementation, launch,
      toolsetDefinitionRevisions: {}, servers: [],
    });
    const expectedObservationDigest = preparedToolSurfaceObservationDigest({
      agentMemory: 'read', memory: MEMORY, launch, permissionMode: 'readonly', runtimeIdentity: RUNTIME_IDENTITY,
      toolsetDefinitionRevisions: {}, tools: original.tools, toolExecutors: original.toolExecutors, implementations: {},
    });
    const drifted = {
      ...MEMORY,
      observation: {
        ...MEMORY.observation,
        tools: MEMORY.observation.tools.map((tool, index) => index === 0 ? { ...tool, description: `${tool.description} changed` } : tool),
      },
    } as unknown as PreparedAgentMemoryState;
    const memoryCall = { call: vi.fn(async () => ({ content: [] })) };
    const surface = await assemblePreparedPiToolSurface({
      policy: READONLY_NO_NATIVE, countedPermissionMode: 'readonly', agentMemory: 'read', memory: drifted,
      observation: {}, toolsetDefinitionRevisions: {}, servers: [], launch, toolImplementations: {}, runtimeIdentity: RUNTIME_IDENTITY,
      expectedToolBindingDigest, expectedObservationDigest, host: UNUSED_HOST, memoryCall,
    });
    expect(surface.ok).toBe(false);
    if (surface.ok) return;
    expect(surface.code).toBe('tool_observation_drift');
    expect(memoryCall.call).not.toHaveBeenCalled();
  });
});

describe('the shared prepared surface observation digest', () => {
  const TOOLS: readonly InputPreparationToolV1[] = [
    { name: 'mcp__teamserver__echo', description: 'echo', parameters: { type: 'object', properties: {} } },
  ];
  const BASE = {
    agentMemory: 'none' as const,
    memory: null,
    launch: { launchCwd: '/', launcher: null } as McpLaunchAttestation,
    permissionMode: 'readonly' as PermissionMode,
    runtimeIdentity: RUNTIME_IDENTITY,
    toolsetDefinitionRevisions: { team: `sha256:${'1'.repeat(64)}` },
    tools: TOOLS,
    toolExecutors: { 'mcp__teamserver__echo': 'f'.repeat(64) },
    implementations: { teamserver: TOOL_IMPLEMENTATION_RESOLVER_UNCONFIGURED },
  };

  it('is unchanged by the native-selection key while the native half stays empty', () => {
    expect(preparedToolSurfaceObservationDigest(BASE))
      .toBe(preparedToolSurfaceObservationDigest({ ...BASE, nativeSelection: undefined }));
  });

  it('binds the admitted allow and deny lists once a native half exists', () => {
    const withAllow = preparedToolSurfaceObservationDigest({
      ...BASE,
      nativeSelection: { names: ['read'], policy: { mode: 'readonly', allowTools: ['read'] } },
    });
    const withDeny = preparedToolSurfaceObservationDigest({
      ...BASE,
      nativeSelection: { names: ['read'], policy: { mode: 'readonly', allowTools: ['read', 'grep'], denyTools: ['grep'] } },
    });
    // Same mode, same resulting names, different admitted policy: different
    // digests, which is the point of binding the policy rather than the mode.
    expect(withAllow).not.toBe(withDeny);
    expect(withAllow).not.toBe(preparedToolSurfaceObservationDigest(BASE));
  });
});

// Keeps the fixture path honest: a renamed fixture would otherwise fail every
// case above with a spawn error rather than a missing-file one.
it('resolves its MCP fixture server', async () => {
  await expect(fs.access(FIXTURE)).resolves.toBeUndefined();
});
