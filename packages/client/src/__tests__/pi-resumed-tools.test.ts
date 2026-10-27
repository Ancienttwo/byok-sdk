import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import { resetResumedPiTools } from '../bin/pi-session-runtime';
import { parsePiAgentToolPolicy, piAgentNativeToolOptions } from '../adapters/pi/agent-tool-policy';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function dirs(defaultTools?: string[]): { cwd: string; agentDir: string; sessionDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-resumed-tools-'));
  roots.push(root);
  const agentDir = mkdtempSync(join(root, 'agent-'));
  if (defaultTools !== undefined) writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultTools }));
  return { cwd: mkdtempSync(join(root, 'cwd-')), agentDir, sessionDir: mkdtempSync(join(root, 'sessions-')) };
}

type ToolSpec = { name: string; defaultActive?: boolean; exposure?: 'direct' | 'deferred' | 'codemode' };
const tool = ({ name, ...rest }: ToolSpec) => ({
  name, label: name, description: name, parameters: { type: 'object', properties: {} }, ...rest,
  execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: undefined }),
});

/**
 * The tools an open's extension registers: at load, as the SDK MCP extension
 * does, and during `session_start`, as its reserved helper servers do.
 */
type Registrations = { atLoad: ToolSpec[]; atStart?: ToolSpec[] };

/** Opens a session as the SDK hosts do, then binds extensions (`session_start`). */
async function open(
  paths: ReturnType<typeof dirs>, sessionManager: SessionManager, registrations: Registrations,
  options: { tools?: string[]; excludeTools?: string[]; agentBuiltinTools?: readonly string[]; reset: boolean },
): Promise<string[]> {
  const { cwd, agentDir } = paths;
  const extension: ExtensionFactory = (pi) => {
    for (const spec of registrations.atLoad) pi.registerTool(tool(spec) as never);
    pi.on('session_start', () => { for (const spec of registrations.atStart ?? []) pi.registerTool(tool(spec) as never); });
  };
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [extension] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir, sessionManager, settingsManager, resourceLoader, tools: options.tools, excludeTools: options.excludeTools,
  });
  try {
    if (options.reset) resetResumedPiTools(session, settingsManager, cwd, options.agentBuiltinTools);
    await session.bindExtensions({});
    return session.getActiveToolNames().sort();
  } finally {
    session.dispose();
  }
}

/** A previous open's transcript that declared `names` as its active tools. */
function previousTranscript(paths: ReturnType<typeof dirs>, names: string[]): string {
  const first = SessionManager.create(paths.cwd, paths.sessionDir);
  first.appendMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() });
  first.appendMessage({
    role: 'system', content: '', timestamp: Date.now(),
    toolsAdded: names.map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })),
  } as never);
  return first.getSessionFile()!;
}

/** Active tools of a resumed open and of a new open with the same options. */
async function resumedAndFresh(
  paths: ReturnType<typeof dirs>, transcriptTools: string[], registrations: Registrations,
  options: { excludeTools?: string[]; reset?: boolean } = {},
) {
  const file = previousTranscript(paths, transcriptTools);
  const reset = options.reset ?? true;
  const resumed = await open(paths, SessionManager.open(file, paths.sessionDir), registrations, { ...options, reset });
  const fresh = await open(paths, SessionManager.create(paths.cwd, paths.sessionDir), registrations, { ...options, reset });
  return { resumed, fresh };
}

const DEFAULTS = ['read', 'bash', 'edit', 'write'];

describe('resumed Pi session tools (Pi 1.4)', () => {
  it.each([{agentBuiltinTools:['read'] as const}, {agentBuiltinTools:[] as const}])('replaces stale native tools with Agent selection $agentBuiltinTools and preserves current MCP tools', async ({agentBuiltinTools}) => {
    const paths = dirs();
    const file = previousTranscript(paths, [...DEFAULTS, 'stale_mcp', 'late_off']);
    const policy = parsePiAgentToolPolicy({builtinTools:agentBuiltinTools,userContext:'excluded',extensions:[]});
    const registrations = {atLoad:[{name:'current_mcp'}],atStart:[{name:'late_off',defaultActive:false}]};
    const options = {...piAgentNativeToolOptions(policy),agentBuiltinTools,reset:true};
    const resumed = await open(paths,SessionManager.open(file,paths.sessionDir),registrations,options);
    const fresh = await open(paths,SessionManager.create(paths.cwd,paths.sessionDir),registrations,options);
    expect(resumed).toEqual([...agentBuiltinTools,'current_mcp'].sort());
    expect(resumed).toEqual(fresh);
  });
  // Pi 1.3 kept a load-time tool the transcript did not declare inactive;
  // Pi 1.4 (upstream #11062) activates it natively.
  it('without the reset, native Pi 1.4 offers a load-time tool the transcript did not declare', async () => {
    const { resumed, fresh } = await resumedAndFresh(dirs(), [...DEFAULTS, 'mcp_A'],
      { atLoad: [{ name: 'mcp_A' }, { name: 'mcp_B' }] }, { reset: false });
    expect(fresh).toContain('mcp_B');
    expect(resumed).toEqual(fresh);
  });

  it('offers a tool this open registers that the resumed transcript did not declare', async () => {
    const { resumed, fresh } = await resumedAndFresh(dirs(), [...DEFAULTS, 'mcp_A'],
      { atLoad: [{ name: 'mcp_A' }, { name: 'mcp_B' }] });
    expect(resumed).toEqual(['bash', 'edit', 'mcp_A', 'mcp_B', 'read', 'write']);
    expect(resumed).toEqual(fresh);
  });

  it('keeps this open\'s excludeTools', async () => {
    const { resumed, fresh } = await resumedAndFresh(dirs(), [...DEFAULTS, 'mcp_A'],
      { atLoad: [{ name: 'mcp_A' }, { name: 'mcp_B' }] }, { excludeTools: ['bash', 'mcp_A'] });
    expect(resumed).toEqual(['edit', 'mcp_B', 'read', 'write']);
    expect(resumed).toEqual(fresh);
  });

  it('uses the configured defaultTools, not the built-in defaults', async () => {
    const { resumed, fresh } = await resumedAndFresh(dirs(['read']), [...DEFAULTS, 'mcp_A'],
      { atLoad: [{ name: 'mcp_A' }] });
    expect(resumed).toEqual(['mcp_A', 'read']);
    expect(resumed).toEqual(fresh);
  });

  it('keeps default-inactive, deferred and codemode extension tools inactive', async () => {
    const { resumed, fresh } = await resumedAndFresh(dirs(), [...DEFAULTS, 'off_tool', 'deferred_tool', 'codemode_tool'],
      { atLoad: [{ name: 'off_tool', defaultActive: false }, { name: 'deferred_tool', exposure: 'deferred' }, { name: 'codemode_tool', exposure: 'codemode' }] });
    expect(resumed).toEqual(['bash', 'edit', 'read', 'write']);
    expect(resumed).toEqual(fresh);
  });

  it('does not activate a transcript tool that registers inactive during session_start', async () => {
    const { resumed, fresh } = await resumedAndFresh(dirs(), [...DEFAULTS, 'late_off', 'late_deferred', 'late_codemode'],
      { atLoad: [], atStart: [{ name: 'late_off', defaultActive: false }, { name: 'late_deferred', exposure: 'deferred' }, { name: 'late_codemode', exposure: 'codemode' }] });
    expect(resumed).toEqual(['bash', 'edit', 'read', 'write']);
    expect(resumed).toEqual(fresh);
  });

  it('drops pending transcript tools when the loadout is empty', async () => {
    const { resumed, fresh } = await resumedAndFresh(dirs([]), ['late_off', 'late_deferred', 'late_codemode'],
      { atLoad: [], atStart: [{ name: 'late_off', defaultActive: false }, { name: 'late_deferred', exposure: 'deferred' }, { name: 'late_codemode', exposure: 'codemode' }] });
    expect(resumed).toEqual([]);
    expect(resumed).toEqual(fresh);
  });

  it('drops pending transcript tools when only deferred or codemode tools are registered', async () => {
    const excludeTools = ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'];
    const { resumed, fresh } = await resumedAndFresh(dirs([]), ['late_off'], {
      atLoad: [{ name: 'deferred_load', exposure: 'deferred' }, { name: 'codemode_load', exposure: 'codemode' }],
      atStart: [{ name: 'late_off', defaultActive: false }],
    }, { excludeTools });
    expect(resumed).toEqual([]);
    expect(resumed).toEqual(fresh);
  });

  it('refuses a resume with no activatable tool instead of keeping pending transcript tools', async () => {
    const paths = dirs();
    const file = previousTranscript(paths, ['late_off']);
    const registrations = { atLoad: [], atStart: [{ name: 'late_off', defaultActive: false }] };
    const excludeTools = ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'];
    await expect(open(paths, SessionManager.open(file, paths.sessionDir), registrations, { excludeTools, reset: true }))
      .rejects.toThrow('cannot drop its restored pending tools');
    // Native Pi 1.3 would otherwise offer the inactive tool; a new open does not.
    expect(await open(paths, SessionManager.open(file, paths.sessionDir), registrations, { excludeTools, reset: false })).toEqual(['late_off']);
    expect(await open(paths, SessionManager.create(paths.cwd, paths.sessionDir), registrations, { excludeTools, reset: true })).toEqual([]);
  });

  it('leaves a new session unchanged', async () => {
    const paths = dirs();
    const registrations = { atLoad: [{ name: 'mcp_A' }], atStart: [{ name: 'late_on' }] };
    const withReset = await open(paths, SessionManager.create(paths.cwd, paths.sessionDir), registrations, { reset: true });
    const without = await open(paths, SessionManager.create(paths.cwd, paths.sessionDir), registrations, { reset: false });
    expect(withReset).toEqual(without);
    expect(withReset).toEqual(['bash', 'edit', 'late_on', 'mcp_A', 'read', 'write']);
  });
});
