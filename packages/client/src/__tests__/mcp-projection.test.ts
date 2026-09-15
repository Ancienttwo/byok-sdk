import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalPreparedValue } from '@earendil-works/pi-coding-agent/prepared-session-input';
import {
  classifyMcpToolsetServerObservation,
  filterMcpObservationForPolicy,
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
import { trustedCwd } from './fixtures/launch-cwd';

const LAUNCH = {
  launchCwd: '/',
  launcher: { interpreter: '/usr/bin/node', script: '/pkg/bin/byok-launch-cwd.mjs' },
} as const;

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

/**
 * Load the REAL extension module against a real task-scoped config and
 * capture what it registers, in order. Re-implementing the extension here
 * would test this test, not the extension.
 */
async function registeredByRealExtension(
  observation: Record<string, McpToolsetServerObservation>,
  permissionMode = 'auto',
): Promise<{ names: string[]; definitions: Array<{ name: string; description: string; parameters: unknown }> }> {
  const dir = await tempDir();
  const configPath = path.join(dir, 'mcp-config.json');
  const mcpServers = Object.fromEntries(Object.keys(observation).map((name) => [name, serverSpec()]));
  await fs.writeFile(configPath, JSON.stringify({ mcpServers, observation, permissionMode, launchCwd: await trustedCwd() }));
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

describe('MCP projection — the ordinary extension and the core agree', () => {
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
      permissionMode: 'auto',
      launchCwd: await trustedCwd(),
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
      permissionMode: 'auto',
      launchCwd: await trustedCwd(),
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
      permissionMode: 'auto',
      launchCwd: await trustedCwd(),
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
    await fs.writeFile(configPath, JSON.stringify({
      mcpServers: { salesko: serverSpec() },
      observation: {},
      permissionMode: 'auto',
      launchCwd: await trustedCwd(),
    }));
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
      permissionMode: 'auto',
      toolsetDefinitionRevisions: REVISIONS,
      nativeTools: [{ name: 'read', parameters: { type: 'object' } }],
      runtimeIdentity: RUNTIME, launch: LAUNCH,
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
      permissionMode: 'auto',
      toolsetDefinitionRevisions: REVISIONS,
      nativeTools: [],
      runtimeIdentity: RUNTIME, launch: LAUNCH,
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
      observation, permissionMode: 'auto', toolsetDefinitionRevisions: REVISIONS, nativeTools: [], runtimeIdentity: RUNTIME, launch: LAUNCH,
    });
    const after = await buildToolExecutorsFromObservation({
      observation: mutate(observation), permissionMode: 'auto', toolsetDefinitionRevisions: revisions, nativeTools: [], runtimeIdentity: RUNTIME, launch: LAUNCH,
    });
    expect(after.toolExecutors['mcp__salesko__find_leads'])
      .not.toBe(base.toolExecutors['mcp__salesko__find_leads']);
  });

  it('changes when the launch directory or the launcher changes, and the operator revision does not', async () => {
    // The launch boundary is bound as its OWN fact, beside the toolset's
    // `definitionRevision` rather than inside it. A server started in a
    // different directory, or reached through a different launcher, is not the
    // same executor — so a manifest frozen under one must not validate under
    // the other. The operator's configured `{command, args}` revision is
    // untouched by any of it, so an SDK launcher upgrade never churns the
    // device configuration's own digest.
    const observation = await realObservation();
    const base = await buildToolExecutorsFromObservation({
      observation, permissionMode: 'auto', toolsetDefinitionRevisions: REVISIONS, nativeTools: [], runtimeIdentity: RUNTIME, launch: LAUNCH,
    });
    const movedCwd = await buildToolExecutorsFromObservation({
      observation, permissionMode: 'auto', toolsetDefinitionRevisions: REVISIONS, nativeTools: [], runtimeIdentity: RUNTIME,
      launch: { ...LAUNCH, launchCwd: '/opt/byok/releases/1.2.3-abcdef' },
    });
    const newLauncher = await buildToolExecutorsFromObservation({
      observation, permissionMode: 'auto', toolsetDefinitionRevisions: REVISIONS, nativeTools: [], runtimeIdentity: RUNTIME,
      launch: { ...LAUNCH, launcher: { interpreter: '/usr/local/bin/node', script: LAUNCH.launcher.script } },
    });
    const noLauncher = await buildToolExecutorsFromObservation({
      observation, permissionMode: 'auto', toolsetDefinitionRevisions: REVISIONS, nativeTools: [], runtimeIdentity: RUNTIME,
      launch: { launchCwd: LAUNCH.launchCwd, launcher: null },
    });
    const key = 'mcp__salesko__find_leads';
    const fingerprints = [base, movedCwd, newLauncher, noLauncher].map((r) => r.toolExecutors[key]);
    expect(new Set(fingerprints).size).toBe(4);
    // Same toolset revisions throughout: the operator changed nothing.
    expect(REVISIONS).toEqual({
      'salesko.read.v1': `sha256:${'1'.repeat(64)}`,
      'salesko.propose.v1': `sha256:${'2'.repeat(64)}`,
    });
  });

  it('does NOT change when a schema is re-serialized with its keys in another order', async () => {
    const observation = await realObservation();
    const base = await buildToolExecutorsFromObservation({
      observation, permissionMode: 'auto', toolsetDefinitionRevisions: REVISIONS, nativeTools: [], runtimeIdentity: RUNTIME, launch: LAUNCH,
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
      observation: reordered, permissionMode: 'auto', toolsetDefinitionRevisions: REVISIONS, nativeTools: [], runtimeIdentity: RUNTIME, launch: LAUNCH,
    });
    expect(after.toolExecutors).toEqual(base.toolExecutors);
  });

  it('always reports the implementation identity as unproven', async () => {
    const { readinessReasons } = await buildToolExecutorsFromObservation({
      observation: await realObservation(),
      permissionMode: 'auto',
      toolsetDefinitionRevisions: REVISIONS,
      nativeTools: [],
      runtimeIdentity: RUNTIME, launch: LAUNCH,
    });
    // A fingerprint binds what a server SAID, never which executable will run.
    // The gap travels into the receipt instead of being quietly dropped.
    expect(readinessReasons).toEqual(['executor_identity_unproven']);
  });

  it('refuses to fingerprint a toolset with no definition revision', async () => {
    await expect(buildToolExecutorsFromObservation({
      observation: await realObservation(),
      permissionMode: 'auto',
      toolsetDefinitionRevisions: { 'salesko.read.v1': REVISIONS['salesko.read.v1'] },
      nativeTools: [],
      runtimeIdentity: RUNTIME, launch: LAUNCH,
    })).rejects.toThrow(/no definition revision/u);
  });
});

describe('MCP projection — grants derive from the same observation', () => {
  it('resolves grant names out of the observation object itself', async () => {
    const observation = await realObservation();
    const servers = Object.fromEntries(Object.keys(observation).map((name) => [name, serverSpec()]));
    const resolution = resolveMcpToolsetGrants(servers, observation, 'auto');
    expect(resolution).toMatchObject({
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
    const resolution = resolveMcpToolsetGrants(servers, observation, 'auto');
    expect(resolution.ok).toBe(false);
  });
});

/**
 * One real server shaped like `salesko.read.v1` plus the propose tool that
 * must never survive a restricted policy, classified through the SAME join the
 * daemon performs (`classifyMcpToolsetServerObservation`) rather than by
 * hand-writing `readOnly` flags a real device could never produce.
 */
const READ_TOOLS = [
  'get_account', 'get_contact', 'get_lead', 'list_accounts',
  'list_contacts', 'search_leads', 'summarize_pipeline',
] as const;

function saleskoShapedSpec() {
  return serverSpec({
    serverInfo: { name: 'byok-mcp-fixture-salesko', version: '1.0.0' },
    tools: [
      ...READ_TOOLS.map((name) => ({
        name,
        description: `${name} reads.`,
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      })),
      {
        name: 'propose_graph_change_set',
        description: 'Propose a change set for human review.',
        inputSchema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
      },
    ],
  });
}

async function classifiedObservation(
  readOnlyTools: readonly string[] | null = [...READ_TOOLS],
): Promise<Record<string, McpToolsetServerObservation>> {
  const observed = await observeMcpServer('salesko', saleskoShapedSpec(), { env: ENV, timeoutMs: 15_000 });
  return {
    salesko: classifyMcpToolsetServerObservation(observed, {
      toolsetId: 'salesko.read.v1',
      readOnlyTools,
    }),
  };
}

describe('MCP projection — one policy filter, every consumer', () => {
  it('classifies exactly the declared tools and nothing else', async () => {
    const observation = await classifiedObservation();
    expect(observation.salesko!.tools.map((tool) => [tool.name, tool.readOnly])).toEqual([
      ['get_account', true],
      ['get_contact', true],
      ['get_lead', true],
      ['list_accounts', true],
      ['list_contacts', true],
      ['propose_graph_change_set', false],
      ['search_leads', true],
      ['summarize_pipeline', true],
    ]);
  });

  it('rejects a classification naming a tool the server does not expose', async () => {
    // The declaration is stale configuration, not a smaller toolset: the
    // operator classified something that no longer exists, so nothing else
    // they said about this server can be trusted either.
    await expect(classifiedObservation([...READ_TOOLS, 'get_invoice']))
      .rejects.toThrow(/does not expose tool name\(s\) \["get_invoice"\]/u);
  });

  it('leaves every tool unclassified when the toolset declares nothing', async () => {
    const observation = await classifiedObservation(null);
    expect(observation.salesko!.tools.every((tool) => tool.readOnly === undefined)).toBe(true);
  });

  it('under readonly the extension registers exactly the classified read tools', async () => {
    const observation = await classifiedObservation();
    const allowed = filterMcpObservationForPolicy(observation, 'readonly');
    expect(allowed.ok).toBe(true);
    const expected = projectMcpTools((allowed as { observation: typeof observation }).observation)
      .map((tool) => qualifiedMcpToolName(tool.serverName, tool.toolName));

    const { names } = await registeredByRealExtension(observation, 'readonly');
    expect(names).toEqual(expected);
    expect(names).toEqual(READ_TOOLS.map((tool) => `mcp__salesko__${tool}`));
    // Not registered, not merely refused at call time: the model never sees it.
    expect(names).not.toContain('mcp__salesko__propose_graph_change_set');
  });

  it('under auto the same observation registers the propose tool too', async () => {
    const { names } = await registeredByRealExtension(await classifiedObservation(), 'auto');
    expect(names).toContain('mcp__salesko__propose_graph_change_set');
    expect(names).toHaveLength(READ_TOOLS.length + 1);
  });

  it('freezes the SAME filtered set the ordinary extension registers', async () => {
    // The single-projection property, extended to the policy: the prepared
    // manifest and the ordinary session must not be able to disagree about
    // which tools a mode allows.
    const observation = await classifiedObservation();
    const { names } = await registeredByRealExtension(observation, 'readonly');
    const { toolExecutors } = await buildToolExecutorsFromObservation({
      observation,
      permissionMode: 'readonly',
      toolsetDefinitionRevisions: { 'salesko.read.v1': `sha256:${'1'.repeat(64)}` },
      nativeTools: [],
      runtimeIdentity: '@byok-sdk/pi-coding-agent@0.85.1002+test', launch: LAUNCH,
    });
    expect(Object.keys(toolExecutors)).toEqual(names);
  });

  it('refuses to freeze a manifest for a mode the toolset carries no classification for', async () => {
    await expect(buildToolExecutorsFromObservation({
      observation: await classifiedObservation(null),
      permissionMode: 'readonly',
      toolsetDefinitionRevisions: { 'salesko.read.v1': `sha256:${'1'.repeat(64)}` },
      nativeTools: [],
      runtimeIdentity: '@byok-sdk/pi-coding-agent@0.85.1002+test', launch: LAUNCH,
    })).rejects.toThrow(/declares no McpToolsetConfig\.readOnlyTools/u);
  });

  it('refuses a server the policy leaves with nothing callable', async () => {
    const observation = await classifiedObservation([]);
    expect(observation.salesko!.tools.every((tool) => tool.readOnly === false)).toBe(true);
    expect(filterMcpObservationForPolicy(observation, 'readonly')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('exposes no tool classified read-only'),
    });
  });

  it('auto is every observed tool, classified or not', async () => {
    const unclassified = await classifiedObservation(null);
    expect(filterMcpObservationForPolicy(unclassified, 'auto')).toEqual({ ok: true, observation: unclassified });
  });

  it('confirm is every observed tool and needs no classification at all', async () => {
    // Confirm gates each call on a human rather than on a tool set, so it is
    // NOT a narrowing mode: an unclassified toolset must pass through it
    // unchanged instead of being refused for a missing `readOnlyTools`.
    const unclassified = await classifiedObservation(null);
    expect(filterMcpObservationForPolicy(unclassified, 'confirm'))
      .toEqual({ ok: true, observation: unclassified });
    const classified = await classifiedObservation();
    expect(filterMcpObservationForPolicy(classified, 'confirm'))
      .toEqual({ ok: true, observation: classified });
  });

  it('plan narrows exactly like readonly', async () => {
    // `daemon/policy.ts` ranks plan as the mode that produces NO side effects,
    // so it may never be wider than readonly.
    const observation = await classifiedObservation();
    const plan = filterMcpObservationForPolicy(observation, 'plan');
    const readonly = filterMcpObservationForPolicy(observation, 'readonly');
    expect(plan).toEqual(readonly);
    expect(projectMcpTools((plan as { observation: typeof observation }).observation)
      .map((tool) => qualifiedMcpToolName(tool.serverName, tool.toolName)))
      .toEqual(READ_TOOLS.map((tool) => `mcp__salesko__${tool}`));
    // And it inherits readonly's fail-closed refusal, not auto's pass-through.
    expect(filterMcpObservationForPolicy(await classifiedObservation(null), 'plan')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('declares no McpToolsetConfig.readOnlyTools'),
    });
  });
});
