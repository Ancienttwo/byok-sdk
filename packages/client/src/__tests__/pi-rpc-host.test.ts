import { serializePiHostConfig } from '../adapters/pi/runtime-host-binding';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const host = resolve(import.meta.dirname, '../bin/pi-rpc-host.ts');

const bun = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['bun'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0]!;
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
  const config = { binding, format: 'byok.pi.rpc-launch', version: 1, cwd, policy: { mode: 'auto' },
    mcp: { mcpEnv: {}, mcpServers: {}, observation: {}, toolImplementations: {}, permissionMode: 'auto' } };
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
      for (const cfg of [{...base, version:2}, {...base, cwd:'relative'}, {...base, extra:true}, {...base, policy:{mode:'readonly'}}]) {
        try { host.parsePiRpcHostConfig(cfg); rejected.push(false); } catch { rejected.push(true); }
      }
      console.log(JSON.stringify(rejected));
    `);
    expect(result).toEqual(Array(9).fill(true));
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
    const child = spawn(bun, [f.entry, `--config-digest=${f.digest}`, '--config', f.configPath, '--mode', 'rpc', '--no-extensions', '--no-skills', '--provider', 'anthropic', '--model', 'claude-sonnet-4-5', '--thinking', 'high'], {
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

  it('refuses tool projection drift before starting RPC', () => {
    const f = fixture();
    const result = spawnSync(bun, [f.entry, `--config-digest=${f.digest}`, '--config', f.configPath, '--mode', 'rpc', '--tools', 'bash'], {
      cwd:f.sealed, env:f.env, encoding:'utf8', timeout:15_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('delegated tool flags differ from policy');
    expect(result.stdout).toBe('');
  });
});
