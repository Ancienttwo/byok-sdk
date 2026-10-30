import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent } from '@byok-sdk/protocol';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { PI_RPC_IPC_KEY_MARKER } from '../adapters/pi/launcher-credential';
import { testRuntimeEnv } from './fixtures/runtime-env';
import type { Session, MessageDraftDelta } from '../types';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { resolveBunBin } from './support/test-bun-bin';
import { testExecutionScratch } from './fixtures/execution-scratch';
// Relative and test-only: the shipped graph keeps `@byok-sdk/keys` and the dispatch packages disjoint.
import { buildPiProviderProjection } from '../../../keys/src/pi-provider-projection';
import { parseModelProviderProfile } from '../../../keys/src/provider-profile';
import { PI_MODEL_FIXTURE } from '../../../keys/src/fixtures/pi-model-config';

/**
 * #385. The pi-rpc BYOK lane, end to end: the adapter, the real keys launch
 * sequence (`startPiProvider`) and the unmodified built `byok-pi-rpc` host
 * with pinned Pi. The model calls Pi's own built-in bash tool with `env`;
 * neither that output, nor the host's introspectable process environment,
 * nor anything sent to the provider other than the auth header may contain
 * the provider key, while the provider request still authenticates with it.
 */
const BUN_BIN = resolveBunBin();
const CANARY = 'sk-byok-385-rpc-custody-canary';
const clientRoot = path.resolve(import.meta.dirname, '../..');
const roots: string[] = [], servers: Server[] = [], sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function stream(res: ServerResponse, delta: Record<string, unknown>, finish: 'stop' | 'tool_calls'): void {
  const base = { id: 'cmpl-385', object: 'chat.completion.chunk', created: 0, model: 'probe' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end([{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }]
    .map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
}

async function build(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise<number | null>(resolve => child.once('close', resolve)); if (code !== 0) throw new Error(output);
}

describe('pi-rpc BYOK key custody (#385)', () => {
  it('pins the host IPC marker to the keys rpc projection', () => {
    const profile = parseModelProviderProfile({ adapter: 'openai_compatible', auth_mode: 'bearer', base_url: 'http://127.0.0.1:9/v1', capabilities: [],
      created_at: '2026-10-13T00:00:00.000Z', updated_at: '2026-10-13T00:00:00.000Z', display_name: 'Probe', enabled: true, kind: 'model',
      model: 'probe', profile_ref: 'probe', provider_kind: 'custom', pi_model: PI_MODEL_FIXTURE });
    const projection = buildPiProviderProjection(profile, 'pi-rpc') as { providers: Record<string, { apiKey: string }> };
    expect(projection.providers['byok-sdk-probe']!.apiKey).toBe(PI_RPC_IPC_KEY_MARKER);
  });

  type Respond = (res: ServerResponse, ordinal: number) => void;

  /** One BYOK pi-rpc operation through the adapter, the real keys launch sequence and the built host. */
  async function runLane(instruction: string, respond: Respond, prepareHome?: (home: string) => Promise<void>) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-385-'))); roots.push(root);
    const control = path.join(root, 'control'), home = path.join(root, 'home'); await fs.mkdir(control); await fs.mkdir(home);
    await prepareHome?.(home);
    const launcherRoot = path.join(root, 'launcher'); await fs.mkdir(launcherRoot);
    const launcher = path.join(launcherRoot, 'launcher.mjs');
    // Self-contained: zod and @byok-sdk/core are bundled, so the launcher
    // resolves nothing from a node_modules tree outside the repo (no symlink,
    // which does not resolve the same way on Windows). Only node: builtins stay external.
    await build(BUN_BIN!, ['build', path.resolve(import.meta.dirname, 'fixtures/pi-rpc-custody-launcher.ts'), '--target=node', '--outfile', launcher]);

    const received: Array<{ authorization: unknown; body: string }> = [];
    const hostEnvironments: string[] = [];
    const hostPid = (): number => JSON.parse(readFileSync(path.join(control, 'launches.jsonl'), 'utf8').trim().split('\n')[0]!).hostPid as number;
    const server = createServer((req, res) => {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        received.push({ authorization: req.headers.authorization, body });
        // The host is alive while it waits on this response: read the
        // environment any same-user process can introspect. Windows has no
        // such reader without native code; there the spawn env recorded in
        // launches.jsonl is the host's initial block, and Pi's own `env` tool
        // output below is the block the host hands on at runtime.
        if (process.platform !== 'win32') {
          hostEnvironments.push(process.platform === 'darwin'
            ? execFileSync('ps', ['eww', '-p', String(hostPid())], { encoding: 'utf8' })
            : readFileSync(`/proc/${hostPid()}/environ`, 'utf8'));
        }
        respond(res, received.length);
      });
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no provider port');
    const profileDbPath = path.join(root, 'profile.json');
    await fs.writeFile(profileDbPath, JSON.stringify({ controlDir: control, secret: CANARY, profile: {
      adapter: 'openai_compatible', auth_mode: 'bearer', base_url: `http://127.0.0.1:${address.port}/v1`, capabilities: [],
      created_at: '2026-10-13T00:00:00.000Z', updated_at: '2026-10-13T00:00:00.000Z', display_name: 'Probe', enabled: true, kind: 'model',
      model: 'probe', profile_ref: 'probe', provider_kind: 'custom', pi_model: { ...PI_MODEL_FIXTURE, reasoning: false, thinkingLevel: 'off' } } }));

    const sessionDir = path.join(root, 'sessions');
    const scratch = await testExecutionScratch();
    const adapter = new PiAdapter({ byokLauncher: { command: process.execPath, args: [launcher], profileDbPath, sessionDir } });
    const session = await startPreparedOperation(adapter, {
      instruction,
      dispatchSelection: { lane: 'byok', runtimeId: 'pi', providerId: 'probe', modelId: 'probe' },
    }, { workspaceDir: home, scratch, env: testRuntimeEnv() });
    sessions.push(session);
    const events: Array<AgentEvent | MessageDraftDelta> = [];
    for await (const event of session.events) { events.push(event); if (event.type === 'turn_end' || event.type === 'error') break; }
    const launches = readFileSync(path.join(control, 'launches.jsonl'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { args: string[]; env: Record<string, string>; stdio: unknown });
    return { events, received, hostEnvironments, launches, session, sessionDir, home, scratch };
  }

  const toolCall = (name: string, args: Record<string, unknown>): Respond => (res, ordinal) => {
    if (ordinal === 1) stream(res, { role: 'assistant', tool_calls: [{ index: 0, id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
    else stream(res, { role: 'assistant', content: 'done' }, 'stop');
  };

  it.skipIf(BUN_BIN === undefined).each(['default', 'project settings'])('keeps the exact native sessionRef in sessionDir after RPC scratch disposal with %s (#517)', async (settings) => {
    const instruction = 'Keep this transcript after scratch cleanup.';
    const lane = await runLane(instruction, (res) => stream(res, { role: 'assistant', content: 'done' }, 'stop'), async (home) => {
      if (settings === 'project settings') {
        await fs.mkdir(path.join(home, '.pi'));
        await fs.writeFile(path.join(home, '.pi', 'settings.json'), JSON.stringify({ sessionDir: path.join(home, 'settings-session-decoy') }));
      }
    });
    expect(lane.events.filter(event => event.type === 'error')).toEqual([]);
    expect(lane.events.at(-1)?.type).toBe('turn_end');
    expect(lane.received.map(request => request.authorization)).toEqual([`Bearer ${CANARY}`]);
    expect(lane.launches).toHaveLength(1);
    const projection = lane.launches[0]!.env.PI_CODING_AGENT_DIR!;
    expect(path.dirname(projection)).toBe(lane.scratch.sdkDir);
    expect(await fs.readFile(path.join(projection, 'models.json'), 'utf8')).toContain(PI_RPC_IPC_KEY_MARKER);
    const projectedFiles = await fs.readdir(path.join(projection, 'sessions'), { recursive: true })
      .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    const projectedTranscripts = projectedFiles.filter(file => file.endsWith(`_${lane.session.sessionRef}.jsonl`))
      .map(file => path.join(projection, 'sessions', file));

    await lane.session.close();
    expect(await fs.access(projection).then(() => true, () => false)).toBe(false);
    expect(await fs.access(lane.scratch.sdkDir).then(() => true, () => false)).toBe(false);
    expect(await fs.access(path.join(lane.home, 'settings-session-decoy')).then(() => true, () => false)).toBe(false);
    const matches = (await SessionManager.list(lane.home, lane.sessionDir))
      .filter(candidate => candidate.id === lane.session.sessionRef);
    expect(matches, `sessionRef=${lane.session.sessionRef}; transcripts under scratch projection before disposal: ${JSON.stringify(projectedTranscripts)}`).toHaveLength(1);
    expect(projectedTranscripts).toEqual([]);
    expect(path.dirname(matches[0]!.path)).toBe(lane.sessionDir);
    const saved = SessionManager.open(matches[0]!.path, lane.sessionDir);
    expect(saved.getSessionId()).toBe(lane.session.sessionRef);
    expect(saved.getCwd()).toBe(lane.home);
    const messages = saved.buildSessionContext().messages;
    expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant']);
    expect(JSON.stringify(messages.find(message => message.role === 'user'))).toContain(instruction);
    expect(JSON.stringify(messages.find(message => message.role === 'assistant'))).toContain('done');
    expect(await fs.readFile(matches[0]!.path, 'utf8')).not.toContain(CANARY);
  }, 60_000);

  // On Windows this runs in the non-administrator release-pack lane: an
  // elevated token's new directories are owned by BUILTIN\Administrators, and
  // the keys launcher refuses such a projection (`pi_projection_owner_mismatch`).
  it.skipIf(BUN_BIN === undefined)('real Pi bash `env` and the host process environment never see the provider key, and the provider still authenticates with it', async () => {
    const { events, received, hostEnvironments, launches } = await runLane('Print the environment.', toolCall('bash', { command: 'env' }));

    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.args[0]).toBe(path.join(clientRoot, 'dist/bin/byok-pi-rpc.js'));
    expect(launches[0]!.stdio).toEqual(['inherit', 'inherit', 'inherit', 'ipc']);
    expect(launches[0]!.env.PI_PROVIDER_API_KEY).toBeUndefined();
    expect(JSON.stringify(launches[0]!.env)).not.toContain(CANARY);

    // The real built-in bash tool ran `env` and its output reached the event stream.
    const result = events.find(event => event.type === 'tool_result');
    expect(result?.type).toBe('tool_result');
    const output = JSON.stringify(result);
    expect(output).toContain('PI_CODING_AGENT_DIR=');
    expect(output).not.toContain(CANARY);
    expect(output).not.toContain('PI_PROVIDER_API_KEY');
    expect(JSON.stringify(events)).not.toContain(CANARY);

    // The host process environment, as `ps eww` / /proc/<pid>/environ show it.
    expect(hostEnvironments).toHaveLength(process.platform === 'win32' ? 0 : 2);
    for (const environment of hostEnvironments) {
      expect(environment).toContain('PI_CODING_AGENT_DIR');
      expect(environment).not.toContain(CANARY);
    }

    // Provider requests still authenticate with the in-memory key, and the key
    // appears nowhere but in that header — in particular not in the tool result
    // the second request carries back to the model.
    expect(received.map(request => request.authorization)).toEqual([`Bearer ${CANARY}`, `Bearer ${CANARY}`]);
    expect(received[1]!.body).toContain('PI_CODING_AGENT_DIR=');
    for (const request of received) {
      expect(request.body).not.toContain(CANARY);
      expect(request.body).not.toContain(PI_RPC_IPC_KEY_MARKER);
    }
  }, 60_000);

  // A pi-subagents child session opens its own model runtime and would read the
  // projection marker, not the in-memory key, so the lane never loads subagents.
  it.skipIf(BUN_BIN === undefined)('the lane offers no subagent tool and never sends the IPC marker as a key', async () => {
    const { events, received } = await runLane('Delegate a task.', toolCall('subagent', { agent: 'probe-worker', task: 'Reply with OK.', async: false }), async (home) => {
      await fs.mkdir(path.join(home, '.agents'));
      await fs.writeFile(path.join(home, '.agents', 'probe-worker.md'), '---\nname: probe-worker\ndescription: Custody probe worker.\n---\n\nReply with OK.\n');
    });

    expect(events.filter(event => event.type === 'error')).toEqual([]);
    const offered = (JSON.parse(received[0]!.body) as { tools?: { function?: { name?: string } }[] }).tools?.map(tool => tool.function?.name) ?? [];
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).not.toContain('subagent');
    const result = events.find(event => event.type === 'tool_result');
    expect(JSON.stringify(result)).toMatch(/subagent/);
    // Only the parent's two turns reached the provider, both with the real key.
    expect(received.map(request => request.authorization)).toEqual([`Bearer ${CANARY}`, `Bearer ${CANARY}`]);
    for (const request of received) {
      expect(JSON.stringify(request)).not.toContain(PI_RPC_IPC_KEY_MARKER);
      expect(request.body).not.toContain(CANARY);
    }
  }, 90_000);
});
