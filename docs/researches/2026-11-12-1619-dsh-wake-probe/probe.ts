import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshSession } from '../../../packages/client/vendor/oar/ac7fde4/runtimes/dsh/session.js';
import { dshPatch, dshEnvironment } from '../../../packages/client/src/adapters/dsh/dsh-profile.js';
import { QUALIFIED_DSH_VERSION } from '../../../packages/client/src/adapters/dsh/dsh-version.js';
import { startLoopbackProvider, startEgressRecorder } from '../../../packages/client/src/__tests__/runtime-contract/loopback.js';

// Research only. Run from the repo root with Bun; no adapter and no real provider.
const bin = process.argv[2] ?? '/opt/homebrew/bin/dsh';
const parent = path.resolve('_ops');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(path.join(parent, '1619-dsh-wake-probe-'));
const output = path.dirname(fileURLToPath(import.meta.url));
const recorder = await startEgressRecorder();
const home = path.join(root, 'home');
const temp = path.join(root, 'tmp');
for (const directory of [home, temp]) mkdirSync(directory, { recursive: true });
const base = {
  PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, USERPROFILE: home,
  TMPDIR: temp, LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
  XDG_CACHE_HOME: path.join(home, '.cache'), ...recorder.env,
};
const env = dshEnvironment(base, path.join(root, 'dsh'), 'danger-full-access');
mkdirSync(env.DSH_AGENTS_HOME, { recursive: true });
const version = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 30_000 });
if (version.status !== 0 || version.stdout.trim() !== QUALIFIED_DSH_VERSION) {
  throw new Error(`qualified version mismatch: ${version.status}; ${version.stdout}; ${version.stderr}`);
}
console.log(`DSH ${version.stdout.trim()}`);
const init = spawnSync(bin, ['--profile', 'acp', '--help'], { env, encoding: 'utf8', timeout: 30_000 });
if (init.status !== 0) throw new Error(`profile init failed: ${init.stderr}`);

const summaries = [];
try {
  for (const name of ['background-job', 'background-subagent', 'job-kill', 'job-output-wait', 'two-background-jobs']) {
    const directory = path.join(root, name);
    const workspace = path.join(directory, 'workspace');
    const launch = path.join(directory, 'launch');
    for (const dir of [workspace, launch]) mkdirSync(dir, { recursive: true });
    const release = path.join(workspace, 'release');
    const hold = `until [ -f '${release}' ]; do sleep 0.05; done; echo probe-finished`;
    const records: any[] = [];
    const wire: string[] = [];
    let rootId = '';
    let jobId = '';
    let rootEnds = 0;
    let settled = 0;
    let untaggedTurnActive = 0;
    let completionTurnActive = 0;
    const selected = path.join(output, `${name}.jsonl`);
    writeFileSync(selected, '');
    let resolveReady!: () => void;
    const ready = new Promise<void>(resolve => { resolveReady = resolve; });
    const provider = await startLoopbackProvider('openai-chat', request => {
      const text = { kind: 'text' as const, chunks: ['probe complete'] };
      if (!request.model) return text;
      const tool = (name: string, args: Record<string, unknown>) => {
        const found = request.tools.find(candidate => candidate.name === name);
        if (!found) throw new Error(`tool ${name} unavailable`);
        return { kind: 'tool' as const, tool: found, args };
      };
      // Child prompts omit ROOT-PROBE; the child's shell is held until root end.
      if (!request.text.includes('ROOT-PROBE')) {
        return request.toolResults === 0 ? tool('bash', { command: hold, description: 'Probe child barrier' }) : text;
      }
      if (rootEnds > 0) return text;
      if (request.toolResults === 0) {
        return name === 'background-subagent'
          ? tool('subagent', { description: 'Probe background child', prompt: 'CHILD-PROBE: run the shell barrier, then finish.' })
          : tool('bash', { command: hold, description: 'Probe background job', run_in_background: true });
      }
      if (request.toolResults === 1) {
        if (name === 'job-kill') return tool('job_kill', { job_id: jobId, reason: 'probe cancellation' });
        if (name === 'job-output-wait') return tool('job_output', { job_id: jobId, wait: true, timeout_ms: 10_000 });
        if (name === 'two-background-jobs') return tool('bash', { command: hold, description: 'Probe second background job', run_in_background: true });
      }
      return text;
    });
    let child: ReturnType<typeof spawn> | undefined;
    const spawnLine = (command: string, args: readonly string[], options: any) => {
      child = spawn(command, [...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      const owned = child;
      const handlers: ((line: string) => void)[] = [];
      const exitHandlers: ((code: number | null) => void)[] = [];
      const spawned = new Promise<void>((resolve, reject) => { owned.once('spawn', resolve); owned.once('error', reject); });
      const exited = new Promise<number | null>(resolve => owned.once('exit', (code: number | null) => { exitHandlers.forEach(fn => fn(code)); resolve(code); }));
      createInterface({ input: owned.stdout!, crlfDelay: Infinity }).on('line', (line: string) => {
        wire.push(line);
        handlers.forEach(fn => fn(line));
      });
      let stderr = '';
      owned.stderr!.on('data', (chunk: Buffer) => { stderr += chunk; });
      owned.once('exit', () => writeFileSync(path.join(directory, 'stderr.log'), stderr));
      return {
        spawned, exited, onLine: (fn: (line: string) => void) => { handlers.push(fn); },
        onExit: (fn: (code: number | null) => void) => { exitHandlers.push(fn); },
        write: (text: string) => { owned.stdin!.write(text); },
        writeAcknowledged: (text: string) => new Promise<void>((resolve, reject) => { owned.stdin!.write(text, (error?: Error | null) => error ? reject(error) : resolve()); }),
        observeDescendants() {}, kill: () => { owned.kill('SIGKILL'); },
      };
    };
    const patch = path.join(launch, 'model.patch.json');
    writeFileSync(patch, dshPatch({ provider: 'custom', model: 'contract-model', baseUrl: provider.baseUrl, keyEnv: 'RC_CONTRACT_MODEL_KEY' }));
    let session;
    try {
      session = await dshSession(spawnLine, { kind: 'available', via: 'executable', command: bin }, {
        cwd: workspace, model: 'byok-custom/contract-model',
        launch: { directory: launch, patches: [patch], env: { ...env, RC_CONTRACT_MODEL_KEY: 'runtime-contract-placeholder' } },
      }, {
        onReady: id => { rootId = id; },
        onRecord: record => {
          records.push(record);
          const body = (record as any).body;
          if (!body) return;
          const events = body.events ?? [];
          const root = record.sessionId === rootId;
          const nativeType = body.native?.type;
          if (/^(session\/event:(turn\/|job\/|tool\/|agent\/inbox\/)|subagent\/|agent\/status|agent\/error)/.test(body.type ?? '')) {
            appendFileSync(selected, JSON.stringify(record) + '\n');
          }
          if (root && nativeType === 'job/registered') jobId = body.native.data.jobId;
          if (root && events.some((event: any) => event.kind === 'task_ended')) settled++;
          for (const event of events) {
            if (root && event.kind === 'turn_active') {
              if (event.inputId === undefined) untaggedTurnActive++;
              else if (event.inputId !== 'probe-input') completionTurnActive++;
            }
          }
          if (root && events.some((event: any) => event.kind === 'turn_ended')) {
            rootEnds++;
            if (rootEnds === 1 && name !== 'job-kill' && name !== 'job-output-wait') writeFileSync(release, 'root ended\n');
          }
          if (root && nativeType === 'tool/call' && body.native.data.name === 'job_output') {
            // Release only after the real tool starts; let wait:true observe completion.
            setTimeout(() => writeFileSync(release, 'wait tool started\n'), 100);
          }
          const expected = name === 'two-background-jobs' ? 2 : 1;
          if (settled >= expected && rootEnds >= 1) resolveReady();
        },
      });
      const result = await session.prompt('ROOT-PROBE: execute the scripted background work.', { inputId: 'probe-input' });
      if (result.response.body.kind !== 'accepted') throw new Error(JSON.stringify(result));
      // Bounded measurement only: a timeout NEVER establishes that no wake will follow.
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([ready, new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error('case observation timed out')), 30_000); })]);
      } finally {
        clearTimeout(watchdog);
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
      summaries.push({ case: name, rootId, rootEnds, settled, untaggedTurnActive, completionTurnActive, records: records.length, observationEndSeq: records.at(-1)?.seq, providerRequests: provider.requests.filter(request => request.model).length });
      console.log(JSON.stringify(summaries.at(-1)));
    } finally {
      await session?.dispose();
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      writeFileSync(path.join(directory, 'kernel.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
      writeFileSync(path.join(directory, 'wire.jsonl'), wire.join('\n') + '\n');
      await provider.close();
    }
  }
} finally {
  writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ version: QUALIFIED_DSH_VERSION, summaries, egress: recorder.attempts }, null, 2) + '\n');
  await recorder.close();
}
