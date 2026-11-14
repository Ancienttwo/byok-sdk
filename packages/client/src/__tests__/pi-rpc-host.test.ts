import { AgentSession, VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import { serializePiHostConfig } from '../adapters/pi/runtime-host-binding';
import { PiRpcClient } from '../adapters/pi/rpc-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync, statSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { startLoopbackProvider } from './runtime-contract/loopback';
import { refusePiSubagentHostCommands } from '../adapters/pi/subagents';
import { resolveFileScopeGrant } from '../file-scope-guard';
import { serializeFileScopeGrant } from '../file-scope-launch';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createAutoToolAuthorizationGate } from '../tool-authorization';
import { startToolAuthorizationIpc } from '../tool-authorization-ipc';
// Relative and test-only: the release graph keeps `@byok-sdk/keys` and the dispatch packages disjoint.
import { PI_THINKING_LEVELS } from '../../../keys/src/pi-model-config';
import { assertPiLaunchArgs, buildPiProviderArgs } from '../../../keys/src/pi-provider-projection';
import { parseModelProviderProfile } from '../../../keys/src/provider-profile';

const clientRoot = resolve(import.meta.dirname, '../..');
// Private parser/session exports are not public API. Compile their test entry
// with the ordinary host's build-time define.
const hostScratch = mkdtempSync(join(clientRoot, 'node_modules/.byok-rpc-host-test-'));
const host = join(hostScratch, 'host.mjs');

const bun = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['bun'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0]!;
beforeAll(() => {
  const driver = join(hostScratch, 'build.ts');
  const entry = `export {parsePiRpcHostArgs,parsePiRpcHostConfig,openPiRpcSession,createPiHostReady,parsePiHostReadyEvent} from ${JSON.stringify(resolve(import.meta.dirname, '../bin/pi-rpc-host.ts'))};`;
  writeFileSync(driver, `
    import {createRequire} from 'node:module';
    const require = createRequire(createRequire(import.meta.url).resolve('tsup'));
    await require('esbuild').build({
      stdin:{contents:${JSON.stringify(entry)},resolveDir:${JSON.stringify(clientRoot)},loader:'ts'},
      outfile:${JSON.stringify(host)},bundle:true,packages:'external',platform:'node',format:'esm',target:'es2022',
    });
  `);
  const result = spawnSync(bun, ['--no-install', driver], { cwd: clientRoot, encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
});
afterAll(() => rmSync(hostScratch, { recursive: true, force: true }));
const roots: string[] = [];
// pi-subagents runs `npm root -g` at session start for global agent discovery;
// after a host is killed that npm child can still write its log under HOME.
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-rpc-host-')));
  roots.push(root);
  const cwd = join(root, 'session workspace');
  const sealed = join(root, 'sealed');
  mkdirSync(cwd); mkdirSync(sealed);
  const entry = join(root, 'host-entry.ts');
  writeFileSync(entry, `import {runPiRpcHost} from ${JSON.stringify(resolve(import.meta.dirname, '../../dist/bin/pi-runtime-host.js'))}; runPiRpcHost(process.argv.slice(2)).catch(error=>{console.error(String(error));process.exit(1)});`);
  const command = spawnSync(bun, ['--print', 'process.execPath'], {encoding:'utf8'}).stdout.trim();
  const config = { format: 'byok.pi.rpc-launch', version: 11, credentialSource: 'pi-auth-store', cwd,
    agentUserContext: 'inherit', agentHome: null as string | null, agentSkillPaths: [], agentExtensionPaths: [], toolAuthorization: null as unknown,
    fileScope: null, mcp: { mcpEnv: {}, mcpServers: {}, observation: {} } };
  const configPath = join(root, 'config.json');
  const serialized=serializePiHostConfig(config);
  writeFileSync(configPath, serialized.bytes);
  const env = { HOME: root, PATH: process.env.PATH!, PI_CODING_AGENT_DIR: join(root, 'agent'),
    // Deliberately invalid old control authorities must never be consulted.
    BYOK_PI_MCP_CONFIG_PATH: '/does/not/exist', BYOK_PI_PERMISSION_MODE: 'invalid' };
  return { root, cwd, sealed, configPath, config, env, entry, command, digest:serialized.digest };
}
function evaluate(body: string) {
  const result = spawnSync(bun, ['--eval', `import * as host from ${JSON.stringify(host)}; ${body}`], {
    encoding: 'utf8', timeout: 20_000,
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout.trim());
}

describe('SDK ordinary Pi RPC entry', () => {
  it('pins the Pi private command parser and preserves literal extension messages (#1642)', async () => {
    expect(PI_VERSION).toBe('1.5.2');
    const parser = (AgentSession.prototype as unknown as { _throwIfExtensionCommand: unknown })._throwIfExtensionCommand;
    expect(typeof parser).toBe('function');
    const runner = { getCommand: (name: string) => name === 'run' ? { name, invocationName: name, sourceInfo: { path: 'pinned-subagents' } } : undefined };
    const invoke = async (text: string, _options?: { expandPromptTemplates: boolean }) => text;
    const session = { extensionRunner: runner, _throwIfExtensionCommand: parser, prompt: invoke, steer: invoke, followUp: invoke };
    refusePiSubagentHostCommands(session as never, ['pinned-subagents']);
    await expect(session.prompt('/run proof-child task')).rejects.toThrow('pi_host_command_denied: /run');
    await expect(session.prompt('/skill:approved')).resolves.toBe('/skill:approved');
    await expect(session.prompt('/run literal', { expandPromptTemplates: false })).resolves.toBe('/run literal');
  });

  it.each(['absent', 'nonfunction'])('refuses host startup when the private Pi parser is %s (#1642)', (kind) => {
    const f = fixture(), agent = f.env.PI_CODING_AGENT_DIR;
    mkdirSync(agent, { recursive: true });
    writeFileSync(f.entry, `import {runPiSessionRuntime} from ${JSON.stringify(resolve(import.meta.dirname, '../bin/pi-session-runtime.ts'))};
      import {refusePiSubagentHostCommands} from ${JSON.stringify(resolve(import.meta.dirname, '../adapters/pi/subagents.ts'))};
      runPiSessionRuntime({cwd:${JSON.stringify(f.cwd)},provider:'probe',model:'probe',initialModel:'required',label:'parser-drift',
        resourceLoaderOptions:{noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true},
        configureSession:session=>{${kind === 'absent' ? 'Reflect.deleteProperty(Object.getPrototypeOf(session),"_throwIfExtensionCommand");' : 'Object.defineProperty(session,"_throwIfExtensionCommand",{value:null});'}
          refusePiSubagentHostCommands(session,[]);},onSessionReady:()=>console.log('byok_host_ready'),
        reject:message=>{throw new Error(message);}}).catch(error=>{console.error(String(error));process.exit(1);});`);
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { probe: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'synthetic', models: [{ id: 'probe', name: 'probe', contextWindow: 8192, maxTokens: 32, input: ['text'], reasoning: false }] } } }));
    const result = spawnSync(bun, [f.entry], {
      cwd: f.sealed, env: f.env, encoding: 'utf8', timeout: 15_000, input: JSON.stringify({ id: 'state', type: 'get_state' }) + '\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pi_host_command_boundary_unavailable: pinned Pi parser _throwIfExtensionCommand is unavailable');
    expect(result.stdout).not.toContain('byok_host_ready');
    expect(result.stdout).not.toContain('"success":true');
  }, 20_000);

  it.each([
    { label: 'prompt', command: { type: 'prompt' } },
    { label: 'streaming prompt steer', command: { type: 'prompt', streamingBehavior: 'steer' } },
    { label: 'streaming prompt followUp', command: { type: 'prompt', streamingBehavior: 'followUp' } },
    { label: 'steer', command: { type: 'steer' } },
    { label: 'follow_up', command: { type: 'follow_up' } },
  ])('returns one refusal for $label while an agent_settled handler is held (#1642)', async ({ command }) => {
    const f = fixture(), agent = f.env.PI_CODING_AGENT_DIR;
    mkdirSync(agent, { recursive: true });
    const held = join(f.root, 'settlement-held'), release = join(f.root, 'release-settlement'), extension = join(f.root, 'hold.ts');
    writeFileSync(extension, `import {existsSync,writeFileSync} from 'node:fs'; export default pi => {
      let once=false; pi.on('agent_settled',async()=>{if(once)return;once=true;writeFileSync(${JSON.stringify(held)},'held');
        while(!existsSync(${JSON.stringify(release)}))await new Promise(resolve=>setTimeout(resolve,10));});
    };`);
    const serialized = serializePiHostConfig({ ...f.config, agentExtensionPaths: [extension] });
    writeFileSync(f.configPath, serialized.bytes);
    const provider = await startLoopbackProvider('openai-chat', () => ({ kind: 'text', chunks: ['done'] }));
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { probe: { api: 'openai-completions', baseUrl: provider.baseUrl,
      apiKey: 'synthetic', models: [{ id: 'contract-model', name: 'probe', contextWindow: 8192, maxTokens: 32, input: ['text'], reasoning: false }] } } }));
    const frames: { type: string; id?: string }[] = [];
    const client = new PiRpcClient({ command: bun, cwd: f.sealed, env: f.env, onFrame: frame => frames.push(frame),
      args: [f.entry, `--config-digest=${serialized.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 'probe', '--model', 'contract-model'] });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      expect((await client.send({ type: 'prompt', message: 'Reach the settlement barrier.' })).success).toBe(true);
      await expect.poll(() => existsSync(held), { timeout: 5_000 }).toBe(true);
      const result = await Promise.race([client.send({ ...command, id: 'refused-during-settlement', message: '/run proof-child HELD_1642' }),
        new Promise(resolve => { deadline = setTimeout(() => resolve({ type: 'missing-response' }), 1_000); })]);
      expect(result).toMatchObject({ success: false, error: expect.stringContaining('pi_host_command_denied: /run') });
      expect(existsSync(release)).toBe(false);
      expect(provider.requests).toHaveLength(1);
      writeFileSync(release, 'release');
      await expect.poll(() => frames.some(frame => frame.type === 'agent_settled'), { timeout: 5_000 }).toBe(true);
      expect((await client.send({ type: 'get_state' })).data).toMatchObject({ pendingMessageCount: 0 });
      expect(frames.filter(frame => frame.id === 'refused-during-settlement')).toHaveLength(1);
      expect(readdirSync(f.root, { recursive: true }).some(file => String(file).endsWith('status.json'))).toBe(false);
    } finally { clearTimeout(deadline); writeFileSync(release, 'release'); await client.dispose(); await provider.close(); }
  }, 20_000);

  it.each(['prompt', 'steer', 'follow_up'] as const)('refuses child commands at %s while preserving skills, templates and resolved command aliases (#1642)', async (entry) => {
    const f = fixture(), agent = f.env.PI_CODING_AGENT_DIR;
    mkdirSync(join(agent, 'skills/approved'), { recursive: true }); mkdirSync(join(agent, 'prompts'));
    writeFileSync(join(agent, 'skills/approved/SKILL.md'), '---\nname: approved\ndescription: Approved test skill\n---\nRPC_SKILL_BODY_1642');
    writeFileSync(join(agent, 'prompts/approved.md'), 'RPC_TEMPLATE_BODY_1642');
    const marker = join(f.root, 'other-command-ran'), extension = join(f.root, 'other-run.ts');
    writeFileSync(extension, `import {writeFileSync} from 'node:fs'; export default pi => pi.registerCommand('run', {handler:async()=>{writeFileSync(${JSON.stringify(marker)},'other command');}});`);
    const serialized = serializePiHostConfig({ ...f.config, agentExtensionPaths: [extension] });
    writeFileSync(f.configPath, serialized.bytes);
    const provider = await startLoopbackProvider('openai-chat', () => ({ kind: 'text', chunks: ['done'] }));
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { probe: { api: 'openai-completions', baseUrl: provider.baseUrl,
      apiKey: 'synthetic', models: [{ id: 'contract-model', name: 'probe', contextWindow: 8192, maxTokens: 32, input: ['text'], reasoning: false }] } } }));
    let settled = () => {};
    const client = new PiRpcClient({ command: bun, cwd: f.sealed, env: f.env,
      args: [f.entry, `--config-digest=${serialized.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 'probe', '--model', 'contract-model'],
      onFrame: frame => { if (frame.type === 'agent_settled') settled(); } });
    try {
      const commands = (await client.send({ type: 'get_commands' })).data as { commands: { name: string; sourceInfo: { path: string } }[] };
      const own = commands.commands.filter(command => command.sourceInfo.path === '<inline:byok-subagents>');
      const launch = own.find(command => command.name.startsWith('run:'))!;
      expect(own.map(command => command === launch ? 'run' : command.name).sort()).toEqual([
        'run', 'prompt-workflow', 'subagents-refine', 'subagents-check-profile', 'subagents-refresh-provider-models', 'subagents-generate-profiles',
        'subagents', 'subagent-cost', 'subagents-doctor', 'subagents-inspect-rpc', 'subagents-guide', 'subagents-fleet', 'subagents-detach',
        'subagents-stop', 'subagents-steer', 'subagents-models', 'subagents-profiles', 'subagents-load-profile', 'subagents-watchdog',
      ].sort());
      expect(launch).toBeDefined();
      const settings = join(agent, 'settings.json');
      const before = existsSync(settings) ? readFileSync(settings, 'utf8') : undefined;
      for (const name of [launch.name, 'prompt-workflow', 'subagents-refine', 'subagents-check-profile', 'subagents-refresh-provider-models', 'subagents-generate-profiles', 'subagents-watchdog']) {
        const args = name === 'subagents-watchdog' ? ['on', 'session on'] : ['proof-child REFUSED_1642', 'proof-child REFUSED_1642 --bg'];
        for (const arg of args) {
          const denied = await client.send({ type: entry, message: `/${name} ${arg}` });
          expect(denied).toMatchObject({ success: false, error: expect.stringContaining(`pi_host_command_denied: /${name}`) });
        }
      }
      expect(existsSync(settings) ? readFileSync(settings, 'utf8') : undefined).toBe(before);
      expect(provider.requests).toEqual([]);
      expect((await client.send({ type: 'get_state' })).data).toMatchObject({ messageCount: 0, pendingMessageCount: 0 });
      const other = commands.commands.find(command => command.sourceInfo.path === extension)!;
      expect((await client.send({ type: 'prompt', message: `/${other.name}` })).success).toBe(true);
      expect(existsSync(marker)).toBe(true);
      for (const [text, expanded] of [['/skill:approved', 'RPC_SKILL_BODY_1642'], ['/approved', 'RPC_TEMPLATE_BODY_1642']]) {
        const done = new Promise<void>(resolve => { settled = resolve; });
        expect((await client.send({ type: entry, message: text })).success).toBe(true);
        if (entry !== 'prompt') expect((await client.send({ type: 'prompt', message: 'Drain the queued input.' })).success).toBe(true);
        await done;
        expect(provider.requests.some(request => request.text.includes(expanded!))).toBe(true);
      }
      // The factory applies the same boundary after native session replacement.
      expect((await client.send({ type: 'new_session' })).success).toBe(true);
      expect((await client.send({ type: entry, message: `/${launch.name} proof-child REPLACEMENT_1642` })).success).toBe(false);
      expect(readdirSync(f.root, { recursive: true }).some(file => String(file).endsWith('status.json'))).toBe(false);
    } finally { await client.dispose(); await provider.close(); }
  }, 30_000);

  it('sends no cache warming request after the run settled (Pi 1.5.1 defaults cacheWarming to idle)', async () => {
    const f = fixture(), agent = f.env.PI_CODING_AGENT_DIR;
    mkdirSync(agent);
    let requests = 0;
    const server = createServer(async (request, response) => {
      for await (const _ of request);
      requests += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ id: 'warm', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }) + '\n\n' +
        'data: ' + JSON.stringify({ id: 'warm', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1_000_000, completion_tokens: 1, total_tokens: 1_000_001 } }) + '\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing loopback address');
    // A 13 s cache lifetime puts Pi's first refresh 3 s after the request; the
    // prices make an idle refresh pay for itself, so only the mode can stop it.
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { probe: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'synthetic', models: [{ id: 'probe', name: 'probe', contextWindow: 2_000_000, maxTokens: 32, input: ['text'], reasoning: false,
        cost: { input: 100, output: 1, cacheRead: 1, cacheWrite: 0 }, promptCache: { short: 13 } }] } } }));
    let settled = () => {};
    const done = new Promise<void>(resolve => { settled = resolve; });
    const client = new PiRpcClient({ command: bun, cwd: f.sealed, env: f.env,
      args: [f.entry, `--config-digest=${f.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 'probe', '--model', 'probe'],
      onFrame: frame => { if (frame.type === 'agent_settled') settled(); } });
    try {
      expect((await client.send({ type: 'prompt', message: 'hello' })).success).toBe(true);
      await done;
      await new Promise(resolve => setTimeout(resolve, 4_500));
      expect(requests).toBe(1);
    } finally {
      await client.dispose();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 30_000);

  it.each(['default', 'idle', 'streaming', 'off', 'excluded'] as const)('cancels a cache-warming decision held across settlement with mode %s (#1949)', async (mode) => {
    const f = fixture(), agent = f.env.PI_CODING_AGENT_DIR;
    mkdirSync(agent);
    const settings = join(agent, 'settings.json'), before = JSON.stringify(mode === 'default' ? {} : { cacheWarming: mode === 'excluded' ? 'off' : mode });
    writeFileSync(settings, before);
    const runHeld = join(f.root, 'run-held'), releaseRun = join(f.root, 'release-run');
    const decisionHeld = join(f.root, 'decision-held'), releaseDecision = join(f.root, 'release-decision'), decisionFinished = join(f.root, 'decision-finished');
    writeFileSync(f.entry, `import {existsSync,writeFileSync} from 'node:fs';
      import {runPiSessionRuntime} from ${JSON.stringify(resolve(import.meta.dirname, '../bin/pi-session-runtime.ts'))};
      const wait=async path=>{while(!existsSync(path))await new Promise(resolve=>setTimeout(resolve,10));};
      let session;
      runPiSessionRuntime({cwd:${JSON.stringify(f.cwd)},credentialSource:'pi-auth-store',provider:'probe',model:'probe',initialModel:'required',label:'warming-race',
        configureSession:value=>{session=value;},
        ${mode === 'excluded' ? `resourceAgentDir:${JSON.stringify(join(f.root, 'resources'))},` : ''}
        resourceLoaderOptions:{noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,
          extensionFactories:[pi=>{
            pi.on('agent_before_settle',async()=>{writeFileSync(${JSON.stringify(runHeld)},'held');await wait(${JSON.stringify(releaseRun)});});
            pi.on('cache_warming_decision',async(_event,ctx)=>{
              writeFileSync(${JSON.stringify(decisionHeld)},JSON.stringify({idle:ctx.isIdle()}));
              await wait(${JSON.stringify(releaseDecision)});
              let observing=false;
              return {get action(){
                // The runner consumes action after awaiting this handler. Its microtasks finish before setImmediate.
                if(!observing){observing=true;setImmediate(async()=>{
                  while(session.cacheWarmingStatus?.state==='refreshing')await new Promise(resolve=>setTimeout(resolve,10));
                  writeFileSync(${JSON.stringify(decisionFinished)},JSON.stringify(session.cacheWarmingStatus));
                });}
                return 'warm';
              }};});
          }],
          // Put the SDK's old idle hook before the held decision, exposing its stale active answer.
          extensionsOverride:base=>({...base,extensions:[...base.extensions].reverse()})},
        reject:message=>{throw new Error(message);}}).catch(error=>{console.error(String(error));process.exit(1);});`);
    const provider = await startLoopbackProvider('openai-chat', () => ({ kind: 'text', chunks: ['done'] }));
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { probe: { api: 'openai-completions', baseUrl: provider.baseUrl,
      apiKey: 'synthetic', models: [{ id: 'probe', name: 'probe', contextWindow: 8192, maxTokens: 32, input: ['text'], reasoning: false, promptCache: { short: 13 } }] } } }));
    let settled = false;
    const client = new PiRpcClient({ command: bun, cwd: f.sealed, env: f.env, args: [f.entry],
      onFrame: frame => { if (frame.type === 'agent_settled') settled = true; } });
    try {
      expect((await client.send({ type: 'prompt', message: 'Hold the run across the cache-warming decision.' })).success).toBe(true);
      await expect.poll(() => existsSync(runHeld), { timeout: 5_000 }).toBe(true);
      if (mode !== 'off') {
        await expect.poll(() => existsSync(decisionHeld), { timeout: 6_000 }).toBe(true);
        expect(JSON.parse(readFileSync(decisionHeld, 'utf8'))).toEqual({ idle: false });
      }
      writeFileSync(releaseRun, 'release');
      await expect.poll(() => settled, { timeout: 5_000 }).toBe(true);
      writeFileSync(releaseDecision, 'release');
      if (mode !== 'off') await expect.poll(() => existsSync(decisionFinished), { timeout: 5_000 }).toBe(true);
      expect(provider.requests).toHaveLength(1);
      if (mode !== 'off') expect(JSON.parse(readFileSync(decisionFinished, 'utf8'))).toMatchObject({ state: 'inactive', reason: 'agent run settled' });
      expect(existsSync(decisionHeld)).toBe(mode !== 'off');
      expect(readFileSync(settings, 'utf8')).toBe(before);
    } finally {
      writeFileSync(releaseRun, 'release'); writeFileSync(releaseDecision, 'release');
      await client.dispose(); await provider.close();
    }
  }, 20_000);

  it('classifies every slash command registered by pinned pi-subagents, including child-process probes (#1642)', async () => {
    const inventory = {
      run: 'refused: native child', 'prompt-workflow': 'refused: workflow children', 'subagents-refine': 'refused: proposal child',
      'subagents-check-profile': 'refused: Pi probe process', 'subagents-refresh-provider-models': 'refused: Pi probe processes',
      'subagents-generate-profiles': 'refused: refresh can spawn Pi probes', 'subagents-watchdog': 'refused: workspace LSP process and reviewer tools',
      subagents: 'allowed: metadata administration', 'subagent-cost': 'allowed: cost report', 'subagents-doctor': 'allowed: diagnostics',
      'subagents-inspect-rpc': 'allowed: inspect existing child', 'subagents-guide': 'allowed: packaged guide',
      'subagents-fleet': 'allowed: inspect existing fleet', 'subagents-detach': 'allowed: detach existing child',
      'subagents-stop': 'allowed: stop existing child', 'subagents-steer': 'allowed: existing child, steeringRecovery=false',
      'subagents-models': 'allowed: mappings', 'subagents-profiles': 'allowed: list profiles', 'subagents-load-profile': 'allowed: settings only',
      'pi-subagents-bridge': 'allowed: separate pane bridge, no child launch',
    };
    const pkg = resolve(dirname(createRequire(import.meta.url).resolve('pi-subagents')), '..'), src = join(pkg, 'src');
    const registered = readdirSync(src, { recursive: true }).filter(file => String(file).endsWith('.js'))
      .flatMap(file => [...readFileSync(join(src, String(file)), 'utf8').matchAll(/pi\s*\.\s*registerCommand\s*\(\s*(['"])([^'"]+)\1/gu)].map(match => match[2]));
    expect(registered.sort()).toEqual(Object.keys(inventory).sort());
    const commands = Object.keys(inventory).map(name => ({ name, invocationName: name, sourceInfo: { path: 'pinned-subagents' } }));
    for (const entry of ['prompt', 'steer', 'followUp'] as const) {
      const runner = { getCommand: (name: string) => commands.find(command => command.name === name) };
      const invoke = async (name: string) => runner.getCommand(name)?.name;
      const session = { extensionRunner: runner,
        _throwIfExtensionCommand: (AgentSession.prototype as unknown as { _throwIfExtensionCommand: unknown })._throwIfExtensionCommand,
        prompt: invoke, steer: invoke, followUp: invoke };
      refusePiSubagentHostCommands(session as never, ['pinned-subagents']);
      const allowed: string[] = [], refused: string[] = [];
      for (const { name } of commands) {
        try { expect(await session[entry](name)).toBe(name); allowed.push(name); }
        catch (error) { expect(String(error)).toContain(`pi_host_command_denied: /${name}`); refused.push(name); }
      }
      expect(allowed.sort()).toEqual(Object.entries(inventory).filter(([, reason]) => reason.startsWith('allowed:')).map(([name]) => name).sort());
      expect(refused.sort()).toEqual(Object.entries(inventory).filter(([, reason]) => reason.startsWith('refused:')).map(([name]) => name).sort());
    }
  });
  it.skipIf(process.platform === 'win32')('emits one session readiness receipt from the memory RPC host before accepting commands', async () => {
    const f = fixture();
    const grant = await resolveFileScopeGrant({ fileScope: { mode: 'memory' }, home: { path: f.cwd, identity: statSync(f.cwd, { bigint: true }) }, attempt: { homeAccess: 'writer' } });
    const serialized = serializePiHostConfig({ ...f.config, agentUserContext: 'excluded', agentHome: f.cwd, fileScope: serializeFileScopeGrant(grant) });
    writeFileSync(f.configPath, serialized.bytes);
    mkdirSync(f.env.PI_CODING_AGENT_DIR);
    writeFileSync(join(f.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { probe: {
      baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'synthetic-not-a-secret',
      models: [{ id: 'probe', name: 'probe', contextWindow: 4096, maxTokens: 32, input: ['text'], reasoning: false }],
    } } }));
    const frames: { type: string }[] = [];
    const client = new PiRpcClient({ command: bun, cwd: f.sealed, env: f.env, onFrame: frame => frames.push(frame),
      args: [f.entry, `--config-digest=${serialized.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 'probe', '--model', 'probe'] });
    try {
      const state = await client.send({ type: 'get_state' });
      expect(state.success).toBe(true);
      expect(frames[0]).toEqual({ type: 'byok_host_ready', sessionId: (state.data as { sessionId: string }).sessionId });
      expect((state.data as { sessionFile?: string }).sessionFile).toBeUndefined();
      expect((await client.send({ type: 'bash', command: 'echo escape' })).success).toBe(false);
      expect((await client.send({ type: 'new_session' })).success).toBe(false);
      expect((await client.send({ type: 'abort' })).success).toBe(true);
      expect((await client.send({ type: 'prompt', message: 'late' })).success).toBe(false);
      expect(frames.filter(frame => frame.type === 'byok_host_ready')).toHaveLength(1);
    } finally { await client.dispose(); }
    expect(readdirSync(f.root, { recursive: true }).filter(file => String(file).endsWith('.jsonl'))).toEqual([]);
  }, 20_000);
  it('refuses a scoped loadout changed during session_start before readiness or commands', async () => {
    const f = fixture();
    const grant = await resolveFileScopeGrant({ fileScope: { mode: 'home' }, home: { path: f.cwd, identity: statSync(f.cwd, { bigint: true }) }, attempt: { homeAccess: 'writer' } });
    const extension = join(f.root, 'remove-read.ts');
    writeFileSync(extension, `export default pi => { pi.on('session_start', () => pi.setActiveTools(pi.getActiveTools().filter(name=>name!=='read'))); };`);
    const serialized = serializePiHostConfig({ ...f.config, fileScope: serializeFileScopeGrant(grant), agentExtensionPaths: [extension],
      toolAuthorization: { url: 'http://127.0.0.1:1/authorize-tool', token: 'a'.repeat(64), timeoutMs: 1000 } });
    writeFileSync(f.configPath, serialized.bytes);
    const result = spawnSync(bun, [f.entry, `--config-digest=${serialized.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 'anthropic', '--model', 'claude-sonnet-4-5'], {
      cwd: f.sealed, env: f.env, encoding: 'utf8', timeout: 15_000, input: JSON.stringify({ id: 'state', type: 'get_state' }) + '\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('file_scope_registry_drift');
    expect(result.stdout).not.toContain('byok_host_ready');
    expect(result.stdout).not.toContain('"success":true');
  }, 20_000);
  it('accepts only an isolated memory host with no approvals or resource grants', () => {
    const f = fixture();
    expect(evaluate(`
      const base = ${JSON.stringify(f.config)};
      const memory = {...base, agentUserContext:'excluded', agentHome:base.cwd,
        fileScope:{mode:'memory',home:{id:'home',path:base.cwd,lexicalPath:base.cwd,access:'write',dev:'1',ino:'2'},roots:[],digest:'a'.repeat(64)}};
      const accepted = host.parsePiRpcHostConfig(memory).fileScope.mode;
      const rejected = [{...memory,agentUserContext:'inherit',agentHome:null}, {...memory,agentSkillPaths:['/skill']},
        {...memory,agentExtensionPaths:['/extension']}, {...memory,cwd:'/elsewhere'},
        {...memory,toolAuthorization:{url:'http://127.0.0.1:1/authorize-tool',token:'a'.repeat(64),timeoutMs:1000}}]
        .map(value=>{try{host.parsePiRpcHostConfig(value);return false;}catch{return true;}});
      console.log(JSON.stringify({accepted,rejected}));
    `)).toEqual({ accepted: 'memory', rejected: [true, true, true, true, true] });
  });
  it('strictly rejects alternate CLI/config authorities', () => {
    const f = fixture();
    const result = evaluate(`
      const base = ${JSON.stringify(f.config)};
      const rejected = [];
      for (const argv of [[], ['--config','relative','--mode','rpc'], ['--config','/x','--mode','rpc','--extension','/x'], ['--config','/x','--mode','rpc','--config','/y'], ['--config','/x','--mode','rpc','--thinking','bogus']]) {
        try { host.parsePiRpcHostArgs(['--config-digest='+'a'.repeat(64),...argv]); rejected.push(false); } catch { rejected.push(true); }
      }
      const {credentialSource:_, ...withoutSource} = base;
      for (const cfg of [{...base, version:1}, {...base, version:3}, {...base, cwd:'relative'}, {...base, extra:true}, {...base, policy:{mode:'auto'}}, {...base, binding:{}}, {...base, descendantPlan:null},
        {...base, version:4}, {...base, version:8}, {...base, version:9}, withoutSource, {...base, credentialSource:'env'},
        {...base, agentHome:'/home'}, {...base, agentUserContext:'excluded'}, {...base, agentUserContext:'excluded', agentHome:'relative'}]) {
        try { host.parsePiRpcHostConfig(cfg); rejected.push(false); } catch { rejected.push(true); }
      }
      console.log(JSON.stringify(rejected));
    `);
    expect(result).toEqual(Array(20).fill(true));
  });

  it('rejects v6, legacy tool policy and non-loopback gates instead of accepting an ungated launch', () => {
    const f = fixture();
    expect(evaluate(`
      const base = ${JSON.stringify(f.config)};
      const gate = {url:'http://127.0.0.1:1/authorize-tool',token:'a'.repeat(64),timeoutMs:1000};
      console.log(JSON.stringify([
        {...base, version:6}, {...base, version:7}, {...base, version:8}, {...base, agentUserContext:undefined}, {...base, agentUserContext:'best-effort'},
        {...base, agentToolPolicy:{builtinTools:'inherit',userContext:'inherit',extensions:'inherit'}},
        {...base, toolAuthorization:undefined}, {...base, toolAuthorization:{mode:'full access'}},
        {...base, toolAuthorization:{...gate,url:'http://example.com:1/authorize-tool'}},
        {...base, toolAuthorization:{...gate,token:'short'}},
      ].map(value=>{try {host.parsePiRpcHostConfig(value);return false;}catch{return true;}})));
    `)).toEqual(Array(10).fill(true));
  });

  it('accepts a v10 serialized file scope and rejects a malformed one', () => {
    const f = fixture();
    const home = f.cwd;
    const grant = {
      mode: 'home' as const,
      home: { id: 'home', path: home, lexicalPath: home, access: 'write' as const, dev: '1', ino: '2' },
      roots: [] as const,
      digest: 'a'.repeat(64),
    };
    const result = evaluate(`
      const base = ${JSON.stringify(f.config)};
      const good = ${JSON.stringify(grant)};
      const parsed = host.parsePiRpcHostConfig({...base, fileScope: good});
      const rejected = [{...good, extra:true}, {...good, digest:'short'}, {...good, home:{...good.home, path:'relative'}},
        {...good, mode:'workspaces'}].map(value => { try { host.parsePiRpcHostConfig({...base, fileScope:value}); return false; } catch { return true; } });
      console.log(JSON.stringify({digest: parsed.fileScope.digest, rejected}));
    `);
    expect(result).toEqual({ digest: grant.digest, rejected: [true, true, true, true] });
  });

  it('auto: denies a high-risk call before execution and runs an ordinary one, through the real Pi tool pipeline', async () => {
    const f = fixture();
    const victim = join(f.root, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'keep');
    const allowed = join(f.cwd, 'allowed.txt');
    const agentDir = join(f.root, 'agent');
    mkdirSync(agentDir, { recursive: true });
    const summaries: string[] = [];
    const ipc = await startToolAuthorizationIpc(createAutoToolAuthorizationGate({
      workspace: f.cwd, timeoutMs: 5_000,
      requestAuthorization: async (summary) => { summaries.push(summary); return { approved: false, reason: 'user rejected' }; },
    }));
    let received!: (body: { tools?: { function: { name: string } }[] }) => void;
    const requestBody = new Promise<{ tools?: { function: { name: string } }[] }>(done => { received = done; });
    let receivedToolResult!: (body: { messages?: unknown[] }) => void;
    const toolResultBody = new Promise<{ messages?: unknown[] }>(done => { receivedToolResult = done; });
    let requestCount = 0;
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      requestCount += 1;
      if (requestCount === 1) received(parsed);
      else receivedToolResult(parsed);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (requestCount === 1) {
        const call = (index: number, id: string, command: string) => ({ index, id, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } });
        response.end('data: ' + JSON.stringify({ id:'loopback-call', object:'chat.completion.chunk', choices:[{index:0,delta:{role:'assistant',tool_calls:[
          call(0, 'high-risk', `rm -rf '${victim}'`), call(1, 'ordinary', `touch '${allowed}'`),
        ]},finish_reason:null}] }) + '\n\n' +
          'data: ' + JSON.stringify({ id:'loopback-call', object:'chat.completion.chunk', choices:[{index:0,delta:{},finish_reason:'tool_calls'}] }) + '\n\ndata: [DONE]\n\n');
        return;
      }
      response.end('data: ' + JSON.stringify({ id:'loopback', object:'chat.completion.chunk', choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:null}] }) + '\n\n' +
        'data: ' + JSON.stringify({ id:'loopback', object:'chat.completion.chunk', choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2} }) + '\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing loopback address');
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'auto-loopback': {
      baseUrl:`http://127.0.0.1:${address.port}/v1`, api:'openai-completions', apiKey:'synthetic-not-a-secret',
      models:[{id:'probe',name:'probe',contextWindow:4096,maxTokens:32,input:['text'],reasoning:false}],
    } } }));
    const config = { ...f.config, agentUserContext: 'excluded', agentHome: f.cwd, toolAuthorization: ipc.config };
    const serialized = serializePiHostConfig(config);
    writeFileSync(f.configPath, serialized.bytes);
    const client = new PiRpcClient({
      command:bun, cwd:f.sealed, env:f.env,
      args:[f.entry, `--config-digest=${serialized.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 'auto-loopback', '--model', 'probe'],
    });
    try {
      expect((await client.send({type:'prompt',message:'clean up'})).success).toBe(true);
      // `auto` keeps a capable Local Agent: shell and file tools stay offered.
      expect((await requestBody).tools?.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write']));
      const continuation = JSON.stringify((await toolResultBody).messages);
      expect(continuation).toContain('tool_authorization_denied: user rejected');
      expect(existsSync(join(victim, 'keep.txt'))).toBe(true);
      expect(existsSync(allowed)).toBe(true);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain('recursive-delete');
    } finally {
      await client.dispose();
      await ipc.close();
      await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
    }
  }, 30_000);

  it('refuses startup when an explicitly authorized skill is missing', () => {
    const f = fixture();
    const config = {...f.config,agentUserContext:'excluded',agentHome:f.cwd,agentSkillPaths:[join(f.root,'missing','SKILL.md')]};
    const serialized = serializePiHostConfig(config);
    writeFileSync(f.configPath, serialized.bytes);
    const result = spawnSync(bun, [f.entry,`--config-digest=${serialized.digest}`,'--config',f.configPath,'--mode','rpc','--provider','anthropic','--model','claude-sonnet-4-5'], {
      cwd:f.sealed,env:f.env,encoding:'utf8',timeout:8_000,
      input:JSON.stringify({id:'state',type:'get_state'})+'\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENOENT');
    expect(result.stdout).not.toContain('"success":true');
  }, 15_000);

  it('runs an explicitly authorized skill and extension while excluding user context, ancestor instruction files and resources', async () => {
    const f = fixture();
    const agentDir = join(f.root, 'agent');
    const skills = join(agentDir, 'skills');
    const extensions = join(agentDir, 'extensions');
    mkdirSync(join(skills, 'approved'), { recursive: true });
    mkdirSync(join(skills, 'unselected'), { recursive: true });
    mkdirSync(extensions, { recursive: true });
    const skillPath = join(skills, 'approved', 'SKILL.md');
    const extensionPath = join(extensions, 'approved.ts');
    const marker = join(f.root, 'authorized-tool-ran');
    writeFileSync(skillPath, '---\nname: approved\ndescription: Authorized task skill.\n---\nAUTHORIZED_SKILL_BODY: call authorized_probe.\n');
    writeFileSync(join(skills, 'unselected', 'SKILL.md'), '---\nname: unselected\ndescription: UNSELECTED_SKILL\n---\nDo not load.\n');
    writeFileSync(join(agentDir, 'AGENTS.md'), 'FORBIDDEN_GLOBAL_CONTEXT');
    // The session cwd is the Agent home: its own instruction file stays, the one above it does not.
    writeFileSync(join(f.cwd, 'AGENTS.md'), 'AGENT_HOME_CONTEXT');
    writeFileSync(join(f.root, 'AGENTS.md'), 'FORBIDDEN_ANCESTOR_CONTEXT');
    writeFileSync(join(extensions, 'unselected.ts'), 'throw new Error("UNSELECTED_EXTENSION_LOADED");');
    writeFileSync(extensionPath, `import {writeFileSync} from 'node:fs'; export default function(pi) {
      pi.registerTool({name:'authorized_probe',label:'Authorized probe',description:'Execute the authorized task.',parameters:{type:'object',properties:{}},
        execute:async()=>{writeFileSync(${JSON.stringify(marker)},'executed');return {content:[{type:'text',text:'AUTHORIZED_TOOL_RESULT'}],details:{}};}});
    }`);
    let first!: (body: any) => void;
    const firstRequest = new Promise<any>(done => { first = done; });
    let second!: (body: any) => void;
    const secondRequest = new Promise<any>(done => { second = done; });
    let count = 0;
    const server = createServer(async (request, response) => {
      let bytes = '';
      for await (const chunk of request) bytes += chunk;
      const body = JSON.parse(bytes);
      const initial = ++count === 1;
      if (initial) first(body); else second(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = initial
        ? {role:'assistant',tool_calls:[{index:0,id:'authorized-call',type:'function',function:{name:'authorized_probe',arguments:'{}'}}]}
        : {role:'assistant',content:'done'};
      response.end('data: ' + JSON.stringify({id:'probe',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]}) + '\n\n' +
        'data: ' + JSON.stringify({id:'probe',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:initial?'tool_calls':'stop'}]}) + '\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing loopback address');
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({providers:{'resource-probe':{
      baseUrl:`http://127.0.0.1:${address.port}/v1`,api:'openai-completions',apiKey:'synthetic',
      models:[{id:'probe',name:'probe',contextWindow:4096,maxTokens:64,input:['text'],reasoning:false}],
    }}}));
    const config = {...f.config,agentUserContext:'excluded',agentHome:f.cwd,agentSkillPaths:[skillPath],agentExtensionPaths:[extensionPath]};
    const serialized = serializePiHostConfig(config);
    writeFileSync(f.configPath, serialized.bytes);
    const client = new PiRpcClient({command:bun,cwd:f.sealed,env:f.env,
      args:[f.entry,`--config-digest=${serialized.digest}`,'--config',f.configPath,'--mode','rpc','--provider','resource-probe','--model','probe']});
    try {
      const commands = await client.send({type:'get_commands'});
      expect(commands.success).toBe(true);
      const names = (commands.data as {commands:{name:string}[]}).commands.map(command=>command.name);
      expect(names).toContain('skill:approved');
      expect(names).not.toContain('skill:unselected');
      expect((await client.send({type:'prompt',message:'/skill:approved'})).success).toBe(true);
      const body = await firstRequest;
      expect(body.tools.map((tool: {function:{name:string}})=>tool.function.name)).toEqual(expect.arrayContaining(['read','bash','edit','write','authorized_probe']));
      expect(JSON.stringify(body.messages)).toContain('AUTHORIZED_SKILL_BODY');
      expect(JSON.stringify(body.messages)).not.toContain('FORBIDDEN_GLOBAL_CONTEXT');
      expect(JSON.stringify(body.messages)).toContain('AGENT_HOME_CONTEXT');
      expect(JSON.stringify(body.messages)).not.toContain('FORBIDDEN_ANCESTOR_CONTEXT');
      expect(JSON.stringify(body.messages)).not.toContain('UNSELECTED_SKILL');
      expect(JSON.stringify((await secondRequest).messages)).toContain('AUTHORIZED_TOOL_RESULT');
      expect(existsSync(marker)).toBe(true);
    } finally {
      await client.dispose();
      await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
    }
  }, 30_000);

  // #636: a Host validates a keys profile with `assertPiLaunchArgs` when it
  // saves it. That verdict must be the rpc host parser's verdict on the
  // `--provider`/`--model`/`--thinking` values the launcher appends.
  it('accepts exactly the launch values keys accepts', () => {
    const everyLevel = Object.fromEntries(PI_THINKING_LEVELS.map((level) => [level, level === 'off' ? 'none' : level]));
    const cases = ['glm-5.3', 'org/model:tag', '-x', '--tools', '--'].flatMap((model) =>
      [...PI_THINKING_LEVELS, 'auto', 'MAX', ''].map((thinking) => ({ model, thinking })));
    const keys = cases.map(({ model, thinking }) => {
      try {
        const profile = parseModelProviderProfile({
          adapter: 'openai_compatible', auth_mode: 'none', base_url: 'http://127.0.0.1:9191/v1', capabilities: [],
          created_at: '2026-10-21T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z', display_name: 'Parity',
          enabled: true, kind: 'model', model, profile_ref: 'parity', provider_kind: 'custom',
          pi_model: { contextWindow: 1_000, maxTokens: 100, reasoning: true, thinkingLevel: thinking, thinkingLevelMap: everyLevel, compat: {} },
        });
        assertPiLaunchArgs(profile);
        expect(buildPiProviderArgs(profile, ['--mode', 'rpc'])).toEqual(
          ['--mode', 'rpc', '--provider', 'byok-sdk-parity', '--model', model, '--thinking', thinking]);
        return true;
      } catch { return false; }
    });
    const host = evaluate(`
      const accepted = [];
      for (const { model, thinking } of ${JSON.stringify(cases)}) {
        try {
          host.parsePiRpcHostArgs(['--config-digest='+'a'.repeat(64), '--config', '/x', '--mode', 'rpc',
            '--provider', 'byok-sdk-parity', '--model', model, '--thinking', thinking]);
          accepted.push(true);
        } catch { accepted.push(false); }
      }
      console.log(JSON.stringify(accepted));
    `);
    expect(cases.map((entry, index) => ({ ...entry, accepted: host[index] })))
      .toEqual(cases.map((entry, index) => ({ ...entry, accepted: keys[index] })));
    expect(keys.filter(Boolean)).toHaveLength(3 * PI_THINKING_LEVELS.length);
  });

  // #385: a keys-profile launch takes its provider key only over the
  // launcher's private IPC channel; a device-auth launch has no such channel.
  function custodyFixture(credentialSource: 'keys-profile' | 'pi-auth-store') {
    const f = fixture();
    const config = { ...f.config, credentialSource };
    const serialized = serializePiHostConfig(config);
    writeFileSync(f.configPath, serialized.bytes);
    const agent = join(f.root, 'agent');
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { 'byok-sdk-probe': {
      baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'byok:rpc-ipc', models: [{ id: 'probe' }] } } }));
    const argv = [f.entry, `--config-digest=${serialized.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 'byok-sdk-probe', '--model', 'probe'];
    return { ...f, argv };
  }

  it.each([
    { lane: 'installed', shared: true },
    { lane: 'installed keys-profile', shared: true },
    { lane: 'bundled keys-profile', shared: true },
    { lane: 'installed', shared: false },
    { lane: 'team-operator', shared: true },
    { lane: 'team-operator', shared: false },
  ])('uses only a private jiti cache before loading an extension: $lane, shared=$shared (#2163)', async ({ lane, shared }) => {
    const keys = lane.includes('keys-profile'), bundled = lane.startsWith('bundled');
    const f = custodyFixture(keys ? 'keys-profile' : 'pi-auth-store');
    const marker = join(f.root, 'extension-loaded.json'), extension = join(f.root, 'cache-probe.ts');
    writeFileSync(extension, `import {writeFileSync} from 'node:fs';
      export default function probe(pi): void {
        writeFileSync(${JSON.stringify(marker)},JSON.stringify({cache:process.env.JITI_FS_CACHE}));
        pi.on('session_start',()=>process.exit(0));
      }`);
    const serialized = serializePiHostConfig(lane === 'team-operator'
      ? { format: 'byok.pi.team-operator', version: 1, cwd: f.cwd, sessionDir: join(f.root, 'sessions'), provider: 'byok-sdk-probe',
        model: 'probe', systemPromptPath: join(f.root, 'system.md'), extensionPaths: [extension], mcp: f.config.mcp }
      : { ...f.config, credentialSource: keys ? 'keys-profile' : 'pi-auth-store', agentExtensionPaths: [extension] });
    writeFileSync(f.configPath, serialized.bytes);
    const argv = [...f.argv]; argv[1] = `--config-digest=${serialized.digest}`;
    if (lane === 'team-operator') {
      writeFileSync(join(f.root, 'system.md'), 'Cache policy probe.');
      writeFileSync(f.entry, `import {runPiTeamOperatorHost} from ${JSON.stringify(resolve(clientRoot, 'dist/bin/pi-runtime-host.js'))};
        runPiTeamOperatorHost(process.argv.slice(2)).catch(error=>{console.error(error);process.exit(1)});`);
      argv.splice(4);
    }
    if (bundled) {
      writeFileSync(f.entry, `import {runPiRpcHost} from ${JSON.stringify(resolve(clientRoot, 'dist/bin/pi-runtime-host.js'))};
        runPiRpcHost(process.argv.slice(2),'bundled').catch(error=>{console.error(error);process.exit(1)});`);
      const bundle = join(f.root, 'host.mjs');
      const built = spawnSync(bun, ['build', f.entry, '--target=bun', '--define=PI_BUNDLED_NODE=true', '--outfile', bundle], { cwd: clientRoot, encoding: 'utf8', timeout: 30_000 });
      expect(built.status, built.stderr).toBe(0); argv[0] = bundle;
    }
    const loader = bundled ? argv[0]! : fileURLToPath(new URL('./core/extensions/loader.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
    const adjacent = join(dirname(loader), 'node_modules');
    // This fixture owns this directory in this worktree's dependency copy.
    expect(existsSync(adjacent)).toBe(false);
    if (shared) mkdirSync(adjacent);
    const runtime = join(f.root, 'runtime'); mkdirSync(runtime);
    try {
      const child = spawn(bundled ? bun : process.execPath, argv, { cwd: f.sealed, env: { ...f.env, TMPDIR: runtime, TMP: runtime, TEMP: runtime,
        ...(bundled ? { PI_PACKAGE_DIR: resolve(clientRoot, 'dist/assets') } : {}), PI_CODING_AGENT_SESSION_DIR: join(f.root, 'sessions') },
        stdio: keys ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'], timeout: 20_000 });
      let stderr = '';
      child.stderr!.on('data', data => { stderr += data; }); child.stdout!.resume();
      if (keys) child.once('message', (request: { configDigest: string }) => child.send({
        type: 'byok.pi.rpc.credential', configDigest: request.configDigest, secret: 'synthetic-cache-probe',
      }));
      const code = await new Promise<number | null>(done => child.once('close', done));
      expect(code, stderr).toBe(0);
      expect(existsSync(join(adjacent, '.cache/jiti'))).toBe(false);
      expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(shared ? { cache: 'false' } : {});
      expect(existsSync(join(runtime, 'jiti'))).toBe(!shared);
      if (!shared) expect(readdirSync(join(runtime, 'jiti')).length).toBeGreaterThan(0);
      expect(stderr).not.toContain('pi_jiti_seed_unavailable');
    } finally { if (shared) rmSync(adjacent, { recursive: true, force: true }); }
  }, 60_000);

  it('refuses a keys-profile launch without the launcher custody channel, before any session', () => {
    const f = custodyFixture('keys-profile');
    const result = spawnSync(bun, f.argv, { cwd: f.sealed, env: f.env, encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rpc custody IPC unavailable');
    expect(result.stdout).toBe('');
    expect(existsSync(join(f.root, 'agent', 'sessions'))).toBe(false);
  });

  it.each(['PI_PROVIDER_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_API_KEY'])('refuses a keys-profile launch environment that carries %s', (name) => {
    const f = custodyFixture('keys-profile');
    const result = spawnSync(bun, f.argv, { cwd: f.sealed, env: { ...f.env, [name]: 'sk-env-canary' }, encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('keys-profile credential environment refused');
    expect(result.stderr).not.toContain('sk-env-canary');
    expect(result.stdout).toBe('');
  });

  it.each(['opencode-go', 'byok-sdk-probe'])('refuses a composition error for %s before a model request', async (provider) => {
    const f = custodyFixture('keys-profile');
    let requests = 0;
    const server = createServer((_req, res) => { requests++; res.end(); });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no provider port');
      // Schema-valid to Pi, but composition fails: radius OAuth requires a provider baseUrl.
      writeFileSync(join(f.root, 'agent', 'models.json'), JSON.stringify({ providers: { [provider]: {
        apiKey: 'byok:rpc-ipc', oauth: 'radius', models: [{ id: 'minimax-m3', api: 'openai-completions',
          baseUrl: `http://127.0.0.1:${address.port}/v1` }],
      } } }));
      const argv = [...f.argv]; argv[argv.indexOf('--provider') + 1] = provider; argv[argv.indexOf('--model') + 1] = 'minimax-m3';
      const child = spawn(bun, argv, { cwd: f.sealed, env: { ...f.env, PI_CODING_AGENT_SESSION_DIR: join(f.root, 'sessions') },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'], timeout: 15_000 });
      let stderr = '', stdout = '';
      child.stderr!.on('data', data => { stderr += data; }); child.stdout!.on('data', data => { stdout += data; });
      child.once('message', (request: { configDigest: string }) => child.send({
        type: 'byok.pi.rpc.credential', configDigest: request.configDigest, secret: 'sk-composition-test',
      }));
      const code = await new Promise<number | null>(done => child.once('close', done));
      expect(code, stderr).toBe(1);
      expect(stderr).toContain('keys_profile_model_composition_failed');
      expect(stderr).not.toContain('sk-composition-test');
      expect(stdout).toBe(''); expect(requests).toBe(0);
    } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  }, 20_000);

  it('refuses a device-auth launch that was given an undeclared custody channel', async () => {
    const f = custodyFixture('pi-auth-store');
    const child = spawn(bun, f.argv, { cwd: f.sealed, env: f.env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr!.on('data', (data) => { stderr += data; });
    const code = await new Promise<number | null>((done) => child.once('exit', done));
    expect(code).toBe(1);
    expect(stderr).toContain('an undeclared custody IPC channel is open');
  }, 20_000);

  it.each([undefined, '', 'relative', '/tmp/session\ninvalid'])('refuses an invalid keys-profile session directory (%j) after custody', async (sessionDir) => {
    const f = custodyFixture('keys-profile');
    const child = spawn(bun, f.argv, {
      cwd: f.sealed, env: { ...f.env, PI_CODING_AGENT_SESSION_DIR: sessionDir }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      timeout: 15_000,
    });
    let stderr = '', stdout = '';
    child.stderr!.on('data', data => { stderr += data; });
    child.stdout!.on('data', data => { stdout += data; });
    child.once('message', (request: { configDigest: string }) => child.send({
      type: 'byok.pi.rpc.credential', configDigest: request.configDigest, secret: 'sk-session-dir-test',
    }));
    const code = await new Promise<number | null>(done => child.once('close', done));
    expect(code).toBe(1);
    expect(stderr).toContain('keys-profile launch requires an absolute single-line session directory');
    expect(stderr).not.toContain('sk-session-dir-test');
    expect(stdout).toBe('');
    expect(existsSync(join(f.root, 'agent', 'sessions'))).toBe(false);
  }, 20_000);

  it('resumes only an exact native session id and rejects a mismatched header cwd', () => {
    const f = fixture();
    const sessionDir = join(f.root, 'sessions');
    mkdirSync(sessionDir);
    const id = 'da7f5bd2-b688-4c29-9c93-2a61f13e8716';
    const path = join(sessionDir, 'existing.jsonl');
    writeFileSync(path, JSON.stringify({ type:'session', version:3, id, timestamp:new Date().toISOString(), cwd:f.cwd }) + '\n' +
      JSON.stringify({type:'message', id:'entry1', parentId:null, timestamp:new Date().toISOString(), message:{role:'user', content:'saved', timestamp:Date.now()}}) + '\n');
    const result = evaluate(`
      const cwd=${JSON.stringify(f.cwd)}, dir=${JSON.stringify(sessionDir)}, id=${JSON.stringify(id)};
      const resumed=await host.openPiRpcSession(cwd,id,dir);
      let prefix=false, mismatch=false;
      try { await host.openPiRpcSession(cwd,id.slice(0,8),dir); } catch { prefix=true; }
      try { await host.openPiRpcSession(${JSON.stringify(f.sealed)},${JSON.stringify(path)},dir); } catch { mismatch=true; }
      console.log(JSON.stringify({id:resumed.getSessionId(),cwd:resumed.getCwd(),prefix,mismatch}));
    `);
    expect(result).toEqual({ id, cwd:f.cwd, prefix:true, mismatch:true });
  });

  it('keeps Pi settings as the session directory authority for device auth', async () => {
    const f = fixture();
    const sessionDir = join(f.root, 'user-sessions');
    mkdirSync(join(f.cwd, '.pi'));
    writeFileSync(join(f.cwd, '.pi', 'settings.json'), JSON.stringify({ sessionDir }));
    const rpc = new PiRpcClient({
      command: bun, cwd: f.cwd,
      args: [f.entry, `--config-digest=${f.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 'anthropic', '--model', 'claude-sonnet-4-5'],
      env: { ...f.env, PI_CODING_AGENT_SESSION_DIR: join(f.root, 'ambient-session-decoy') },
    });
    try {
      const state = await rpc.send({ type: 'get_state' });
      expect(state.success).toBe(true);
      expect(dirname((state.data as { sessionFile: string }).sessionFile)).toBe(sessionDir);
    } finally { await rpc.dispose(); }
  }, 25_000);

  it('starts all inline factories under sealed process cwd with explicit config and native RPC', async () => {
    const f = fixture();
    const child = spawn(bun, [f.entry, `--config-digest=${f.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 'anthropic', '--model', 'claude-sonnet-4-5', '--thinking', 'high'], {
      cwd: f.sealed, env: f.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    try {
      const response = await new Promise<Record<string, any>>((accept, reject) => {
        let output = '';
        const timeout = setTimeout(() => reject(new Error(`RPC timed out: ${stderr}`)), 15_000);
        child.on('error', reject);
        child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`exit ${code}: ${stderr}`)); });
        child.stdout.on('data', (data) => {
          output += data;
          for (;;) {
            const newline = output.indexOf('\n');
            if (newline < 0) break;
            const line = output.slice(0, newline); output = output.slice(newline + 1);
            try {
              const frame = JSON.parse(line);
              if (frame.id === 'state') { clearTimeout(timeout); accept(frame); }
            } catch { reject(new Error(`non-RPC stdout: ${line}`)); }
          }
        });
        child.stdin.write(JSON.stringify({ id:'state', type:'get_state' }) + '\n');
      });
      expect(response.success).toBe(true);
      expect(response.data.sessionId).toEqual(expect.any(String));
      expect(response.data.model.id).toBe('claude-sonnet-4-5');
      expect(response.data.thinkingLevel).toBe('high');
      expect(stderr).not.toContain('Failed to load extension');
    } finally {
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
    }
  }, 25_000);

  it('loads the user\'s own Pi extensions and skills from the agent dir beside the SDK factories', async () => {
    const f = fixture();
    const agentDir = join(f.root, 'agent');
    mkdirSync(join(agentDir, 'extensions'), { recursive: true });
    mkdirSync(join(agentDir, 'skills', 'user-skill'), { recursive: true });
    writeFileSync(join(agentDir, 'extensions', 'user-probe.ts'),
      'export default function (pi) { pi.registerCommand("user-probe", { description: "user extension probe", handler: async () => {} }); }\n');
    writeFileSync(join(agentDir, 'skills', 'user-skill', 'SKILL.md'),
      '---\nname: user-skill\ndescription: A user skill the SDK must not hide.\n---\n\nUse this skill in tests only.\n');
    const child = spawn(bun, [f.entry, `--config-digest=${f.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 'anthropic', '--model', 'claude-sonnet-4-5'], {
      cwd: f.sealed, env: f.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    try {
      const response = await new Promise<Record<string, any>>((accept, reject) => {
        let output = '';
        const timeout = setTimeout(() => reject(new Error(`RPC timed out: ${stderr}`)), 15_000);
        child.on('error', reject);
        child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`exit ${code}: ${stderr}`)); });
        child.stdout.on('data', (data) => {
          output += data;
          for (;;) {
            const newline = output.indexOf('\n');
            if (newline < 0) break;
            const line = output.slice(0, newline); output = output.slice(newline + 1);
            try {
              const frame = JSON.parse(line);
              if (frame.id === 'commands') { clearTimeout(timeout); accept(frame); }
            } catch { reject(new Error(`non-RPC stdout: ${line}`)); }
          }
        });
        child.stdin.write(JSON.stringify({ id: 'commands', type: 'get_commands' }) + '\n');
      });
      expect(response.success).toBe(true);
      const commands = (response.data.commands as Array<{ name: string; source: string }>).map(({ name, source }) => ({ name, source }));
      expect(commands).toContainEqual({ name: 'user-probe', source: 'extension' });
      expect(commands).toContainEqual({ name: 'skill:user-skill', source: 'skill' });
      expect(stderr).not.toContain('Failed to load extension');
    } finally {
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
    }
  }, 25_000);

  // #1295: user installs of pi-web-access / rpiv-todo register the bundled names.
  it('lets user extensions with the bundled web_search and todo names replace the bundled ones', () => {
    const f = fixture();
    mkdirSync(join(f.root, 'agent', 'extensions'), { recursive: true });
    for (const name of ['web_search', 'todo']) {
      writeFileSync(join(f.root, 'agent', 'extensions', `user-${name}.ts`), `export default function (pi) { pi.registerTool({ name: ${JSON.stringify(name)}, label: 'user', description: 'user', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} }) }); }\n`);
    }
    const result = spawnSync(bun, [f.entry, `--config-digest=${f.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 'anthropic', '--model', 'claude-sonnet-4-5'], {
      cwd: f.sealed, env: f.env, encoding: 'utf8', timeout: 20_000, input: JSON.stringify({ id: 'state', type: 'get_state' }) + '\n',
    });
    expect(result.stdout).toContain('"command":"get_state","success":true');
    expect(result.stderr).not.toContain('conflicts with');
    for (const name of ['byok-web-access', 'byok-todo']) expect(result.stderr).toContain(`so Pi did not load ${name}`);
  }, 25_000);

  // #1296: settings name P; Q, listed first, also has a key.
  it.each([
    { auth: 'P has a key', requests: { P: 1, Q: 0 } },
    { auth: 'P has no key', requests: { P: 0, Q: 0 } },
  ])('excluded keeps the settings default model and never falls back to another provider: $auth', async ({ auth, requests }) => {
    const f = fixture();
    const agentDir = join(f.root, 'agent');
    mkdirSync(agentDir, { recursive: true });
    const seen = { P: 0, Q: 0 };
    const servers = (['P', 'Q'] as const).map(label => createServer(async (request, response) => {
      for await (const _ of request);
      seen[label] += 1;
      const frame = (choice: object) => 'data: ' + JSON.stringify({ id: label, object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }] }) + '\n\n';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(frame({ delta: { role: 'assistant', content: label }, finish_reason: null }) + frame({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
    }));
    const ports = await Promise.all(servers.map(server => new Promise<number>(done => server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port)))));
    const provider = (port: number, id: string) => ({ baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'synthetic',
      models: [{ id, name: id, contextWindow: 4096, maxTokens: 64, input: ['text'], reasoning: false }] });
    const { apiKey: _, ...keylessP } = provider(ports[0]!, 'p-model');
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: {
      'loopback-q': provider(ports[1]!, 'q-model'), 'loopback-p': auth === 'P has a key' ? provider(ports[0]!, 'p-model') : keylessP,
    } }));
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'loopback-p', defaultModel: 'p-model' }));
    const serialized = serializePiHostConfig({ ...f.config, agentUserContext: 'excluded', agentHome: f.cwd });
    writeFileSync(f.configPath, serialized.bytes);
    const client = new PiRpcClient({ command: bun, cwd: f.sealed, env: f.env, args: [f.entry, `--config-digest=${serialized.digest}`, '--config', f.configPath, '--mode', 'rpc'] });
    try {
      const run = async () => {
        expect((await client.send({ type: 'get_state' })).data).toMatchObject({ model: { provider: 'loopback-p', id: 'p-model' } });
        await client.send({ type: 'prompt', message: 'hello' });
        while (seen.P === 0) await new Promise(done => setTimeout(done, 50));
      };
      if (requests.P === 1) await run();
      else await expect(run()).rejects.toThrow('excluded user context starts a new session only on the defaultProvider and defaultModel of Pi settings');
      expect(seen).toEqual(requests);
    } finally {
      await client.dispose();
      await Promise.all(servers.map(server => new Promise<void>(done => server.close(() => done()))));
    }
  }, 30_000);

  it('lets a user extension finish an async session_shutdown hook on dispose, as OAR', async () => {
    const f = fixture();
    const marker = join(f.root, 'shutdown-done');
    mkdirSync(join(f.root, 'agent', 'extensions'), { recursive: true });
    writeFileSync(join(f.root, 'agent', 'extensions', 'slow-shutdown.ts'),
      `import { writeFileSync } from 'node:fs';\nexport default function (pi) { pi.on('session_shutdown', async () => { await new Promise((done) => setTimeout(done, 2000)); writeFileSync(${JSON.stringify(marker)}, 'done'); }); }\n`);
    const client = new PiRpcClient({
      command: bun, args: [f.entry, `--config-digest=${f.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 'anthropic', '--model', 'claude-sonnet-4-5'],
      cwd: f.sealed, env: f.env,
    });
    try {
      expect((await client.send({ type: 'get_commands' })).success).toBe(true);
    } finally {
      await client.dispose();
    }
    expect(existsSync(marker)).toBe(true);
  }, 30_000);

  // D8: every lane pre-trusts the session cwd, as in OAR. The key lane runs
  // the same host with the per-launch projection as its agent dir and a
  // separate session dir. The host starts in the session cwd.
  it.each(['user agent dir', 'BYOK key projection'] as const)('loads a project .pi extension from the session cwd in the %s lane', async (lane) => {
    const f = fixture();
    mkdirSync(join(f.cwd, '.pi', 'extensions'), { recursive: true });
    writeFileSync(join(f.cwd, '.pi', 'extensions', 'project-probe.ts'),
      'export default function (pi) { pi.registerCommand("project-probe", { description: "project extension probe", handler: async () => {} }); }\n');
    const dirs: Record<string, string> = lane === 'user agent dir'
      ? { PI_CODING_AGENT_DIR: join(f.root, 'agent') }
      : { PI_CODING_AGENT_DIR: join(f.root, 'projection'), PI_CODING_AGENT_SESSION_DIR: join(f.root, 'key-sessions') };
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    const child = spawn(bun, [f.entry, `--config-digest=${f.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 'anthropic', '--model', 'claude-sonnet-4-5'], {
      cwd: f.cwd, env: { ...f.env, ...dirs }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    try {
      const response = await new Promise<Record<string, any>>((accept, reject) => {
        let output = '';
        const timeout = setTimeout(() => reject(new Error(`RPC timed out: ${stderr}`)), 15_000);
        child.on('error', reject);
        child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`exit ${code}: ${stderr}`)); });
        child.stdout.on('data', (data) => {
          output += data;
          for (;;) {
            const newline = output.indexOf('\n');
            if (newline < 0) break;
            const line = output.slice(0, newline); output = output.slice(newline + 1);
            try {
              const frame = JSON.parse(line);
              if (frame.id === 'commands') { clearTimeout(timeout); accept(frame); }
            } catch { reject(new Error(`non-RPC stdout: ${line}`)); }
          }
        });
        child.stdin.write(JSON.stringify({ id: 'commands', type: 'get_commands' }) + '\n');
      });
      expect(response.success).toBe(true);
      const commands = (response.data.commands as Array<{ name: string; source: string }>).map(({ name, source }) => ({ name, source }));
      expect(commands).toContainEqual({ name: 'project-probe', source: 'extension' });
      expect(stderr).not.toContain('Failed to load extension');
    } finally {
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
    }
  }, 25_000);

  it.each(['cwd','mcp'] as const)('rejects changed config %s bytes before creating a native session', (field) => {
    const f = fixture();
    const changed = field==='cwd' ? {...f.config,cwd:f.cwd+'-changed'} : {...f.config,mcp:{...f.config.mcp,mcpEnv:{CHANGED:'1'}}};
    writeFileSync(f.configPath,JSON.stringify(changed));
    const result = spawnSync(bun,[f.entry,`--config-digest=${f.digest}`,'--config',f.configPath,'--mode','rpc'],
      {cwd:f.sealed,env:f.env,encoding:'utf8',timeout:15_000});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('config byte digest mismatch');
    expect(result.stdout).toBe('');
    expect(existsSync(join(f.root,'agent','sessions'))).toBe(false);
  });

  it.each([['--tools', 'bash'], ['--exclude-tools', 'bash'], ['--no-tools']])('rejects the delegated tool flag %s before starting RPC', (...flag) => {
    const f = fixture();
    const result = spawnSync(bun, [f.entry, `--config-digest=${f.digest}`, '--config', f.configPath, '--mode', 'rpc', ...flag], {
      cwd:f.sealed, env:f.env, encoding:'utf8', timeout:15_000,
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toContain(`unsupported argument ${flag[0]}`);
    expect(result.stdout).toBe('');
  });

  // The config the pi adapter writes for an offer whose server projection
  // carries the SDK-reserved Agent-message server (#180): launchCwd because
  // any projected server requires one, and the server pointed at the
  // native-message fixture, which answers the live session_start observe with
  // exactly `send_agent_message`.
  function messageFixture() {
    const f = fixture();
    const config = {
      ...f.config,
      mcp: {
        mcpEnv: { BYOK_NATIVE_MESSAGE_RECEIPT: join(f.root, 'native-message-receipt.json') },
        mcpServers: { byokagentmessage: {
          command: f.command,
          args: [resolve(import.meta.dirname, 'fixtures/native-agent-message-mcp.mjs')],
        } },
        observation: {}, launchCwd: f.cwd,
      },
    };
    const serialized = serializePiHostConfig(config);
    writeFileSync(f.configPath, serialized.bytes);
    return { ...f, config, digest: serialized.digest };
  }

  it('starts RPC with the reserved Agent-message server projected', async () => {
    const f = messageFixture();
    const child = spawn(bun, [f.entry, `--config-digest=${f.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 'anthropic', '--model', 'claude-sonnet-4-5', '--thinking', 'high'], {
      cwd: f.sealed, env: f.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    try {
      const response = await new Promise<Record<string, any>>((accept, reject) => {
        let output = '';
        const timeout = setTimeout(() => reject(new Error(`RPC timed out: ${stderr}`)), 15_000);
        child.on('error', reject);
        child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`exit ${code}: ${stderr}`)); });
        child.stdout.on('data', (data) => {
          output += data;
          for (;;) {
            const newline = output.indexOf('\n');
            if (newline < 0) break;
            const line = output.slice(0, newline); output = output.slice(newline + 1);
            try {
              const frame = JSON.parse(line);
              if (frame.id === 'state') { clearTimeout(timeout); accept(frame); }
            } catch { reject(new Error(`non-RPC stdout: ${line}`)); }
          }
        });
        child.stdin.write(JSON.stringify({ id:'state', type:'get_state' }) + '\n');
      });
      expect(response.success).toBe(true);
      expect(stderr).not.toContain('Failed to load extension');
    } finally {
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
    }
  }, 25_000);
});
