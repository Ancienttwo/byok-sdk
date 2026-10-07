import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  preparedToolBindingDigest,
  preparedToolSurfaceObservationDigest,
} from '../input-preparation';
import { bindMcpToolsetServerObservation } from '../mcp/observation';
import type { McpToolsetServerObservation } from '../mcp/observation';
import { probeMcpServer } from '../daemon/mcp-tools-probe';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import {
  createPreparedToolSurfaceAssembler,
  type PreparedToolSurface,
} from '../daemon/prepared-tool-surface';
import {
  assemblePreparedPiToolSurface,
  type PreparedPiServerBinding,
  type PreparedPiToolSurfaceInput,
} from '../adapters/pi/prepared-tools';
import type { McpToolCallHost } from '../adapters/pi/mcp-tools';
import { preparedMemoryProjection, type PreparedAgentMemoryState } from '../daemon/prepared-agent-memory';
import { validatePreparedAgentMemoryObservation } from '../agent-memory/prepared-capability';
import { AGENT_MEMORY_MCP_SERVER_INFO, AGENT_MEMORY_TOOLS } from '../bin/agent-memory-mcp-server';

/**
 * The launch half of a prepared tool surface
 * (`adapters/pi/prepared-tools.ts`), driven against the REAL daemon assembler
 * and a REAL MCP server child.
 *
 * The properties, stated as properties:
 *
 * - Assembling a launch surface from the same device facts reproduces the
 *   preparation's own two digests exactly. This is the whole point of the
 *   shared formula: if either side grew its own serializer, this case is the
 *   first thing that breaks.
 * - Anything the preparation bound that has since moved — a tool schema, a
 *   toolset definition revision — refuses by name
 *   instead of launching a surface the artifact does not describe.
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
    },
  });
}

interface DeviceFacts {
  readonly counted: PreparedToolSurface;
  readonly observation: Readonly<Record<string, McpToolsetServerObservation>>;
  readonly servers: readonly PreparedPiServerBinding[];
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
}

/**
 * Everything one device knows for one preparation, gathered exactly the way
 * production gathers it: the daemon assembles and counts the surface, and the
 * task runner separately observes the same servers for the adapter to carry
 * down. Two observations of one deterministic server, as in production.
 */
async function deviceFacts(): Promise<DeviceFacts> {
  const toolsets = registry();
  const assembler = createPreparedToolSurfaceAssembler({
    toolsetRegistry: toolsets,
    runtimeEnv: () => ({ PATH: process.env.PATH ?? '' }),
  });
  const assembled = await assembler.assemble({
    agentMemory: 'none',
    requiredToolsets: ['team'],
    runtimeIdentity: RUNTIME_IDENTITY,
  });
  if (!assembled.ok) throw new Error(`the daemon refused to assemble the counted surface: ${assembled.detail}`);

  const observed = await probeMcpServer('teamserver', fixtureServer(), {
    label: 'MCP toolset server "teamserver"',
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 10_000,
  });
  const observation = Object.freeze({
    teamserver: bindMcpToolsetServerObservation(observed, 'team'),
  });
  const server = fixtureServer();
  return {
    counted: assembled.surface,
    observation,
    servers: [{ serverName: 'teamserver', toolsetId: 'team', command: server.command, args: server.args }],
    toolsetDefinitionRevisions: assembled.surface.toolsetDefinitionRevisions,
  };
}

function launchInput(
  facts: DeviceFacts,
  overrides: Partial<PreparedPiToolSurfaceInput> = {},
): PreparedPiToolSurfaceInput {
  return {
    agentMemory: 'none',
    memory: null,
    observation: facts.observation,
    toolsetDefinitionRevisions: facts.toolsetDefinitionRevisions,
    servers: facts.servers,
    runtimeIdentity: RUNTIME_IDENTITY,
    expectedToolBindingDigest: facts.counted.toolBindingDigest,
    expectedObservationDigest: facts.counted.observationDigest,
    host: UNUSED_HOST,
    ...overrides,
  };
}

const MEMORY = {
  observation: validatePreparedAgentMemoryObservation({
    serverInfo: AGENT_MEMORY_MCP_SERVER_INFO,
    protocolVersion: '2025-03-26',
    tools: AGENT_MEMORY_TOOLS.map(({ name, description, inputSchema, _meta }) => ({ name, description, inputSchema, _meta })),
  }),
} as unknown as PreparedAgentMemoryState;

describe('the prepared pi tool surface', () => {
  it('reproduces the digests the preparation counted, from the same device facts', async () => {
    const facts = await deviceFacts();
    const surface = await assemblePreparedPiToolSurface(launchInput(facts));
    if (!surface.ok) throw new Error(`${surface.code}: ${surface.message}`);

    expect(surface.toolBindingDigest).toBe(facts.counted.toolBindingDigest);
    expect(surface.observationDigest).toBe(facts.counted.observationDigest);
    // The launch registered exactly the tools the preparation counted.
    expect(surface.toolNames).toEqual(facts.counted.tools.map((tool) => tool.name));
    expect(surface.toolNames).toEqual(['mcp__teamserver__echo', 'mcp__teamserver__find_leads']);
    for (const entry of surface.tools) {
      expect(entry.identity).toBe(facts.counted.toolExecutors[entry.name]);
      expect(entry.tool.name).toBe(entry.name);
    }
  }, 30_000);

  it('refuses a tool schema that moved since the preparation was counted', async () => {
    const facts = await deviceFacts();
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
      launchInput(facts, { observation: drifted }),
    );
    expect(surface.ok).toBe(false);
    if (surface.ok) return;
    expect(surface.code).toBe('tool_observation_drift');
  }, 30_000);

  it('refuses a toolset definition revision that moved since the preparation was counted', async () => {
    const facts = await deviceFacts();
    const surface = await assemblePreparedPiToolSurface(
      launchInput(facts, {
        toolsetDefinitionRevisions: { team: `sha256:${'9'.repeat(64)}` },
      }),
    );
    expect(surface.ok).toBe(false);
    if (surface.ok) return;
    expect(surface.code).toBe('tool_binding_drift');
  }, 30_000);

  it('assembles memory-only read with a runtime-worker call, without a Host MCP identity', async () => {
    const memoryProjection = preparedMemoryProjection('read', MEMORY, RUNTIME_IDENTITY);
    const expectedToolBindingDigest = preparedToolBindingDigest({
      agentMemory: 'read',
      toolsetDefinitionRevisions: {}, servers: [],
    });
    const expectedObservationDigest = preparedToolSurfaceObservationDigest({
      agentMemory: 'read', memory: MEMORY, runtimeIdentity: RUNTIME_IDENTITY,
      toolsetDefinitionRevisions: {}, tools: memoryProjection.tools, toolExecutors: memoryProjection.toolExecutors,
    });
    const memoryCall = { call: vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"path":"MEMORY.md"}' }] })) };
    const surface = await assemblePreparedPiToolSurface({
      agentMemory: 'read', memory: MEMORY,
      observation: {}, toolsetDefinitionRevisions: {}, servers: [], runtimeIdentity: RUNTIME_IDENTITY,
      expectedToolBindingDigest, expectedObservationDigest, host: UNUSED_HOST, memoryCall,
    });
    if (!surface.ok) throw new Error(`${surface.code}: ${surface.message}`);
    expect(surface.toolNames).toEqual(['memory_recall']);
    const result = await surface.tools[0]!.tool.execute('call-1', { path: 'MEMORY.md' }, undefined);
    expect(memoryCall.call).toHaveBeenCalledExactlyOnceWith('memory_recall', { path: 'MEMORY.md' }, undefined);
    expect(result.details).toMatchObject({ toolsetId: '@byok-sdk/agent-memory', serverName: 'byokagentmemory', toolName: 'memory_recall' });
  });

  it('refuses a sealed memory descriptor that drifted after preparation', async () => {
    const original = preparedMemoryProjection('read', MEMORY, RUNTIME_IDENTITY);
    const expectedToolBindingDigest = preparedToolBindingDigest({
      agentMemory: 'read',
      toolsetDefinitionRevisions: {}, servers: [],
    });
    const expectedObservationDigest = preparedToolSurfaceObservationDigest({
      agentMemory: 'read', memory: MEMORY, runtimeIdentity: RUNTIME_IDENTITY,
      toolsetDefinitionRevisions: {}, tools: original.tools, toolExecutors: original.toolExecutors,
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
      agentMemory: 'read', memory: drifted,
      observation: {}, toolsetDefinitionRevisions: {}, servers: [], runtimeIdentity: RUNTIME_IDENTITY,
      expectedToolBindingDigest, expectedObservationDigest, host: UNUSED_HOST, memoryCall,
    });
    expect(surface.ok).toBe(false);
    if (surface.ok) return;
    expect(surface.code).toBe('tool_observation_drift');
    expect(memoryCall.call).not.toHaveBeenCalled();
  });
});

/**
 * A device configuring MORE toolsets than one record names: the producer counts
 * the named ones only, and the launch must reproduce that, not the whole registry.
 */
function twoToolsetRegistry(): McpToolsetRegistry {
  return new McpToolsetRegistry({
    team: { mcpServers: { teamserver: fixtureServer() } },
    unrelated: { mcpServers: { otherserver: fixtureServer() } },
  });
}

async function countedFor(
  toolsets: McpToolsetRegistry,
  requiredToolsets: readonly string[],
): Promise<PreparedToolSurface> {
  const assembled = await createPreparedToolSurfaceAssembler({
    toolsetRegistry: toolsets,
    runtimeEnv: () => ({ PATH: process.env.PATH ?? '' }),
  }).assemble({ agentMemory: 'none', requiredToolsets, runtimeIdentity: RUNTIME_IDENTITY });
  if (!assembled.ok) throw new Error(`the daemon refused to assemble the counted surface: ${assembled.detail}`);
  return assembled.surface;
}

describe('a tool-less prepared surface (requiredToolsets [] and agentMemory none)', () => {
  function toollessInput(counted: PreparedToolSurface, overrides: Partial<PreparedPiToolSurfaceInput> = {}): PreparedPiToolSurfaceInput {
    return {
      agentMemory: 'none', memory: null,
      observation: {}, toolsetDefinitionRevisions: counted.toolsetDefinitionRevisions, servers: [],
      runtimeIdentity: RUNTIME_IDENTITY,
      expectedToolBindingDigest: counted.toolBindingDigest, expectedObservationDigest: counted.observationDigest,
      host: UNUSED_HOST, ...overrides,
    };
  }

  it('is counted with no tool and no revision, beside a configured toolset', async () => {
    const counted = await countedFor(twoToolsetRegistry(), []);
    expect(counted.tools).toEqual([]);
    expect(counted.toolExecutors).toEqual({});
    expect(counted.toolNames).toEqual([]);
    expect(counted.toolsetDefinitionRevisions).toEqual({});
    expect(counted.memory).toBeNull();
  }, 30_000);

  it('is launched with zero tools, reproducing both digests of the counted surface', async () => {
    const counted = await countedFor(twoToolsetRegistry(), []);
    const surface = await assemblePreparedPiToolSurface(toollessInput(counted));
    if (!surface.ok) throw new Error(`${surface.code}: ${surface.message}`);
    expect(surface.tools).toEqual([]);
    expect(surface.toolNames).toEqual([]);
    expect(surface.toolBindingDigest).toBe(counted.toolBindingDigest);
    expect(surface.observationDigest).toBe(counted.observationDigest);
  }, 30_000);

  it('still refuses a launch whose facts moved: an unnamed toolset revision, memory state', async () => {
    const counted = await countedFor(twoToolsetRegistry(), []);
    // Binding every configured toolset, not the record's, is a different surface.
    const wide = await assemblePreparedPiToolSurface(toollessInput(counted, {
      toolsetDefinitionRevisions: { unrelated: `sha256:${'7'.repeat(64)}` },
    }));
    expect(wide).toMatchObject({ ok: false, code: 'tool_binding_drift' });

    const memory = await assemblePreparedPiToolSurface(toollessInput(counted, { memory: MEMORY }));
    expect(memory).toMatchObject({ ok: false, code: 'tool_surface_unfingerprintable' });

  }, 30_000);

  it('binds only the toolset the record names when the device configures another', async () => {
    const toolsets = twoToolsetRegistry();
    const counted = await countedFor(toolsets, ['team']);
    const revisions = Object.keys(counted.toolsetDefinitionRevisions);
    expect(revisions).toEqual(['team']);
    const facts = await deviceFacts();
    // The launch side, fed the record's own revisions, reproduces the counted digests.
    const surface = await assemblePreparedPiToolSurface(launchInput(facts, {
      toolsetDefinitionRevisions: counted.toolsetDefinitionRevisions,
      expectedToolBindingDigest: counted.toolBindingDigest,
      expectedObservationDigest: counted.observationDigest,
    }));
    if (!surface.ok) throw new Error(`${surface.code}: ${surface.message}`);
    expect(surface.toolBindingDigest).toBe(counted.toolBindingDigest);
    expect(surface.observationDigest).toBe(counted.observationDigest);
  }, 60_000);
});

// Keeps the fixture path honest: a renamed fixture would otherwise fail every
// case above with a spawn error rather than a missing-file one.
it('resolves its MCP fixture server', async () => {
  await expect(fs.access(FIXTURE)).resolves.toBeUndefined();
});
