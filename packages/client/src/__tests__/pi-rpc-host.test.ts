import { serializePiHostConfig } from '../adapters/pi/runtime-host-binding';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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
  const binding = {format:'byok.implementation-spawn',version:1,identity:{kind:'unavailable',reason:'resolver_unconfigured'},
    command,entry,fixedArgv:[],cwd:sealed,envCommitments:{PI_CODING_AGENT_DIR:join(root,'agent')}};
  const config = { binding, format: 'byok.pi.rpc-launch', version: 3, descendantPlan: null, cwd,
    mcp: { mcpEnv: {}, mcpServers: {}, observation: {}, toolImplementations: {} } };
  const configPath = join(root, 'config.json');
  const serialized=serializePiHostConfig(config);
  writeFileSync(configPath, serialized.bytes);
  const env = { HOME: root, PATH: process.env.PATH!, PI_CODING_AGENT_DIR: join(root, 'agent'),
    // Deliberately invalid old control authorities must never be consulted.
    BYOK_PI_MCP_CONFIG_PATH: '/does/not/exist', BYOK_PI_PERMISSION_MODE: 'invalid' };
  return { root, cwd, sealed, configPath, config, env, entry, digest:serialized.digest };
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
      for (const cfg of [{...base, version:1}, {...base, version:2}, {...base, cwd:'relative'}, {...base, extra:true}, {...base, policy:{mode:'auto'}}]) {
        try { host.parsePiRpcHostConfig(cfg); rejected.push(false); } catch { rejected.push(true); }
      }
      console.log(JSON.stringify(rejected));
    `);
    expect(result).toEqual(Array(10).fill(true));
  });

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
    const serialized = serializePiHostConfig({ ...f.config, binding: { ...f.config.binding, cwd: f.cwd, envCommitments: dirs } });
    writeFileSync(f.configPath, serialized.bytes);
    const child = spawn(bun, [f.entry, `--config-digest=${serialized.digest}`, '--config', f.configPath, '--mode', 'rpc', '--provider', 'anthropic', '--model', 'claude-sonnet-4-5'], {
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

  it.each(['cwd','binding'] as const)('rejects changed config %s bytes before creating a native session', (field) => {
    const f = fixture();
    const changed = field==='cwd' ? {...f.config,cwd:f.cwd+'-changed'} : {...f.config,binding:{...f.config.binding,cwd:f.sealed+'-changed'}};
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
          command: f.config.binding.command,
          args: [resolve(import.meta.dirname, 'fixtures/native-agent-message-mcp.mjs')],
        } },
        observation: {}, toolImplementations: {}, launchCwd: f.cwd,
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
