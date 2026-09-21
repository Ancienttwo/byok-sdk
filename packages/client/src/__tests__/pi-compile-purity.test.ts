import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPiInputPreparationCompiler,
  resolveInstalledPiRuntimeIdentity,
} from '../adapters/pi/input-preparation';
import { preparedCompileRequest } from './fixtures/prepared-compile-snapshot';

/**
 * CALL-TIME purity of the prepared compile, measured where it can actually be
 * seen.
 *
 * The check this replaces replaced methods on the DEFAULT `node:fs` /
 * `node:child_process` / `node:net` module objects inside the vitest worker,
 * AFTER the fork's graph had been loaded, and never called
 * `module.syncBuiltinESMExports()`. The fork's helpers bind NAMED imports
 * (`dist/config.js:1`, `dist/core/skills.js:1`, `dist/utils/paths.js:1`,
 * `dist/utils/child-process.js:1`), which resolve through the builtin's ESM
 * namespace, so a read made through exactly the helpers 0.86 pulled into the
 * compile graph was invisible to it. Its environment check compared
 * `JSON.stringify(process.env)` before and after, which detects a WRITE and
 * never a READ.
 *
 * `fixtures/pi-compile-purity-probe.mjs` is the measurement half: a child
 * process that installs its monitors, republishes them with
 * `module.syncBuiltinESMExports()`, replaces `process.env` with a recording
 * Proxy, and only then imports the installed fork by the same specifier
 * `adapters/pi/input-preparation.ts` uses. It reports three phases separately —
 * cold module load, first compile, second compile — and this file asserts on
 * the report.
 *
 * What the gate is worth is established by the three NEGATIVE CONTROLS below.
 * Each rewrites, in memory only, a module the compile really executes so that
 * it reads a canary file through a named `node:fs` import, reads a fixture
 * environment variable, or spawns a process and opens a socket. All three must
 * show up in the report, attributed to that file, or the gate proves nothing.
 *
 * No network, no provider, no credential: the probe's only child process is
 * `node -e ""` inside one control, and its only socket is a refused loopback
 * connection to port 1.
 */

const PROBE = fileURLToPath(new URL('./fixtures/pi-compile-purity-probe.mjs', import.meta.url));
const CLIENT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Obviously fake. Nothing here is a credential and nothing is sent anywhere. */
const CANARY_ENV_KEY = 'BYOK_PURITY_FIXTURE_CANARY';

interface ProbeEvent {
  readonly phase: string;
  readonly kind: 'fs' | 'process' | 'network' | 'ambient';
  readonly api: string;
  readonly detail: string;
  readonly origin: string;
  readonly source: 'fork' | 'dependency' | 'runtime' | 'other';
  readonly count: number;
}

interface ProbeEnvEvent {
  readonly phase: string;
  readonly key: string;
  readonly via: string;
  readonly origin: string;
  readonly source: 'fork' | 'dependency' | 'runtime' | 'other';
  readonly count: number;
}

interface ProbePhase {
  readonly events: ProbeEvent[];
  readonly envReads: ProbeEnvEvent[];
  readonly envWrites: ProbeEnvEvent[];
}

interface ProbeReport {
  readonly mode: string;
  readonly node: string;
  readonly failure: string | null;
  readonly requestBody?: string;
  readonly warmRequestBody?: string;
  readonly envelopeDigest?: string;
  readonly load: ProbePhase;
  readonly compileCold: ProbePhase;
  readonly compileWarm: ProbePhase;
  readonly setupEnvWrites: ProbeEnvEvent[];
  readonly control: { fs: string | null; env: string | null };
}

interface ProbeRun {
  readonly report: ProbeReport;
  readonly canaryValue: string;
  readonly ambientRoot: string;
  readonly exitCode: number | null;
  readonly stderr: string;
}

const temporaryRoots: string[] = [];

/**
 * The baseline environment: nothing set that the fork could take as an
 * override, but `HOME` still points at a throwaway directory full of canaries,
 * so "the fork read nothing under the home directory" is a measured fact
 * rather than a fact about the developer's machine.
 */
function baselineEnvironment(root: string, canaryValue: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: path.join(root, 'home'),
    [CANARY_ENV_KEY]: canaryValue,
  };
}

/**
 * One poisoned ambient environment.
 *
 * Every variable that could steer the fork's own discovery is pointed at a
 * throwaway directory that really exists and really holds canary content:
 * `HOME`/`USERPROFILE` and the XDG pair for home discovery, `PI_PACKAGE_DIR`
 * for `getPackageDir()`, `PI_CODING_AGENT_DIR` (`config.js:406`, the agent-dir
 * variable `getAgentDir()` reads) for the config/credential directory, plus
 * the proxy variables and obviously fake key-shaped names. `NODE_OPTIONS` is
 * deliberately NOT set: how the child was started is what the measurement
 * itself rests on.
 */
function ambientEnvironment(root: string, canaryValue: string): NodeJS.ProcessEnv {
  const home = path.join(root, 'home');
  return {
    ...baselineEnvironment(root, canaryValue),
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    PI_PACKAGE_DIR: path.join(root, 'pi-package'),
    PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'),
    PI_CACHE_RETENTION: '1h',
    HTTP_PROXY: 'http://127.0.0.1:1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: 'nowhere.invalid',
    OPENAI_API_KEY: `not-a-real-key-${canaryValue}`,
    ANTHROPIC_API_KEY: `not-a-real-key-${canaryValue}`,
    ZAI_API_KEY: `not-a-real-key-${canaryValue}`,
  };
}

/** A throwaway home whose every plausible discovery target holds the canary. */
function seedAmbientRoot(label: string, canaryValue: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `pi-purity-${label}-`));
  temporaryRoots.push(root);
  const home = path.join(root, 'home');
  const agentDir = path.join(home, '.pi', 'agent');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(path.join(home, '.config'), { recursive: true });
  mkdirSync(path.join(root, 'pi-package'), { recursive: true });
  writeFileSync(path.join(home, 'private-canary.txt'), canaryValue, 'utf8');
  for (const name of ['auth.json', 'models.json', 'settings.json']) {
    writeFileSync(path.join(agentDir, name), JSON.stringify({ canary: canaryValue }), 'utf8');
  }
  // A package manifest at the overridden package dir, so `getPackageDir()`
  // taking the override is a fact with visible consequences (`APP_NAME`,
  // `CONFIG_DIR_NAME` and the agent-dir variable name are all derived from it)
  // rather than a silent ENOENT.
  writeFileSync(
    path.join(root, 'pi-package', 'package.json'),
    JSON.stringify({ name: `canary-${canaryValue}`, version: '9.9.9', piConfig: { name: canaryValue } }),
    'utf8',
  );
  return root;
}

async function runProbe(
  mode: string,
  label: string,
  canaryValue: string,
  ambient: 'baseline' | 'poisoned' = 'baseline',
): Promise<ProbeRun> {
  const ambientRoot = seedAmbientRoot(label, canaryValue);
  const reportPath = path.join(ambientRoot, 'report.json');
  const configPath = path.join(ambientRoot, 'probe-config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mode,
      reportPath,
      canaryFile: path.join(ambientRoot, 'home', 'private-canary.txt'),
      canaryEnvKey: CANARY_ENV_KEY,
    }),
    'utf8',
  );

  const child = spawn(process.execPath, [PROBE, configPath], {
    cwd: CLIENT_ROOT,
    env:
      ambient === 'poisoned'
        ? ambientEnvironment(ambientRoot, canaryValue)
        : baselineEnvironment(ambientRoot, canaryValue),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.resume();

  // Child exit is the completion signal — there is nothing to sleep on.
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  if (exitCode !== 0) throw new Error(`probe ${mode} exited ${String(exitCode)}: ${stderr}`);
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as ProbeReport;
  return { report, canaryValue, ambientRoot, exitCode, stderr };
}

const forkEvents = (phase: ProbePhase): ProbeEvent[] => phase.events.filter((event) => event.source === 'fork');
const forkEnvReads = (phase: ProbePhase): ProbeEnvEvent[] =>
  phase.envReads.filter((event) => event.source === 'fork');

/** Everything reported for a phase, in the shape the assertions compare. */
function purityViolations(phase: ProbePhase): unknown[] {
  return [
    ...phase.events.map((event) => ({ api: event.api, detail: event.detail, origin: event.origin })),
    ...phase.envReads
      .filter((event) => event.source !== 'runtime')
      .map((event) => ({ api: 'process.env', detail: event.key, origin: event.origin })),
    ...phase.envWrites.map((event) => ({ api: 'process.env=', detail: event.key, origin: event.origin })),
  ];
}

let clean: ProbeRun;
let ambientA: ProbeRun;
let ambientB: ProbeRun;
let controlFs: ProbeRun;
let controlEnv: ProbeRun;
let controlCapability: ProbeRun;

// One generous budget for six child processes that each load the fork's whole
// module graph. The suite's default is 10s and this file is not the place to
// add a second load-sensitive deadline.
const PROBE_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  [clean, ambientA, ambientB, controlFs, controlEnv, controlCapability] = await Promise.all([
    runProbe('clean', 'clean', 'CANARY-CLEAN'),
    runProbe('clean', 'ambient-a', 'CANARY-AMBIENT-A', 'poisoned'),
    runProbe('clean', 'ambient-b', 'CANARY-AMBIENT-B', 'poisoned'),
    runProbe('control-fs', 'control-fs', 'CANARY-CONTROL-FS'),
    runProbe('control-env', 'control-env', 'CANARY-CONTROL-ENV'),
    runProbe('control-capability', 'control-capability', 'CANARY-CONTROL-CAP'),
  ]);
}, PROBE_TIMEOUT_MS);

afterAll(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe('B-P2 native composition: call-time purity, measured in an isolated child process', () => {
  it('compiles the same bytes the SDK compile path produces, so the gate measures the real request', async () => {
    // The probe states the fork's input by hand, because it runs as plain Node
    // with no TypeScript loader. This is the pin that keeps that restatement
    // honest: the body it produced and the body `adapters/pi/input-preparation.ts`
    // produces from the SHARED fixture are the same bytes, so a drift between
    // the two makes this fail rather than quietly moving what is measured.
    const compiler = createPiInputPreparationCompiler(resolveInstalledPiRuntimeIdentity());
    const compiled = await compiler.compile(preparedCompileRequest());

    expect(clean.report.failure).toBeNull();
    expect(clean.report.requestBody).toBe(compiled.requestBody);
    expect(clean.report.warmRequestBody).toBe(compiled.requestBody);
  });

  it('touches no filesystem, process, network or ambient surface during either compile call', () => {
    // The whole point of the gate, and the assertion the in-process trap could
    // not make: monitors installed BEFORE the fork's graph exists, republished
    // into the builtin ESM namespaces, so a call through a named import is
    // seen. Cold and warm are separate because a compiler that caches an
    // ambient read on the first call would look pure on the second.
    expect(purityViolations(clean.report.compileCold)).toEqual([]);
    expect(purityViolations(clean.report.compileWarm)).toEqual([]);
  });

  it('reads no environment variable during either compile call', () => {
    // The allowlist is EMPTY, and it is empty because the measurement says so,
    // not because nothing was looked for: the recording Proxy sees `get`, `in`
    // and `ownKeys` on `process.env`, and the fork's one real environment read
    // (`PI_PACKAGE_DIR`) happens at module load, never at compile time.
    const ALLOWED_COMPILE_ENV_READS: string[] = [];

    for (const phase of [clean.report.compileCold, clean.report.compileWarm]) {
      expect(phase.envReads.filter((event) => event.source !== 'runtime')).toEqual([]);
      expect(phase.envReads.map((event) => event.key)).toEqual(ALLOWED_COMPILE_ENV_READS);
      expect(phase.envWrites).toEqual([]);
    }
  });

  it('observes the cold load, and every touch it makes is on the allowlist', () => {
    const load = clean.report.load;

    // Node 22/24 load module sources through the PUBLIC `fs` API, so the load
    // phase is dominated by the ESM loader's own reads. They are separated by
    // stack origin rather than by guesswork: `fork:` is the fork's own
    // top-level code, everything else is the loader or a dependency.
    //
    // The allowlist for the fork's own load-time I/O, by path pattern:
    //
    //  - `existsSync(<installed package>/**/package.json)` at `config.js:298`
    //    — `findNodePackageDir` walking up from `dist/` to find the package it
    //    was installed as. Both probes are inside the installed package.
    //  - `readFileSync(<installed package>/package.json)` at `config.js:392`
    //    — reading its OWN manifest for `name`/`version`/`piConfig`. Reading
    //    the installed artifact's identity is the one legitimate load-time
    //    read, and it is the same file `resolveInstalledPiRuntimeIdentity()`
    //    cross-checks the pin against.
    //
    // Nothing under a home directory, an agent directory, a config directory
    // or a credential location is allowed, and the run that produced this
    // report had all of those pointed at a temp dir full of canaries.
    expect(forkEvents(load).map((event) => ({ api: event.api, origin: event.origin }))).toEqual([
      { api: 'fs.existsSync', origin: 'fork:dist/config.js:298:13' },
      { api: 'fs.existsSync', origin: 'fork:dist/config.js:298:13' },
      { api: 'fs.readFileSync', origin: 'fork:dist/config.js:392:31' },
    ]);
    for (const event of forkEvents(load)) {
      expect({ origin: event.origin, basename: path.basename(event.detail) }).toEqual({
        origin: event.origin,
        basename: 'package.json',
      });
      expect(event.detail.includes(`${path.sep}node_modules${path.sep}`)).toBe(true);
      expect(event.detail.startsWith(clean.ambientRoot)).toBe(false);
    }

    // No path any actor read during the load lies outside an installed
    // package, so the loader half of the phase is module loading and nothing
    // else.
    const paths = load.events.map((event) => event.detail).filter((detail) => !detail.startsWith('<'));
    expect(paths.filter((detail) => !detail.includes('/node_modules/'))).toEqual([]);

    // A capability taken at import time would be an import-time effect, not a
    // read: none is taken.
    expect(load.events.filter((event) => event.kind !== 'fs')).toEqual([]);
    expect(load.envWrites).toEqual([]);
    expect(clean.report.setupEnvWrites).toEqual([]);

    // The environment-read allowlist for the load phase, by (key, origin):
    //
    //  - `PI_PACKAGE_DIR` at `config.js:313` — the documented override for
    //    `getPackageDir()`. It can change which package manifest the fork
    //    reads its own identity from; it cannot reach D, which is proved by
    //    the ambient-independence case below rather than argued here.
    //  - `OSTYPE` twice at `which/which.js:2-3` — `cross-spawn`'s `which`,
    //    deciding at module scope whether it is on Windows. Reached because
    //    the prompt builder's closure includes `utils/child-process.js`.
    //
    // Everything else the phase records is the runtime's own
    // (`WATCH_REPORT_DEPENDENCIES`, `NODE_V8_COVERAGE`, read by the ESM loader
    // for every module it loads).
    expect(
      load.envReads
        .filter((event) => event.source !== 'runtime')
        .map((event) => ({ key: event.key, origin: event.origin })),
    ).toEqual([
      { key: 'OSTYPE', origin: 'dep:which/which.js:2:17' },
      { key: 'OSTYPE', origin: 'dep:which/which.js:3:17' },
      { key: 'PI_PACKAGE_DIR', origin: 'fork:dist/config.js:313:32' },
    ]);
  });

  it('is independent of the ambient environment: two poisoned homes compile identical bytes', () => {
    // Same explicit input, two throwaway homes with different canaries in
    // every location the fork could discover: HOME/USERPROFILE, the XDG pair,
    // PI_PACKAGE_DIR, the agent dir, proxy variables and fake key names.
    expect(ambientA.report.failure).toBeNull();
    expect(ambientB.report.failure).toBeNull();
    expect(ambientA.report.requestBody).toBe(clean.report.requestBody);
    expect(ambientB.report.requestBody).toBe(clean.report.requestBody);
    expect(ambientB.report.envelopeDigest).toBe(ambientA.report.envelopeDigest);

    // Not only equal — free of the ambient values. Equality alone would still
    // hold if both runs leaked the same shaped path.
    for (const run of [ambientA, ambientB]) {
      const body = run.report.requestBody ?? '';
      expect(body.includes(run.canaryValue)).toBe(false);
      expect(body.includes(run.ambientRoot)).toBe(false);
      expect(body.includes(tmpdir())).toBe(false);
      expect(purityViolations(run.report.compileCold)).toEqual([]);
      expect(purityViolations(run.report.compileWarm)).toEqual([]);

      // Nothing under the poisoned home is opened in ANY phase, load
      // included: not the home itself, not `.pi/agent/auth.json`, not the XDG
      // directories. `PI_PACKAGE_DIR` is the one override the fork does honour
      // at load — it reads the manifest there instead of its own, and calls
      // `os.homedir()` while expanding a leading `~` in it
      // (`utils/paths.js:70`) — and that changes no byte of D.
      const home = path.join(run.ambientRoot, 'home');
      const phases = [run.report.load, run.report.compileCold, run.report.compileWarm];
      expect(phases.flatMap((phase) => phase.events).filter((event) => event.detail.startsWith(home))).toEqual([]);
      expect(
        forkEvents(run.report.load).map((event) => ({
          api: event.api,
          origin: event.origin,
          underOverride: event.detail.startsWith(path.join(run.ambientRoot, 'pi-package')),
        })),
      ).toEqual([
        { api: 'os.homedir', origin: 'fork:dist/utils/paths.js:70:41', underOverride: false },
        { api: 'fs.readFileSync', origin: 'fork:dist/config.js:392:31', underOverride: true },
      ]);
    }
  });
});

describe('B-P2 native composition: the purity gate is falsifiable', () => {
  // Each control rewrites `dist/core/system-prompt.js` in memory through a
  // `module.registerHooks` load hook — available on the pinned Node (>= 22.15;
  // `.node-version` is 22.22.3 and `engines.node` is >= 22.22.0), synchronous,
  // and touching nothing on disk. The file is on the real compile path because
  // `dist/core/input-preparation.js` calls `buildSystemPrompt(copied.prompt)`,
  // and the control firing during `compileCold` is what proves it.

  it('sees a canary read made through a NAMED node:fs import inside the compile', () => {
    // The exact shape the in-process trap was blind to. `control.fs` carrying
    // the canary content proves the read really happened, and the recorded
    // event proves the gate saw it.
    expect(controlFs.report.control.fs).toBe(controlFs.canaryValue);
    expect(
      forkEvents(controlFs.report.compileCold).map((event) => ({
        api: event.api,
        origin: event.origin,
        canary: event.detail.endsWith('private-canary.txt'),
      })),
    ).toEqual([
      { api: 'fs.readFileSync', origin: 'fork:dist/core/system-prompt.js:163:42', canary: true },
    ]);
    expect(purityViolations(controlFs.report.compileCold)).not.toEqual([]);
  });

  it('sees an environment read made inside the compile', () => {
    expect(controlEnv.report.control.env).toBe(controlEnv.canaryValue);
    expect(
      forkEnvReads(controlEnv.report.compileCold).map((event) => ({ key: event.key, origin: event.origin })),
    ).toEqual([{ key: CANARY_ENV_KEY, origin: 'fork:dist/core/system-prompt.js:163:54' }]);
    expect(purityViolations(controlEnv.report.compileCold)).not.toEqual([]);
  });

  it('sees a process spawn and a socket opened inside the compile', () => {
    // `node -e ""` and a connection to loopback port 1, both guarded so that
    // an absent monitor still does nothing real.
    expect(
      forkEvents(controlCapability.report.compileCold).map((event) => ({ kind: event.kind, api: event.api })),
    ).toEqual([
      { kind: 'process', api: 'child_process.spawnSync' },
      { kind: 'network', api: 'net.connect' },
    ]);
    expect(purityViolations(controlCapability.report.compileCold)).not.toEqual([]);
  });

  it('proves purity for none of the three controls, and for the clean run', () => {
    // The predicate the gate exists to compute, stated once over all four runs.
    const pure = (run: ProbeRun): boolean => purityViolations(run.report.compileCold).length === 0;
    expect({
      clean: pure(clean),
      controlFs: pure(controlFs),
      controlEnv: pure(controlEnv),
      controlCapability: pure(controlCapability),
    }).toEqual({ clean: true, controlFs: false, controlEnv: false, controlCapability: false });
  });
});
