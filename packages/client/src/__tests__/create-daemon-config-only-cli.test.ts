import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeAdapterOptions } from '../adapters/claude/claude-adapter';
import type { CodexAdapterOptions } from '../adapters/codex/codex-adapter';
import type { PiAdapterOptions } from '../adapters/pi/pi-adapter';
import { loadConfig } from '../bin/config';
import { runConfigCheckCommand } from '../bin/commands/config-check';
import { OFFICIAL_LOCAL_AGENT_RELEASE } from '../bin/official-release';
import { checkDaemonConfig } from '../daemon/config-schema/check';
import { createDaemon } from '../daemon/create-daemon';

/**
 * #1094 acceptance: a Salesko-shaped `byok-agent` config file sets the
 * runtime isolation options, a static `auto` tool authorization and its
 * `fileScope` alone, without the embedded path. The recording subclasses
 * capture the options `createDaemon` constructs each bundled adapter with.
 */
const constructed = vi.hoisted(() => ({
  pi: [] as PiAdapterOptions[],
  claude: [] as ClaudeAdapterOptions[],
  codex: [] as CodexAdapterOptions[],
}));
vi.mock('../adapters/pi/pi-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/pi/pi-adapter')>();
  class RecordingPiAdapter extends actual.PiAdapter {
    constructor(options: PiAdapterOptions = {}) {
      super(options);
      constructed.pi.push(options);
    }
  }
  return { ...actual, PiAdapter: RecordingPiAdapter };
});
vi.mock('../adapters/claude/claude-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/claude/claude-adapter')>();
  class RecordingClaudeAdapter extends actual.ClaudeAdapter {
    constructor(options: ClaudeAdapterOptions = {}) {
      super(options);
      constructed.claude.push(options);
    }
  }
  return { ...actual, ClaudeAdapter: RecordingClaudeAdapter };
});
vi.mock('../adapters/codex/codex-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/codex/codex-adapter')>();
  class RecordingCodexAdapter extends actual.CodexAdapter {
    constructor(options: CodexAdapterOptions = {}) {
      super(options);
      constructed.codex.push(options);
    }
  }
  return { ...actual, CodexAdapter: RecordingCodexAdapter };
});

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'salesko-config-only.json');
const dirs: string[] = [];

interface SaleskoConfigFile {
  readonly file: string;
  readonly storeDir: string;
  readonly hostRoot: string;
  readonly workspace: string;
}

/**
 * The fixture as a config file whose store, Agent home and file-scope root
 * are fresh temp directories. `edit` can turn it into another shape.
 */
async function salesko(edit?: (input: Record<string, any>) => void): Promise<SaleskoConfigFile> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-salesko-cli-'));
  dirs.push(dir);
  const storeDir = path.join(dir, 'computer');
  const hostRoot = path.join(dir, 'host');
  const workspace = path.join(dir, 'workspace');
  await Promise.all([fs.mkdir(storeDir), fs.mkdir(hostRoot), fs.mkdir(workspace)]);
  const input = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, any>;
  input.storeDir = storeDir;
  input.agentHome = { hostStorageRoot: hostRoot };
  const roots = input.toolAuthorization?.fileScope?.roots;
  if (Array.isArray(roots) && roots[0] !== undefined) roots[0].path = workspace;
  edit?.(input);
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify(input));
  return { file, storeDir, hostRoot, workspace };
}

function clearConstructed(): void {
  constructed.pi.splice(0);
  constructed.claude.splice(0);
  constructed.codex.splice(0);
}

afterEach(async () => {
  clearConstructed();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('Salesko-shaped CLI config sets isolation and static auto from the file alone (#1094)', () => {
  it('loads through the CLI, constructs with createDaemon, and reports and applies every value', async () => {
    const { file, workspace } = await salesko();
    const config = loadConfig(file);
    expect(config.localAgentRelease).toEqual(OFFICIAL_LOCAL_AGENT_RELEASE);

    const daemon = createDaemon(config);
    const effective = daemon.status().config;
    expect(effective.warnings).toEqual([]);
    expect(effective.runtimes).toEqual([
      { id: 'pi', source: 'sdk-built', toolAuthorizationAuto: true, isolation: { agentUserContext: 'excluded' }, versionPolicy: { qualifiedVersion: '1.4.0', unqualified: 'allow' } },
      { id: 'claude', source: 'sdk-built', toolAuthorizationAuto: true, isolation: { agentUserContext: 'excluded', agentSessionPersistence: 'disabled' }, versionPolicy: { qualifiedVersion: '2.1.312', unqualified: 'allow' } },
    ]);
    expect(effective.toolAuthorization).toEqual({
      mode: 'static',
      byRuntime: { pi: 'auto', claude: 'auto' },
      localToolApproval: 'host-only',
      fileScope: { mode: 'workspaces', roots: [{ id: 'workspace', path: workspace, access: 'read' }] },
    });

    // The bundled adapters received exactly the configured options; an unset option keeps the adapter default.
    expect(constructed.pi).toEqual([expect.objectContaining({ agentUserContext: 'excluded' })]);
    expect(constructed.claude).toEqual([expect.objectContaining({ agentUserContext: 'excluded', agentSessionPersistence: 'disabled' })]);
    expect(constructed.codex).toEqual([]);
  });

  it('byok-agent config check reports the same effective values with no issues', async () => {
    const { file, workspace } = await salesko();
    const daemon = createDaemon(loadConfig(file));
    const { $schema: _schema, ...input } = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const check = checkDaemonConfig(input, { source: 'cli', localAgentRelease: OFFICIAL_LOCAL_AGENT_RELEASE });
    expect(check).toEqual({ ok: true, issues: [], effective: daemon.status().config });

    const lines: string[] = [];
    expect(runConfigCheckCommand(file, { strict: true, json: false }, { log: (line) => lines.push(line) })).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('result: ok (0 errors, 0 warnings; --strict fails on warnings)');
    expect(out).toContain('pi [sdk-built] auto supported agentUserContext=excluded');
    expect(out).toContain('claude [sdk-built] auto supported agentUserContext=excluded agentSessionPersistence=disabled');
    expect(out).toContain('tool authorization: static (local tool approval: host-only)');
    expect(out).toContain(`file scope:        mode=workspaces roots=workspace=${workspace}:read`);
  });

  it('still expresses Codex isolation and its static all mode without fileScope', async () => {
    const { file } = await salesko((input) => {
      input.runtimeAllowlist = ['codex'];
      input.runtimes = { codex: { agentUserMcpServers: 'excluded' } };
      input.toolAuthorization = { default: 'all' };
    });
    const daemon = createDaemon(loadConfig(file));
    const effective = daemon.status().config;
    expect(effective.warnings).toEqual([]);
    expect(effective.toolAuthorization).toEqual({ mode: 'static', byRuntime: { codex: 'all' }, localToolApproval: 'host-only' });
    expect(constructed.codex).toEqual([expect.objectContaining({ agentUserMcpServers: 'excluded' })]);

    const lines: string[] = [];
    expect(runConfigCheckCommand(file, { strict: true, json: false }, { log: (line) => lines.push(line) })).toBe(0);
    expect(lines.join('\n')).toContain('codex [sdk-built] auto unsupported agentUserMcpServers=excluded sandbox=danger-full-access');
  });
});
