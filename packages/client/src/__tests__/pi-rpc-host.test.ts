import { serializePiHostConfig } from '../adapters/pi/runtime-host-binding';
import { PiRpcClient } from '../adapters/pi/rpc-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { observeMcpServer, qualifiedMcpToolName } from '../mcp';
// Relative and test-only: the release graph keeps `@byok-sdk/keys` and the dispatch packages disjoint.
import { PI_THINKING_LEVELS } from '../../../keys/src/pi-model-config';
import { assertPiLaunchArgs, buildPiProviderArgs } from '../../../keys/src/pi-provider-projection';
import { parseModelProviderProfile } from '../../../keys/src/provider-profile';

const clientRoot = resolve(import.meta.dirname, '../..');
// Private parser/session exports are not public API. Compile their test entry
// through the same peer-resolution author as the shipped ordinary host.
const hostScratch = mkdtempSync(join(clientRoot, 'node_modules/.byok-rpc-host-test-'));
const host = join(hostScratch, 'host.mjs');

const bun = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['bun'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0]!;
beforeAll(() => {
  const driver = join(hostScratch, 'build.ts');
  const entry = `export {parsePiRpcHostArgs,parsePiRpcHostConfig,openPiRpcSession} from ${JSON.stringify(resolve(import.meta.dirname, '../bin/pi-rpc-host.ts'))};`;
  writeFileSync(driver, `
    import {createRequire} from 'node:module';
    import {subagentsBuild} from ${JSON.stringify(join(clientRoot, 'scripts/subagents-build.ts'))};
    const require = createRequire(createRequire(import.meta.url).resolve('tsup'));
    await require('esbuild').build({
      stdin:{contents:${JSON.stringify(entry)},resolveDir:${JSON.stringify(clientRoot)},loader:'ts'},
      outfile:${JSON.stringify(host)},bundle:true,packages:'external',platform:'node',format:'esm',target:'es2022',
      plugins:[subagentsBuild(false)]
    });
  `);
  const result = spawnSync(bun, ['--no-install', driver], { cwd: clientRoot, encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
});
afterAll(() => rmSync(hostScratch, { recursive: true, force: true }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-rpc-host-')));
  roots.push(root);
  const cwd = join(root, 'session workspace');
  const sealed = join(root, 'sealed');
  mkdirSync(cwd); mkdirSync(sealed);
  const entry = join(root, 'host-entry.ts');
  writeFileSync(entry, `import {runPiRpcHost} from ${JSON.stringify(resolve(import.meta.dirname, '../../dist/bin/pi-runtime-host.js'))}; runPiRpcHost(process.argv.slice(2)).catch(error=>{console.error(String(error));process.exit(1)});`);
  const command = spawnSync(bun, ['--print', 'process.execPath'], {encoding:'utf8'}).stdout.trim();
  const config = { format: 'byok.pi.rpc-launch', version: 6, credentialSource: 'pi-auth-store', cwd,
    agentToolPolicy: { builtinTools: 'inherit', userContext: 'inherit', extensions: 'inherit' },
    mcp: { mcpEnv: {}, mcpServers: {}, observation: {} } };
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
        {...base, version:4}, withoutSource, {...base, credentialSource:'env'}]) {
        try { host.parsePiRpcHostConfig(cfg); rejected.push(false); } catch { rejected.push(true); }
      }
      console.log(JSON.stringify(rejected));
    `);
    expect(result).toEqual(Array(15).fill(true));
  });

  it('rejects v5 and malformed Agent policy instead of accepting an unrestricted launch', () => {
    const f = fixture();
    expect(evaluate(`
      const base = ${JSON.stringify(f.config)};
      console.log(JSON.stringify([
        {...base, version:5}, {...base, agentToolPolicy:undefined},
        {...base, agentToolPolicy:{...base.agentToolPolicy,builtinTools:['bash','bash']}},
        {...base, agentToolPolicy:{...base.agentToolPolicy,builtinTools:['shell']}},
        {...base, agentToolPolicy:{...base.agentToolPolicy,userContext:'best-effort'}},
        {...base, agentToolPolicy:{...base.agentToolPolicy,extensions:['unknown']}},
      ].map(value=>{try {host.parsePiRpcHostConfig(value);return false;}catch{return true;}})));
    `)).toEqual(Array(6).fill(true));
  });

  it.each([
    {builtinTools:['read'], withMcp:false},
    {builtinTools:[], withMcp:false},
    {builtinTools:[], withMcp:true},
  ])('advertises selected native tools $builtinTools and task MCP=$withMcp while refusing unadvertised bash', async ({builtinTools, withMcp}) => {
    const f = fixture();
    const marker = join(f.root, 'user-extension-loaded');
    const bashMarker = join(f.root, 'forbidden-bash-write');
    const agentDir = join(f.root, 'agent');
    mkdirSync(join(agentDir, 'extensions'), { recursive: true });
    mkdirSync(join(f.cwd, '.pi'), { recursive: true });
    writeFileSync(join(agentDir, 'extensions', 'forbidden.ts'), `import {writeFileSync} from 'node:fs'; export default function(pi){writeFileSync(${JSON.stringify(marker)},'loaded');pi.registerCommand('forbidden-user-command',{handler:async()=>{}});}`);
    writeFileSync(join(agentDir, 'AGENTS.md'), 'FORBIDDEN_GLOBAL_CONTEXT');
    writeFileSync(join(f.cwd, '.pi', 'SYSTEM.md'), 'FORBIDDEN_PROJECT_SYSTEM');
    const taskServer = {
      command: f.command,
      args: [resolve(import.meta.dirname, 'fixtures/toolset-echo-mcp.mjs'), join(f.root, 'task-mcp-audit.jsonl')],
    };
    const mcp = withMcp ? {
      mcpEnv: {},
      launchCwd: f.sealed,
      mcpServers: { task: taskServer },
      observation: { task: { ...await observeMcpServer('task', taskServer, { env: f.env }), toolsetId: 'task.v1' } },
    } : f.config.mcp;
    let received!: (body: { tools?: { function: { name: string } }[]; messages?: unknown[] }) => void;
    const requestBody = new Promise<{ tools?: { function: { name: string } }[]; messages?: unknown[] }>(done => { received = done; });
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
        // A provider is not constrained to the advertised schemas. Execution
        // must reject this call before the command can create an outside file.
        const argumentsJson = JSON.stringify({ command: `touch '${bashMarker}'` });
        response.end('data: ' + JSON.stringify({ id:'loopback-call', object:'chat.completion.chunk', choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'forbidden-bash',type:'function',function:{name:'bash',arguments:argumentsJson}}]},finish_reason:null}] }) + '\n\n' +
          'data: ' + JSON.stringify({ id:'loopback-call', object:'chat.completion.chunk', choices:[{index:0,delta:{},finish_reason:'tool_calls'}] }) + '\n\ndata: [DONE]\n\n');
        return;
      }
      response.end('data: ' + JSON.stringify({ id:'loopback', object:'chat.completion.chunk', choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:null}] }) + '\n\n' +
        'data: ' + JSON.stringify({ id:'loopback', object:'chat.completion.chunk', choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2} }) + '\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing loopback address');
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { 's1-loopback': {
      baseUrl:`http://127.0.0.1:${address.port}/v1`, api:'openai-completions', apiKey:'synthetic-not-a-secret',
      models:[{id:'probe',name:'probe',contextWindow:4096,maxTokens:32,input:['text'],reasoning:false}],
    } } }));
    const config = { ...f.config, mcp, agentToolPolicy: { builtinTools, userContext:'excluded', extensions:[] } };
    const serialized = serializePiHostConfig(config);
    writeFileSync(f.configPath, serialized.bytes);
    const client = new PiRpcClient({
      command:bun, cwd:f.sealed, env:f.env,
      args:[f.entry, `--config-digest=${serialized.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 's1-loopback', '--model', 'probe'],
    });
    try {
      const commands = await client.send({ type:'get_commands' });
      expect(commands.success).toBe(true);
      expect((commands.data as {commands:{name:string}[]}).commands.some(command=>command.name==='forbidden-user-command')).toBe(false);
      expect((await client.send({type:'prompt',message:'say ok'})).success).toBe(true);
      const body = await requestBody;
      expect((body.tools?.map(tool=>tool.function.name) ?? []).sort()).toEqual(
        [...builtinTools, ...(withMcp ? [qualifiedMcpToolName('task', 'echo')] : [])].sort(),
      );
      expect(JSON.stringify(body.messages)).not.toContain('FORBIDDEN_GLOBAL_CONTEXT');
      expect(JSON.stringify(body.messages)).not.toContain('FORBIDDEN_PROJECT_SYSTEM');
      expect(existsSync(marker)).toBe(false);
      const continuation = await toolResultBody;
      expect(JSON.stringify(continuation.messages)).toContain('Tool bash not found');
      expect(existsSync(bashMarker)).toBe(false);
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

  it('refuses a keys-profile launch without the launcher custody channel, before any session', () => {
    const f = custodyFixture('keys-profile');
    const result = spawnSync(bun, f.argv, { cwd: f.sealed, env: f.env, encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rpc custody IPC unavailable');
    expect(result.stdout).toBe('');
    expect(existsSync(join(f.root, 'agent', 'sessions'))).toBe(false);
  });

  it.each(['PI_PROVIDER_API_KEY', 'OPENAI_API_KEY'])('refuses a keys-profile launch environment that carries %s', (name) => {
    const f = custodyFixture('keys-profile');
    const result = spawnSync(bun, f.argv, { cwd: f.sealed, env: { ...f.env, [name]: 'sk-env-canary' }, encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('keys-profile credential environment refused');
    expect(result.stderr).not.toContain('sk-env-canary');
    expect(result.stdout).toBe('');
  });

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
