// Run with Bun: it loads the selected checkout's real W5 TypeScript modules.
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Transform } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BEFORE, SCHEMA, Recorder, digest, parseJson, validateProfile } from './evidence.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W5 = 'packages/client/src/__tests__/agent-memory-powercut';
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const load = (repo, file) => import(pathToFileURL(path.join(repo, file)).href);
const json = (file) => parseJson(readFileSync(file, 'utf8'), file);
const manifest = (repo) => json(path.join(repo, 'packages/client/dist/native/agent-memory-fs/manifest.json'));

function checkout(repo, role) {
  const revision = git(repo, 'rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/.test(revision) || (role === 'before' && revision !== BEFORE)
    || (role === 'after' && revision === BEFORE)) throw new Error('incorrect revision for role');
  if (git(repo, 'status', '--porcelain', '--untracked-files=no') !== '') throw new Error('revision checkout has tracked modifications');
  return revision;
}

// No VM power-control API is present. Only the owner cuts/restarts the VM.
class OwnerVmDriver {
  fault = 'power-loss';
  constructor(profile, listen, port, recorder, reconnectTimeoutMs) {
    this.storageProfile = { id: profile.id, description: JSON.stringify(profile), dropsUnflushedWrites: profile.dropsUnflushedWrites };
    this.recorder = recorder;
    this.reconnectTimeoutMs = reconnectTimeoutMs;
    this.console = createInterface({ input: process.stdin, output: process.stderr });
    this.server = net.createServer();
    this.server.listen(port, listen);
    this.listening = once(this.server, 'listening');
  }
  async start() {
    await this.listening;
    console.error('A7: start/reboot the disposable guest device now; waiting for its connection.');
    const connected = once(this.server, 'connection');
    const timer = setTimeout(() => this.server.emit('error', new Error(`guest boot timed out after ${this.reconnectTimeoutMs} ms`)), this.reconnectTimeoutMs);
    try { [this.socket] = await connected; } finally { clearTimeout(timer); }
    this.ended = once(this.socket, 'close').then(() => undefined);
    return { link: { input: this.socket, output: this.socket }, ended: this.ended };
  }
  async cut() {
    this.recorder.append({ kind: 'cut-request', instruction: 'owner VM power off; never guest shutdown/pause/suspend' });
    console.error('A7 CUT READY: owner must hard power off ONLY the disposable VM now.');
    const confirmation = await this.console.question('Once it is OFF, type CUT and press Enter before rebooting: ');
    if (confirmation !== 'CUT') throw new Error('owner did not confirm the completed VM power cut');
    this.recorder.append({ kind: 'cut-confirmed', confirmation });
    // A powered-off guest cannot FIN its TCP connection. Drop the Host side
    // only after the owner's explicit completed-cut observation.
    this.socket.destroy();
    await this.ended;
  }
  async stop() { await this.ended; }
  async close() { this.console.close(); this.socket?.destroy(); this.server.close(); }
}

export function observe(driver, recorder, expected) {
  let boot = -1;
  let cutting = false;
  let fail;
  const failure = new Promise((_resolve, reject) => { fail = reject; });
  failure.catch(() => {});
  return {
    failure,
    fault: driver.fault, storageProfile: driver.storageProfile,
    async start() {
      const currentBoot = ++boot;
      cutting = false;
      const run = await driver.start();
      let buffer = '';
      let identified = false;
      const input = new Transform({
        transform(chunk, _encoding, done) {
          buffer += chunk.toString();
          try {
            let index;
            while ((index = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, index);
              buffer = buffer.slice(index + 1);
              if (!line.startsWith('W5 ')) { this.push(`${line}\n`); continue; }
              const message = JSON.parse(line.slice(3));
              if (message.type === 'a7-identity') {
                if (identified || message.revision !== expected.revision || message.helperManifestDigest !== expected.helperManifestDigest
                  || message.osBuild !== expected.storageProfile.osBuild) throw new Error('device revision/helper/OS does not match Host metadata');
                identified = true;
                recorder.append({ ...message, kind: 'identity', boot: currentBoot });
              } else if (message.type === 'snapshot' || message.type === 'a7-cleanup') {
                if (!identified) throw new Error('device omitted revision identity');
                recorder.append({ kind: message.type === 'snapshot' ? 'snapshot' : 'cleanup', boot: currentBoot, snapshot: message.snapshot });
              }
              this.push(`${line}\n`);
            }
            done();
          } catch (error) {
            fail(error);
            run.link.input.unpipe(this);
            this.push(null);
            done();
          }
        },
        flush(done) {
          if (buffer.length !== 0 && !cutting) fail(new Error('truncated device message outside an intentional cut'));
          done();
        },
      });
      run.link.input.once('error', (error) => { if (!cutting) fail(error); input.end(); });
      run.link.input.once('close', () => input.end());
      run.link.input.pipe(input);
      return { ...run, link: { input, output: run.link.output } };
    },
    cut: () => { cutting = true; return driver.cut(); }, stop: () => driver.stop(), close: () => driver.close(),
  };
}

async function device(repo, store, connect, role) {
  const revision = checkout(repo, role);
  const { runDevice, powercutBackend } = await load(repo, `${W5}/device.ts`);
  const { takeDeviceSnapshot } = await load(repo, `${W5}/snapshot.ts`);
  const { AgentHomeManager, AgentHomeLeaseManager, stableAgentHomeOwnerId } = await load(repo, 'packages/client/src/agent-home.ts');
  const backend = powercutBackend(store);
  let socket;
  if (connect) {
    let target;
    try { target = new URL(`tcp://${connect}`); }
    catch (cause) { throw new Error('invalid private Host connection address', { cause }); }
    socket = net.connect({ host: target.hostname, port: Number(target.port) });
    await once(socket, 'connect');
  }
  const output = socket ?? process.stdout;
  const send = (message) => output.write(`W5 ${JSON.stringify(message)}\n`);
  send({ type: 'a7-identity', revision, helperManifestDigest: digest(manifest(repo)), osBuild: os.release() });
  await runDevice(store, { input: socket ?? process.stdin, output }, backend);
  // Only AFTER the last raw snapshot and recovery. Reopen every extant home
  // using the actual helper, including homes with no pending notice.
  const beforeCleanup = await takeDeviceSnapshot(store);
  const homes = new AgentHomeManager({ hostStorageRoot: store,
    leaseManager: new AgentHomeLeaseManager({ ownerId: stableAgentHomeOwnerId(store, 'byok-w5-powercut') }) });
  for (const home of beforeCleanup.homes) {
    const binding = await homes.acquire({ agentId: home.agentId, profileRevision: '1' });
    try {
      const filesystem = await backend.openFilesystem(binding.lease);
      await filesystem.close();
    } finally { await binding.lease.release(); }
  }
  const cleanup = { type: 'a7-cleanup', snapshot: await takeDeviceSnapshot(store) };
  await new Promise((resolve, reject) => output.write(`W5 ${JSON.stringify(cleanup)}\n`, (error) => error ? reject(error) : resolve()));
  socket?.end();
  // The W5 reader retains stdin after its stop message. Match its CLI's
  // explicit device exit, after the final evidence write has drained.
  process.exit(0);
}

async function run(config, configFile) {
  const repo = realpathSync(config.repo);
  const revision = checkout(repo, config.role);
  validateProfile(config.storageProfile);
  if (!['before', 'after'].includes(config.role)) throw new Error('role must be before or after');
  if (!['process-kill', 'owner-vm-power-cut'].includes(config.mode)) throw new Error('unknown mode');
  if (!Number.isSafeInteger(config.rounds) || config.rounds < 1 || config.rounds > 1000
    || !Number.isSafeInteger(config.seed) || config.seed < 1
    || !Number.isSafeInteger(config.maxDelayMs) || config.maxDelayMs < 1) throw new Error('invalid rounds, seed, or maxDelayMs');
  if (config.mode === 'owner-vm-power-cut' && (!Number.isSafeInteger(config.reconnectTimeoutMs)
    || config.reconnectTimeoutMs < 1 || config.reconnectTimeoutMs > 2_147_483_647)) {
    throw new Error('owner VM mode requires reconnectTimeoutMs in 1..2147483647');
  }
  const { ProcessKillDriver } = await load(repo, `${W5}/drivers.ts`);
  const { runExperiment } = await load(repo, `${W5}/experiment.ts`);
  const { HostJournal, PowercutHost } = await load(repo, `${W5}/host.ts`);
  const { powercutTriggers, describeTrigger } = { ...await load(repo, `${W5}/cli.ts`), ...await load(repo, `${W5}/experiment.ts`) };
  const triggers = powercutTriggers(config.rounds, config.seed, config.maxDelayMs);
  const helperManifest = manifest(repo);
  if (config.role === 'after' && helperManifest.protocol !== 4) throw new Error('after requires protocol-4 release assets');
  const metadata = { kind: 'metadata', schema: SCHEMA, before: BEFORE, role: config.role, revision,
    helperManifestDigest: digest(helperManifest), helperManifest, mode: config.mode, storageProfile: config.storageProfile,
    seed: config.seed, triggers: triggers.map(describeTrigger), host: { platform: process.platform, osBuild: os.release(), runtime: process.version },
    ownerAuthorization: config.ownerAuthorization ?? null,
    reconnectTimeoutMs: config.mode === 'owner-vm-power-cut' ? config.reconnectTimeoutMs : null };
  if (config.mode === 'owner-vm-power-cut' && (typeof config.ownerAuthorization !== 'string' || config.ownerAuthorization.trim() === '')) throw new Error('owner VM authorization reference is required');
  // Evidence directory is exclusive, preventing an accidental mixed/reused run.
  mkdirSync(config.output);
  writeFileSync(path.join(config.output, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  const recorder = new Recorder(path.join(config.output, 'evidence.jsonl'));
  recorder.append(metadata);
  class Journal extends HostJournal {
    append(entry) { recorder.append({ kind: 'journal', entry }); super.append(entry); }
  }
  let raw;
  if (config.mode === 'process-kill') {
    mkdirSync(config.store); // must not already exist
    raw = new ProcessKillDriver({ command: process.execPath, args: [path.join(HERE, 'run.mjs'), 'device', '--config', configFile] });
  } else raw = new OwnerVmDriver(config.storageProfile, config.listen, config.port, recorder, config.reconnectTimeoutMs);
  const driver = observe(raw, recorder, metadata);
  try {
    console.error(config.mode === 'process-kill' ? 'HARNESS VALIDATION ONLY — NOT A7' : 'OWNER VM RUN — recorded storage profile only');
    const report = await Promise.race([
      runExperiment({ driver, host: new PowercutHost({ seed: config.seed, intentsPerHome: 12, journal: new Journal() }), triggers }),
      driver.failure,
    ]);
    recorder.append({ kind: 'report', report });
    console.log(JSON.stringify({ stoppedEarly: report.stoppedEarly, violations: report.violations, cuts: report.cuts.length, windows: report.windows, windowsKills: raw.windowsKills }));
    if (report.stoppedEarly || report.violations) process.exitCode = 1;
  } finally {
    await driver.close();
    recorder.close();
    if (raw.stderr?.length) console.error(raw.stderr.join('\n'));
  }
}

function prepare(repo, afterRef, output) {
  const after = git(repo, 'rev-parse', `${afterRef}^{commit}`);
  if (after === BEFORE) throw new Error('after must differ from before');
  mkdirSync(output);
  for (const [role, sha] of [['before', BEFORE], ['after', after]]) {
    const target = path.join(output, role);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', target, sha], { stdio: 'inherit' });
    for (const args of [['ci'], ['run', 'build'], ['run', '--filter', '@byok-sdk/client', 'build:agent-memory-helper']]) {
      execFileSync('bun', args, { cwd: target, stdio: 'inherit' });
    }
    writeFileSync(path.join(output, `${role}.json`), JSON.stringify({ role, revision: sha, repo: target, helperManifestDigest: digest(manifest(target)) }, null, 2));
  }
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === 'prepare' && args.length === 3) return prepare(realpathSync(args[0]), args[1], path.resolve(args[2]));
  const { values } = parseArgs({ args, options: { config: { type: 'string' } } });
  if (!values.config) throw new Error('usage: bun run.mjs prepare <repo> <after-ref> <new-output-dir> | run|device --config <file.json>');
  const configFile = realpathSync(values.config);
  const config = json(configFile);
  if (command === 'run') await run(config, configFile);
  else if (command === 'device') await device(realpathSync(config.repo), realpathSync(config.store), config.connect, config.role);
  else throw new Error('command must be prepare, run or device');
}
if (import.meta.main) await main(process.argv.slice(2));
