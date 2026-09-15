import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalPreparedValue } from '@earendil-works/pi-coding-agent/prepared-session-input';
import {
  mcpToolsetToolNames,
  observeMcpServer,
  projectMcpTools,
  qualifiedMcpToolName,
  type McpToolDescriptor,
  type McpToolsetServerObservation,
} from '../mcp';
import { createPiMcpTools } from '../adapters/pi/mcp-tools';
import { buildToolExecutorsFromObservation } from '../adapters/pi/input-preparation';
import { resolveMcpToolsetGrants } from '../adapters/mcp-tool-grants';
import { BYOK_PI_MCP_CONFIG_PATH } from '../adapters/pi/mcp-config';

/**
 * The single-projection property: the ordinary Pi extension and the core must
 * produce the SAME tools in the SAME order from the SAME observation.
 *
 * This is what makes "the prepared session sees what the ordinary session
 * sees" a property rather than a coincidence, so it is tested against a real
 * extension load rather than against a re-implementation of what the extension
 * is supposed to do.
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
const ENV = { PATH: process.env.PATH ?? '' } as const;

const dirs: string[] = [];
let configPathBefore: string | undefined;

beforeEach(() => {
  configPathBefore = process.env[BYOK_PI_MCP_CONFIG_PATH];
});

afterEach(async () => {
  if (configPathBefore === undefined) delete process.env[BYOK_PI_MCP_CONFIG_PATH];
  else process.env[BYOK_PI_MCP_CONFIG_PATH] = configPathBefore;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-mcp-projection-'));
  dirs.push(dir);
  return dir;
}

function serverSpec(config: Record<string, unknown> = {}) {
  return { command: process.execPath, args: [FIXTURE, JSON.stringify(config)] };
}

/** Two real servers under two toolsets, so ordering has something to order. */
async function realObservation(): Promise<Record<string, McpToolsetServerObservation>> {
  const readServer = await observeMcpServer('salesko', serverSpec(), { env: ENV, timeoutMs: 15_000 });
  const proposeServer = await observeMcpServer('salesko_proposals', serverSpec({
    serverInfo: { name: 'byok-mcp-fixture-proposals', version: '2.0.0' },
    tools: [{
      name: 'propose_update',
      description: 'Propose an update for human review.',
      inputSchema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
    }],
  }), { env: ENV, timeoutMs: 15_000 });
  return {
    // Deliberately inserted in NON-canonical order: the projection must sort,
    // not preserve insertion.
    salesko_proposals: { ...proposeServer, toolsetId: 'salesko.propose.v1' },
    salesko: { ...readServer, toolsetId: 'salesko.read.v1' },
  };
}

describe('MCP projection — canonical ordering', () => {
  it('orders by (toolsetId, serverName, toolName), each by code unit', async () => {
    const projection = projectMcpTools(await realObservation());
    expect(projection.map((tool) => [tool.toolsetId, tool.serverName, tool.toolName])).toEqual([
      ['salesko.propose.v1', 'salesko_proposals', 'propose_update'],
      ['salesko.read.v1', 'salesko', 'echo'],
      ['salesko.read.v1', 'salesko', 'find_leads'],
    ]);
  });

  it('sorts by code unit, not by locale', () => {
    // `localeCompare` puts "a" before "B"; code units do not. A projection
    // ordered by the ambient ICU locale would digest differently per machine.
    const observation: Record<string, McpToolsetServerObservation> = {
      B_server: {
        toolsetId: 't', serverName: 'B_server', protocolVersion: '2025-06-18',
        serverInfo: { name: 'x', version: '1' },
        tools: [{ name: 'a_tool', description: '', inputSchema: { type: 'object' } }],
      },
      a_server: {
        toolsetId: 't', serverName: 'a_server', protocolVersion: '2025-06-18',
        serverInfo: { name: 'x', version: '1' },
        tools: [{ name: 'B_tool', description: '', inputSchema: { type: 'object' } }],
      },
    };
    expect(projectMcpTools(observation).map((tool) => tool.serverName)).toEqual(['B_server', 'a_server']);
  });

  it('refuses a server whose name could not be expressed as a runtime tool name', () => {
    const observation = {
      'salesko.read.v1': {
        toolsetId: 't', serverName: 'salesko.read.v1', protocolVersion: '2025-06-18',
        serverInfo: { name: 'x', version: '1' },
        tools: [{ name: 'echo', description: '', inputSchema: { type: 'object' } }],
      },
    } as Record<string, McpToolsetServerObservation>;
    expect(() => projectMcpTools(observation)).toThrow(/cannot be expressed/u);
  });
});

describe('MCP projection — the ordinary extension and the core agree', () => {
  /**
   * Load the REAL extension module against a real task-scoped config and
   * capture what it registers, in order. Re-implementing the extension here
   * would test this test, not the extension.
   */
  async function registeredByRealExtension(
    observation: Record<string, McpToolsetServerObservation>,
  ): Promise<{ names: string[]; definitions: Array<{ name: string; description: string; parameters: unknown }> }> {
    const dir = await tempDir();
    const configPath = path.join(dir, 'mcp-config.json');
    const mcpServers = Object.fromEntries(Object.keys(observation).map((name) => [name, serverSpec()]));
    await fs.writeFile(configPath, JSON.stringify({ mcpServers, observation }));
    process.env[BYOK_PI_MCP_CONFIG_PATH] = configPath;

    const definitions: Array<{ name: string; description: string; parameters: unknown }> = [];
    const pi = {
      registerTool: (tool: { name: string; description: string; parameters: unknown }) => {
        definitions.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
      },
      on: () => {},
    };
    const extension = await import('../adapters/pi/mcp-extension');
    extension.default(pi as never);
    return { names: definitions.map((tool) => tool.name), definitions };
  }

  it('registers exactly the core projection, in the core\'s order', async () => {
    const observation = await realObservation();
    const projection = projectMcpTools(observation);
    const { names } = await registeredByRealExtension(observation);
    expect(names).toEqual(projection.map((tool) => qualifiedMcpToolName(tool.serverName, tool.toolName)));
  });

  it('produces a byte-identical canonical form from either path', async () => {
    const observation = await realObservation();
    const fromCore = createPiMcpTools(projectMcpTools(observation), { call: async () => ({ content: [] }) });
    const { definitions } = await registeredByRealExtension(observation);

    const canonicalise = (tools: Array<{ name: string; description: string; parameters: unknown }>): string =>
      canonicalPreparedValue(tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })));

    // Byte equality, with the NATIVE canonical form — the same serializer the
    // native compiler digests its tool manifest with.
    expect(canonicalise(definitions)).toBe(canonicalise([...fromCore]));
  });

  it('carries each server\'s real schema, not a proxy\'s', async () => {
    const { definitions } = await registeredByRealExtension(await realObservation());
    const findLeads = definitions.find((tool) => tool.name === 'mcp__salesko__find_leads');
    expect(findLeads?.parameters).toMatchObject({
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
    });
    // The retired proxy registered one `mcp` tool spanning every server.
    expect(definitions.map((tool) => tool.name)).not.toContain('mcp');
    expect(definitions.map((tool) => tool.name)).not.toContain('mcpScript');
  });

  it('registers an SDK-reserved helper under its own bare protocol tool names', async () => {
    // A reserved helper's tool names are fixed by a protocol this SDK owns and
    // are quoted verbatim in the relay prompts and in docs/spec.md. Host
    // toolset tools stay namespaced per server; these must not be renamed.
    const dir = await tempDir();
    const configPath = path.join(dir, 'mcp-config.json');
    await fs.writeFile(configPath, JSON.stringify({
      mcpServers: { byokagentteam: serverSpec() },
      observation: {},
    }));
    process.env[BYOK_PI_MCP_CONFIG_PATH] = configPath;

    const names: string[] = [];
    let onSessionStart: (() => Promise<void>) | undefined;
    const pi = {
      registerTool: (tool: { name: string }) => names.push(tool.name),
      on: (event: string, handler: () => Promise<void>) => {
        if (event === 'session_start') onSessionStart = handler;
      },
    };
    const extension = await import('../adapters/pi/mcp-extension');
    extension.default(pi as never);
    // Nothing is registered synchronously: a reserved helper is read live.
    expect(names).toEqual([]);
    await onSessionStart?.();
    expect(names).toEqual(['echo', 'find_leads']);
    expect(names).not.toContain('mcp__byokagentteam__echo');
  });

  it('namespacing alone is not a clash: a reserved bare name may equal a host tool\'s bare name', async () => {
    const dir = await tempDir();
    const configPath = path.join(dir, 'mcp-config.json');
    const observation = await realObservation();
    await fs.writeFile(configPath, JSON.stringify({
      mcpServers: {
        ...Object.fromEntries(Object.keys(observation).map((name) => [name, serverSpec()])),
        byokagentteam: serverSpec(),
      },
      observation,
    }));
    process.env[BYOK_PI_MCP_CONFIG_PATH] = configPath;

    const names: string[] = [];
    let onSessionStart: (() => Promise<void>) | undefined;
    const pi = {
      registerTool: (tool: { name: string }) => names.push(tool.name),
      on: (event: string, handler: () => Promise<void>) => {
        if (event === 'session_start') onSessionStart = handler;
      },
    };
    const extension = await import('../adapters/pi/mcp-extension');
    extension.default(pi as never);
    // The reserved helper reports `echo` bare; a host toolset tool already
    // registered as `mcp__salesko__echo` does not collide, so this must pass —
    // the guard exists for a genuine clash, not for the namespacing itself.
    await expect(onSessionStart?.()).resolves.toBeUndefined();
    expect(names).toContain('mcp__salesko__echo');
    expect(names).toContain('echo');
  });

  it('refuses two MCP tools that claim the same registered name', async () => {
    // A genuine clash: two RESERVED helpers registering bare names, both of
    // which expose `echo`. Silently keeping the first would pick a winner on
    // the model's behalf for a name it cannot then address unambiguously.
    const dir = await tempDir();
    const configPath = path.join(dir, 'mcp-config.json');
    await fs.writeFile(configPath, JSON.stringify({
      mcpServers: { byokagentteam: serverSpec(), byokagentmessage: serverSpec() },
      observation: {},
    }));
    process.env[BYOK_PI_MCP_CONFIG_PATH] = configPath;

    let onSessionStart: (() => Promise<void>) | undefined;
    const pi = {
      registerTool: () => {},
      on: (event: string, handler: () => Promise<void>) => {
        if (event === 'session_start') onSessionStart = handler;
      },
    };
    const extension = await import('../adapters/pi/mcp-extension');
    extension.default(pi as never);
    await expect(onSessionStart?.()).rejects.toThrow(/two MCP tools claim the name "echo"/u);
  });

  it('refuses to start when a projected server arrived without a daemon observation', async () => {
    const dir = await tempDir();
    const configPath = path.join(dir, 'mcp-config.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { salesko: serverSpec() }, observation: {} }));
    process.env[BYOK_PI_MCP_CONFIG_PATH] = configPath;
    const extension = await import('../adapters/pi/mcp-extension');
    // Discovering the tools here would make the extension the authority.
    expect(() => extension.default({ registerTool: () => {}, on: () => {} } as never))
      .toThrow(/no daemon observation/u);
  });
});

describe('MCP projection — executor fingerprints', () => {
  const REVISIONS = {
    'salesko.read.v1': 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    'salesko.propose.v1': 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  };
  const RUNTIME = '@byok-sdk/pi-coding-agent@0.85.1001+d981de1.1';

  it('covers exactly the projected tools, keyed by their registered names', async () => {
    const observation = await realObservation();
    const { toolExecutors } = await buildToolExecutorsFromObservation({
      observation,
      toolsetDefinitionRevisions: REVISIONS,
      nativeTools: [{ name: 'read', parameters: { type: 'object' } }],
      runtimeIdentity: RUNTIME,
    });
    expect(Object.keys(toolExecutors)).toEqual([
      'read',
      'mcp__salesko_proposals__propose_update',
      'mcp__salesko__echo',
      'mcp__salesko__find_leads',
    ]);
    for (const value of Object.values(toolExecutors)) expect(value).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is deep-equal across two independent builds from the same observation', async () => {
    const observation = await realObservation();
    const build = async () => buildToolExecutorsFromObservation({
      observation,
      toolsetDefinitionRevisions: REVISIONS,
      nativeTools: [],
      runtimeIdentity: RUNTIME,
    });
    expect((await build()).toolExecutors).toEqual((await build()).toolExecutors);
  });

  it.each([
    ['the toolset definition revision', (o: Record<string, McpToolsetServerObservation>) => o, {
      ...REVISIONS,
      'salesko.read.v1': 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
    }],
    ['the server\'s self-reported version', (o: Record<string, McpToolsetServerObservation>) => ({
      ...o,
      salesko: { ...o.salesko!, serverInfo: { ...o.salesko!.serverInfo, version: '9.9.9' } },
    }), REVISIONS],
    ['the negotiated protocol version', (o: Record<string, McpToolsetServerObservation>) => ({
      ...o,
      salesko: { ...o.salesko!, protocolVersion: '2024-11-05' },
    }), REVISIONS],
    ['a tool schema', (o: Record<string, McpToolsetServerObservation>) => ({
      ...o,
      salesko: {
        ...o.salesko!,
        tools: o.salesko!.tools.map((tool: McpToolDescriptor) => (tool.name === 'find_leads'
          ? { ...tool, inputSchema: { type: 'object', properties: { query: { type: 'number' } } } }
          : tool)),
      },
    }), REVISIONS],
  ])('changes when %s changes', async (_label, mutate, revisions) => {
    const observation = await realObservation();
    const base = await buildToolExecutorsFromObservation({
      observation, toolsetDefinitionRevisions: REVISIONS, nativeTools: [], runtimeIdentity: RUNTIME,
    });
    const after = await buildToolExecutorsFromObservation({
      observation: mutate(observation), toolsetDefinitionRevisions: revisions, nativeTools: [], runtimeIdentity: RUNTIME,
    });
    expect(after.toolExecutors['mcp__salesko__find_leads'])
      .not.toBe(base.toolExecutors['mcp__salesko__find_leads']);
  });

  it('does NOT change when a schema is re-serialized with its keys in another order', async () => {
    const observation = await realObservation();
    const base = await buildToolExecutorsFromObservation({
      observation, toolsetDefinitionRevisions: REVISIONS, nativeTools: [], runtimeIdentity: RUNTIME,
    });
    const reordered = {
      ...observation,
      salesko: {
        ...observation.salesko!,
        tools: observation.salesko!.tools.map((tool: McpToolDescriptor) => (tool.name === 'find_leads'
          ? {
            ...tool,
            inputSchema: {
              additionalProperties: false,
              required: ['query'],
              properties: { limit: { type: 'number' }, query: { type: 'string' } },
              type: 'object',
            },
          }
          : tool)),
      },
    };
    const after = await buildToolExecutorsFromObservation({
      observation: reordered, toolsetDefinitionRevisions: REVISIONS, nativeTools: [], runtimeIdentity: RUNTIME,
    });
    expect(after.toolExecutors).toEqual(base.toolExecutors);
  });

  it('always reports the implementation identity as unproven', async () => {
    const { readinessReasons } = await buildToolExecutorsFromObservation({
      observation: await realObservation(),
      toolsetDefinitionRevisions: REVISIONS,
      nativeTools: [],
      runtimeIdentity: RUNTIME,
    });
    // A fingerprint binds what a server SAID, never which executable will run.
    // The gap travels into the receipt instead of being quietly dropped.
    expect(readinessReasons).toEqual(['executor_identity_unproven']);
  });

  it('refuses to fingerprint a toolset with no definition revision', async () => {
    await expect(buildToolExecutorsFromObservation({
      observation: await realObservation(),
      toolsetDefinitionRevisions: { 'salesko.read.v1': REVISIONS['salesko.read.v1'] },
      nativeTools: [],
      runtimeIdentity: RUNTIME,
    })).rejects.toThrow(/no definition revision/u);
  });
});

describe('MCP projection — grants derive from the same observation', () => {
  it('resolves grant names out of the observation object itself', async () => {
    const observation = await realObservation();
    const servers = Object.fromEntries(Object.keys(observation).map((name) => [name, serverSpec()]));
    const resolution = resolveMcpToolsetGrants(servers, observation);
    expect(resolution).toEqual({
      ok: true,
      grants: [
        { server: 'salesko', tools: ['echo', 'find_leads'] },
        { server: 'salesko_proposals', tools: ['propose_update'] },
      ],
    });
    // The same names the runtimes are granted are the names the projection
    // registers — one authority, two views.
    expect(mcpToolsetToolNames(observation)).toEqual({
      salesko: ['echo', 'find_leads'],
      salesko_proposals: ['propose_update'],
    });
  });

  it('still refuses a projected server the daemon never observed', async () => {
    const observation = await realObservation();
    const servers = {
      ...Object.fromEntries(Object.keys(observation).map((name) => [name, serverSpec()])),
      unobserved: serverSpec(),
    };
    const resolution = resolveMcpToolsetGrants(servers, observation);
    expect(resolution.ok).toBe(false);
  });
});
