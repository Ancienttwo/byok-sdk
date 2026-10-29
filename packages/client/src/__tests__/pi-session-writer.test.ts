import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { acquirePiSessionDiscovery, acquirePiSessionRebinding, acquirePiSessionWriter } from '../util/pi-session-retention';
import { PathMutationGateBusyError } from '../util/path-mutation-gate';
import { ScratchRoot } from '../daemon/retention/scratch';
import { resolveStorageConfig } from '../daemon/retention/config';
import { createRetentionRegistry } from '../daemon/retention/producers';
import { RetentionSweeper } from '../daemon/retention/sweeper';
import { StoragePressure } from '../daemon/retention/pressure';
import { testScratchRoot } from './fixtures/execution-scratch';

const clientRoot = resolve(import.meta.dirname, '../..');
const root = mkdtempSync(join(clientRoot, 'node_modules/.pi-session-writer-'));
const entry = join(root, 'host.mjs');
const bun = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['bun'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0]!;
const processes: {child:ChildProcess;closed:Promise<unknown>}[] = [];
const ownedWriterFiles = new Set<string>();
const setupMarkers: string[] = [];
const descriptors: number[] = [];
const descendants: number[] = [];
let sequence = 0;
beforeAll(() => {
  const driver = join(root, 'build.ts');
  const source = `import {existsSync,writeFileSync} from 'node:fs'; import {runPiSessionRuntime} from ${JSON.stringify(resolve(import.meta.dirname, '../bin/pi-session-runtime.ts'))};
    const config=JSON.parse(process.argv[2]);
    runPiSessionRuntime({...config,initialModel:'on-prompt',label:'retention-test',noTools:'all',
      resourceLoaderOptions:{noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,
        extensionFactories:config.testMarker||config.testTarget?[{name:'retention-test',factory:pi=>{pi.registerCommand('retention-rewrite',{
          handler:async(_args,ctx)=>{
            await ctx.newSession({setup:async manager=>{
              manager.newSession();writeFileSync(config.testMarker,manager.getSessionFile());
              while(!existsSync(config.testMarker+'.continue'))await new Promise(resolve=>setTimeout(resolve,5));
            },withSession:async fresh=>{await fresh.newSession({setup:async manager=>{
              manager.newSession();writeFileSync(config.testMarker+'.nested',manager.getSessionFile());
            }});}});
          }
        });pi.registerCommand('retention-target',{handler:async(args,ctx)=>{
          await ctx.newSession({setup:async manager=>{
            manager.setSessionFile(config.testTarget);
            if(args==='throw')throw new Error('setup failed after changing file');
            writeFileSync(config.testMarker,manager.getSessionFile());
            while(!existsSync(config.testMarker+'.continue'))await new Promise(resolve=>setTimeout(resolve,5));
          }});
        }});pi.registerCommand('retention-nested-setup',{handler:async(_args,ctx)=>{
          await ctx.newSession({setup:async()=>{await ctx.newSession({setup:async manager=>{
            manager.newSession();writeFileSync(config.testMarker,manager.getSessionFile());
          }});}});
        }});}}]:[]},
      reject:message=>{throw new Error(message)}}).catch(error=>{console.error(error);process.exit(1)});`;
  writeFileSync(driver, `import {createRequire} from 'node:module';
    const require=createRequire(createRequire(import.meta.url).resolve('tsup'));
    await require('esbuild').build({stdin:{contents:${JSON.stringify(source)},resolveDir:${JSON.stringify(clientRoot)},loader:'ts'},
      outfile:${JSON.stringify(entry)},bundle:true,packages:'external',platform:'node',format:'esm',target:'es2022'});`);
  const result = spawnSync(bun, ['--no-install', driver], { cwd: clientRoot, encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
});
async function waitForOwnedClose(closed: Promise<unknown>, pid: number | undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([closed,new Promise<never>((_resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error(`owned Pi fixture did not close: ${pid}`)),5_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function cleanupFixtures(): Promise<void> {
  // Unblock only this fixture's deliberate setup barriers before requesting
  // native disposal. A normal test must not SIGKILL its writer sockets away.
  for (const marker of setupMarkers.splice(0)) {
    writeFileSync(marker+'.continue','');
    for (const candidate of [marker,marker+'.nested']) if (existsSync(candidate)) ownedWriterFiles.add(readFileSync(candidate,'utf8'));
  }
  const ownedDescendants=descendants.splice(0);
  for (const pid of ownedDescendants) {
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  for (const {child} of processes) if (child.exitCode === null && child.signalCode === null) {
    if (child.stdin === null) child.kill('SIGTERM');
    else child.stdin.end();
  }
  const failures: unknown[] = [];
  for (const {child,closed} of processes.splice(0)) {
    try { await waitForOwnedClose(closed,child.pid); }
    catch (error) {
      // A failed close remains a test failure. Stop only these owned processes
      // and still await pipe closure before attempting their gate recovery.
      if (child.stdin === null) for (const pid of ownedDescendants) {
        try { process.kill(pid,'SIGKILL'); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') failures.push(failure); }
      }
      child.kill('SIGKILL'); failures.push(error);
      try { await waitForOwnedClose(closed,child.pid); } catch (failure) { failures.push(failure); }
    }
  }
  for (const fd of descriptors.splice(0)) closeSync(fd);
  // Reacquire only explicit file keys observed from our RPC/fixture callbacks.
  // The production gate proves any endpoint stale and unlinks it on release;
  // no directory snapshot or guessed socket/PID ownership is used for removal.
  for (const file of ownedWriterFiles) {
    try { const lease=await acquirePiSessionWriter(file); await lease.release(); ownedWriterFiles.delete(file); }
    catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures,'Pi fixture cleanup failed');
}
async function expectGateBusy(acquire: () => Promise<{release():Promise<void>}>): Promise<void> {
  let unexpected: {release():Promise<void>} | undefined;
  try { await expect(acquire().then(lease=>{unexpected=lease;return lease;})).rejects.toBeInstanceOf(PathMutationGateBusyError); }
  finally { await unexpected?.release(); }
}
function expectWriterBusy(file: string): Promise<void> {
  ownedWriterFiles.add(file);
  return expectGateBusy(()=>acquirePiSessionWriter(file));
}
afterEach(cleanupFixtures);
afterAll(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
  const directory = join(root, `test-${++sequence}`), cwd = join(directory, 'cwd'), sessionDir = join(directory, 'sessions');
  mkdirSync(cwd, { recursive: true }); mkdirSync(sessionDir);
  return { directory, cwd, sessionDir };
}
function start(config: { cwd: string; sessionDir: string; session?: string; testMarker?: string; testTarget?: string }, intermediary = false) {
  const env = { PATH: process.env.PATH, HOME: join(config.cwd, 'home'), PI_CODING_AGENT_DIR: join(config.cwd, 'agent') };
  const pidFile = join(config.cwd, 'writer.pid');
  const args = intermediary ? ['--input-type=module', '--eval', `
    import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,${JSON.stringify([entry, JSON.stringify(config)])},{stdio:['inherit','inherit','inherit']});
    writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`] : [entry, JSON.stringify(config)];
  let inputFd: number | undefined;
  if (intermediary) {
    // Keep RPC input owned by the test independently of the launcher process.
    // Otherwise Node closes its child's pipe on exit and Pi shuts down at EOF,
    // which cannot exercise a live descendant after the launcher is killed.
    const fifo = join(config.cwd, 'rpc-input');
    const made = spawnSync('mkfifo', [fifo]);
    if (made.status !== 0) throw new Error('could not create test RPC FIFO');
    inputFd = openSync(fifo, 'r+'); descriptors.push(inputFd);
  }
  const child = spawn(process.execPath, args, { cwd: config.cwd, env, stdio: [inputFd ?? 'pipe', 'pipe', 'pipe'] });
  const closed = once(child,'close');
  processes.push({child,closed});
  if (config.testMarker !== undefined) setupMarkers.push(config.testMarker);
  if (config.testTarget !== undefined) ownedWriterFiles.add(config.testTarget);
  let buffer = '', stderr = '', nextId = 0;
  const frames: Record<string, unknown>[] = [];
  const pending = new Map<string, { resolve(value: Record<string, any>): void; reject(error: Error): void }>();
  child.stderr!.setEncoding('utf8'); child.stderr!.on('data', data => { stderr += data; });
  child.stdout!.setEncoding('utf8'); child.stdout!.on('data', data => {
    buffer += data;
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      frames.push(message);
      if (typeof message.data?.sessionFile === 'string') ownedWriterFiles.add(message.data.sessionFile);
      if (message.type === 'response') { pending.get(message.id)?.resolve(message); pending.delete(message.id); }
    }
  });
  child.on('exit', () => {
    if (intermediary) return; // The inherited RPC pipe still belongs to the live writer.
    for (const waiter of pending.values()) waiter.reject(new Error(`host exited: ${stderr}`));
    pending.clear();
  });
  return {
    child, pidFile, frames,
    async send(type: string, payload: Record<string, unknown> = {}) {
      const id = String(++nextId);
      return new Promise<Record<string, any>>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${type} timed out: ${stderr}`)); }, 15_000);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        const bytes = `${JSON.stringify({ type, id, ...payload })}\n`;
        if (inputFd === undefined) child.stdin!.write(bytes); else writeSync(inputFd, bytes);
      });
    },
  };
}

it('holds the actual fresh session file before RPC input and releases old writers on new/switch', async () => {
  const f = fixture(), runtime = start(f);
  const first = await runtime.send('get_state');
  expect(first.success).toBe(true);
  const file = first.data.sessionFile as string;
  await expectWriterBusy(file);
  const discovery = await acquirePiSessionDiscovery(f.sessionDir); await discovery.release();
  const secondRuntime = start(f), parallel = await secondRuntime.send('get_state');
  expect(parallel.data.sessionFile).not.toBe(file);
  await expectWriterBusy(parallel.data.sessionFile);
  expect((await runtime.send('new_session')).success).toBe(true);
  const next = await runtime.send('get_state');
  expect(next.data.sessionId).not.toBe(first.data.sessionId);
  const retired = await acquirePiSessionWriter(file); await retired.release();
  await expectWriterBusy(next.data.sessionFile);
  // Pi resumes by header identity; the suffix may be different after reopening
  // an empty file. Its writer still owns the actual file that sweep would unlink.
  const mismatch = join(f.sessionDir, '2026-09-01T00-00-00-000Z_filename-id.jsonl');
  writeFileSync(mismatch, `${JSON.stringify({type:'session',version:3,id:'header-id',timestamp:'2026-09-01T00:00:00.000Z',cwd:f.cwd})}\n`);
  expect((await runtime.send('switch_session', { sessionPath: mismatch })).success).toBe(true);
  expect((await runtime.send('get_state')).data.sessionId).toBe('header-id');
  await expectWriterBusy(mismatch);
  const previous = await acquirePiSessionWriter(next.data.sessionFile); await previous.release();
  for (const sessionPath of [relative(f.cwd, mismatch), pathToFileURL(mismatch).href, `${f.sessionDir}/../sessions/${mismatch.split('/').pop()}`]) {
    expect((await runtime.send('switch_session', {sessionPath})).success).toBe(true);
    expect((await runtime.send('get_state')).data.sessionId).toBe('header-id');
  }
  const home = join(f.cwd, 'home'); mkdirSync(home, {recursive:true});
  const tilde = join(home, 'tilde-session.jsonl');
  writeFileSync(tilde, `${JSON.stringify({type:'session',version:3,id:'tilde',timestamp:'2026-09-01T00:00:00.000Z',cwd:f.cwd})}\n`);
  expect((await runtime.send('switch_session', {sessionPath:'~/tilde-session.jsonl'})).success).toBe(true);
  await expectWriterBusy(tilde);
  const empty = join(f.sessionDir, '2026-09-01T00-00-00-000Z_empty.jsonl');
  writeFileSync(empty, '');
  expect((await runtime.send('switch_session', {sessionPath:empty})).success).toBe(true);
  const emptyState = await runtime.send('get_state');
  expect(emptyState.data.sessionId).not.toBe('empty');
  expect(emptyState.data.sessionFile).toBe(empty);
  await expectWriterBusy(empty);
  const retiredMismatch = await acquirePiSessionWriter(mismatch); await retiredMismatch.release();
  const exited = once(runtime.child, 'exit'); runtime.child.stdin!.end(); await exited;
  const closed = await acquirePiSessionWriter(empty); await closed.release();
});

it.skipIf(process.platform === 'win32')('keeps the actual writer gate after its launcher is SIGKILLed', async () => {
  const f = fixture(), runtime = start(f, true);
  const state = await runtime.send('get_state');
  expect(state.success).toBe(true);
  const pid = Number(readFileSync(runtime.pidFile, 'utf8')); descendants.push(pid);
  const file = state.data.sessionFile as string;
  writeFileSync(file, `${JSON.stringify({type:'session',version:3,id:state.data.sessionId,timestamp:'2020-01-01T00:00:00.000Z',cwd:f.cwd})}\n`);
  utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01'));
  const sweeper = await sweeperFor(f.sessionDir);
  const exited = once(runtime.child, 'exit'); runtime.child.kill('SIGKILL'); await exited;
  expect((await runtime.send('get_state')).data.sessionId).toBe(state.data.sessionId);
  await expectWriterBusy(state.data.sessionFile);
  await sweeper.runPass('periodic'); expect(existsSync(file)).toBe(true);
  process.kill(pid, 'SIGKILL');
  // The writer's socket is released by process exit, without a persisted pin or
  // probing a guessed PID to make retention decisions.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const check = async () => {
      try { const gate = await acquirePiSessionWriter(state.data.sessionFile); await gate.release(); resolve(); }
      catch (error) { if (Date.now() >= deadline) reject(error); else setTimeout(check, 10); }
    }; void check();
  });
  descendants.splice(descendants.indexOf(pid), 1);
  await sweeper.runPass('periodic'); expect(existsSync(file)).toBe(false);
  await sweeper.stop();
});

it('a busy writer refuses startup and releases the discovery barrier', async () => {
  const f = fixture();
  const file = join(f.sessionDir, '2026-09-01T00-00-00-000Z_busy.jsonl');
  writeFileSync(file, `${JSON.stringify({type:'session',version:3,id:'busy',timestamp:'2026-09-01T00:00:00.000Z',cwd:f.cwd})}\n`);
  const lease = await acquirePiSessionWriter(file);
  try {
    const runtime = start({...f, session:'busy'});
    await expect(runtime.send('get_state')).rejects.toThrow('mutation gate is already held');
    const discovery = await acquirePiSessionDiscovery(f.sessionDir); await discovery.release();
  } finally { await lease.release(); }
  const runtime = start({...f, session:'busy'});
  expect((await runtime.send('get_state')).data.sessionId).toBe('busy');
});

async function sweeperFor(piSessionDir: string): Promise<RetentionSweeper> {
  const storeDir = join(root, `other-store-${++sequence}`); mkdirSync(storeDir);
  const config = resolveStorageConfig(storeDir, {scratchRoot:testScratchRoot()});
  const clock = () => new Date('2026-10-29T00:00:00Z'), scratch = new ScratchRoot(config.scratchRoot,clock);
  await scratch.open(storeDir);
  const registry = createRetentionRegistry({storeDir,scratch,config,clock,piSessionDir,
    journal:()=>undefined,identity:()=>undefined,preparation:()=>undefined});
  return new RetentionSweeper({registry,config,clock,pressure:new StoragePressure(config.budget),
    freeBytes:async()=>1_000_000_000,jitter:(_seed,ms)=>ms,onFailure:()=>{}});
}

it('native resume discovers a header after blank and malformed prefix lines', async () => {
  const f = fixture(), file = join(f.sessionDir, '2026-09-01T00-00-00-000Z_filename-id.jsonl');
  writeFileSync(file, `\nmalformed\n${JSON.stringify({type:'session',version:3,id:'header-id',timestamp:'2026-09-01T00:00:00.000Z',cwd:f.cwd})}\n`);
  const runtime = start({...f,session:'header-id'});
  expect((await runtime.send('get_state')).data.sessionId).toBe('header-id');
  await expectWriterBusy(file);
});

it('protects mutable setup and allows reentrant withSession replacement', async () => {
  const f = fixture(), marker = join(f.directory,'setup');
  const runtime = start({...f,testMarker:marker});
  const original = await runtime.send('get_state');
  const command = runtime.send('prompt', {message:'/retention-rewrite'});
  await vi.waitFor(()=>expect(existsSync(marker)).toBe(true));
  await expectGateBusy(()=>acquirePiSessionRebinding());
  writeFileSync(marker+'.continue','');
  expect((await command).success).toBe(true);
  const state = await runtime.send('get_state');
  expect(state.data.sessionFile).toBe(readFileSync(marker+'.nested','utf8'));
  await expectWriterBusy(state.data.sessionFile);
  const initial = await acquirePiSessionWriter(original.data.sessionFile); await initial.release();
  const intermediate = await acquirePiSessionWriter(readFileSync(marker,'utf8')); await intermediate.release();
  const discovery = await acquirePiSessionDiscovery(f.sessionDir); await discovery.release();
});

it('retains the actual file when mutable setup changes it and then throws', async () => {
  const f = fixture(), target = join(f.sessionDir,'2020-01-01T00-00-00-000Z_setup-target.jsonl');
  writeFileSync(target, `${JSON.stringify({type:'session',version:3,id:'setup-target',timestamp:'2020-01-01T00:00:00.000Z',cwd:f.cwd})}\n`);
  const runtime = start({...f,testTarget:target});
  expect((await runtime.send('get_state')).success).toBe(true);
  expect((await runtime.send('prompt',{message:'/retention-target throw'})).success).toBe(true);
  await expectWriterBusy(target);
});

it('protects a cross-directory setup mutation while it awaits and after it finishes', async () => {
  const f = fixture(), foreign = fixture(), marker = join(f.directory,'cross-directory');
  const target = join(foreign.sessionDir,'2020-01-01T00-00-00-000Z_cross-directory.jsonl');
  writeFileSync(target, `${JSON.stringify({type:'session',version:3,id:'cross-directory',timestamp:'2020-01-01T00:00:00.000Z',cwd:f.cwd})}\n`);
  utimesSync(target,new Date('2020-01-01'),new Date('2020-01-01'));
  const runtime = start({...f,testMarker:marker,testTarget:target});
  expect((await runtime.send('get_state')).success).toBe(true);
  const command = runtime.send('prompt',{message:'/retention-target pause'});
  await vi.waitFor(()=>expect(existsSync(marker)).toBe(true));
  const sweeper = await sweeperFor(foreign.sessionDir);
  try {
    await sweeper.runPass('periodic'); expect(existsSync(target)).toBe(true);
    // Ordinary startup in a different known session remains independent of the
    // global sweep barrier held by the mutable callback.
    const other = start(foreign);
    expect((await other.send('get_state')).success).toBe(true);
    writeFileSync(marker+'.continue','');
    expect((await command).success).toBe(true);
    expect((await runtime.send('get_state')).data.sessionFile).toBe(target);
    await expectWriterBusy(target);
    const barrier = await acquirePiSessionRebinding(); await barrier.release();
    await sweeper.runPass('periodic'); expect(existsSync(target)).toBe(true);
    const exited = once(runtime.child,'exit'); runtime.child.stdin!.end(); await exited;
    await sweeper.runPass('periodic'); expect(existsSync(target)).toBe(false);
  } finally { await sweeper.stop(); }
});

it('preserves native stale-context rejection during setup and releases rebinding', async () => {
  const f = fixture(), marker = join(f.directory,'nested-setup');
  const runtime = start({...f,testMarker:marker});
  expect((await runtime.send('get_state')).success).toBe(true);
  expect((await runtime.send('prompt',{message:'/retention-nested-setup'})).success).toBe(true);
  expect(runtime.frames.filter(frame=>frame.type==='extension_error')).toMatchObject([
    {error:expect.stringContaining('This extension ctx is stale after session replacement')},
  ]);
  expect(existsSync(marker)).toBe(false);
  const barrier = await acquirePiSessionRebinding(); await barrier.release();
  expect((await runtime.send('new_session')).success).toBe(true);
  const state = await runtime.send('get_state');
  await expectWriterBusy(state.data.sessionFile);
});

it.skipIf(process.platform === 'win32')('cleans the exact writer endpoint when an ordinary fixture is torn down', async () => {
  const runtime = start(fixture()), state = await runtime.send('get_state');
  const file = state.data.sessionFile as string;
  // Diagnose this one owned socket; never infer ownership from a shared-directory
  // diff or remove another runner's endpoints. These hashes mirror the gate's
  // named writer identity only for the filesystem leak assertion.
  const writer = createHash('sha256').update(basename(file)).digest('hex');
  const identity = createHash('sha256').update(`pi-session-writer:${writer}\0${realpathSync(dirname(file))}`).digest('hex');
  const endpoint = `/tmp/byok-pm-${process.getuid!()}/${identity}.sock`;
  expect(existsSync(endpoint)).toBe(true);
  await cleanupFixtures();
  expect(existsSync(endpoint), `owned writer endpoint remains after fixture close: ${endpoint}; session=${file}`).toBe(false);
});
