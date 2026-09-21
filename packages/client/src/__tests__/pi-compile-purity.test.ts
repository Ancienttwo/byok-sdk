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

interface ProbeNondeterminismEvent {
  readonly phase: string;
  readonly api: string;
  readonly origin: string;
  readonly source: 'fork' | 'dependency' | 'runtime' | 'other';
  readonly count: number;
}

interface ProbeMonitorGap {
  readonly target: string;
  readonly key: string;
  readonly api: string;
  readonly reason?: string;
  readonly error?: string;
}

interface ProbePhase {
  readonly events: ProbeEvent[];
  readonly envReads: ProbeEnvEvent[];
  readonly envWrites: ProbeEnvEvent[];
  readonly nondeterminism: ProbeNondeterminismEvent[];
}

interface ProbeReport {
  readonly mode: string;
  readonly skew: string | null;
  readonly node: string;
  readonly nodeMajor: number;
  readonly failure: string | null;
  readonly monitorInstallFailures: ProbeMonitorGap[];
  readonly monitorsAbsent: ProbeMonitorGap[];
  readonly requestBody?: string;
  readonly warmRequestBody?: string;
  readonly envelopeDigest?: string;
  readonly load: ProbePhase;
  readonly compileCold: ProbePhase;
  readonly compileWarm: ProbePhase;
  readonly setupEnvWrites: ProbeEnvEvent[];
  readonly control: { fs: string | null; env: string | null; envDescriptor: string | null };
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
function ambientEnvironment(
  root: string,
  canaryValue: string,
  cacheRetention: 'long' | 'short',
): NodeJS.ProcessEnv {
  const home = path.join(root, 'home');
  return {
    ...baselineEnvironment(root, canaryValue),
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    PI_PACKAGE_DIR: path.join(root, 'pi-package'),
    PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'),
    // `long` and `short` are the two values the fork's cache-retention setting
    // actually discriminates on, one in each poisoned run. A value it cannot
    // parse would be inert and would poison nothing. Independence is still
    // established by the zero-env-read assertion rather than by the pair being
    // different: what this makes impossible is a silent agreement in which
    // both runs read the variable and both fall back to the same default.
    PI_CACHE_RETENTION: cacheRetention,
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

interface ProbeOptions {
  /** One of the poisoned ambient environments, each with its own retention value. */
  readonly ambient?: 'long' | 'short';
  /** Forces the clock and every generator to a fixed, far-apart set of values. */
  readonly skew?: 'a' | 'b';
}

async function runProbe(
  mode: string,
  label: string,
  canaryValue: string,
  { ambient, skew }: ProbeOptions = {},
): Promise<ProbeRun> {
  const ambientRoot = seedAmbientRoot(label, canaryValue);
  const reportPath = path.join(ambientRoot, 'report.json');
  const configPath = path.join(ambientRoot, 'probe-config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mode,
      skew: skew ?? null,
      reportPath,
      canaryFile: path.join(ambientRoot, 'home', 'private-canary.txt'),
      canaryEnvKey: CANARY_ENV_KEY,
    }),
    'utf8',
  );

  const child = spawn(process.execPath, [PROBE, configPath], {
    cwd: CLIENT_ROOT,
    env:
      ambient === undefined
        ? baselineEnvironment(ambientRoot, canaryValue)
        : ambientEnvironment(ambientRoot, canaryValue, ambient),
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

/**
 * Everything reported for a phase, in the shape the assertions compare.
 *
 * Every environment read falsifies, whatever its stack origin. The `runtime`
 * class is a statement about which FRAME made the call, not about whether the
 * value can reach D: the ESM loader reading `NODE_V8_COVERAGE` while loading a
 * module the compile pulled in is still an ambient value entering the compile
 * phase. Dropping that class would have made the predicate weaker than the
 * assertion beside it, and the measurement says the compile phases contain
 * zero reads of ANY class, so keeping them costs nothing that was ever true.
 *
 * Clock and generator reads are deliberately NOT here: they reach no ambient
 * configuration, and the claim they threaten — determinism — is asserted by
 * `ALLOWED_COMPILE_NONDETERMINISM` and the forced-skew pair instead.
 */
function purityViolations(phase: ProbePhase): unknown[] {
  return [
    ...phase.events.map((event) => ({ api: event.api, detail: event.detail, origin: event.origin })),
    ...phase.envReads.map((event) => ({ api: 'process.env', detail: event.key, origin: event.origin })),
    ...phase.envWrites.map((event) => ({ api: 'process.env=', detail: event.key, origin: event.origin })),
  ];
}

/** The origin's file, without the line and column that a fork bump moves. */
const originFile = (origin: string): string => origin.replace(/:\d+:\d+$/u, '');

/**
 * Clock and generator reads permitted inside a compile phase, by
 * `(api, origin-file)`.
 *
 * It is EMPTY on fork build `0.86.1001`, and empty is what the run reports
 * rather than what was hoped for: the compile calls `buildRequestPayload`, and
 * the one `Date.now()` on the provider path —
 * `@byok-sdk/pi-ai/dist/api/openai-completions.js:763`, stamping the assistant
 * message's `timestamp` — sits inside `export const stream`, which a compile
 * never enters. A fork bump that moves a clock read onto the compile path must
 * add it HERE with a justification, and the forced-skew case below is what
 * decides whether that read can reach D.
 */
const ALLOWED_COMPILE_NONDETERMINISM: { readonly api: string; readonly originFile: string }[] = [];

const nondeterminismOffAllowlist = (phase: ProbePhase): unknown[] =>
  phase.nondeterminism
    .map((event) => ({ api: event.api, originFile: originFile(event.origin) }))
    .filter(
      (event) =>
        !ALLOWED_COMPILE_NONDETERMINISM.some(
          (allowed) => allowed.api === event.api && allowed.originFile === event.originFile,
        ),
    );

/**
 * The monitors that do not exist on the running Node, measured identically on
 * 22.22.3 (the `.node-version` pin every CI job uses) and 24.18.0 (the local
 * runtime), so this is one list rather than a table keyed by major.
 *
 * Nothing security-relevant is here by construction: every `fs` read family in
 * all three call forms, every `child_process`, `net`, `http`, `https`,
 * `http2`, `dns`, `tls`, `dgram` and `worker_threads` entry, `os.homedir`,
 * `process.cwd` and both egress globals install successfully. An absent entry
 * from any of those families would be a hole in the gate, not a runtime fact,
 * and this equality is what turns it into a failure.
 */
const EXPECTED_ABSENT_MONITORS = [
  // `fs.promises` is a different API surface, not a promisified copy of `fs`:
  // it exposes no existence predicate (callers `stat` or `access` instead),
  // and no fd-level read/write — those live on the `FileHandle` a monitored
  // `fs.promises.open` returns, whose fd this probe files under its path.
  { api: 'fs.promises.exists', reason: 'absent' },
  { api: 'fs.promises.read', reason: 'absent' },
  { api: 'fs.promises.readv', reason: 'absent' },
  { api: 'fs.promises.write', reason: 'absent' },
  { api: 'fs.promises.writev', reason: 'absent' },
  // A non-configurable getter-only property on the `node:crypto` CJS exports
  // object on both 22 and 24, so no assignment and no `defineProperty` can
  // replace it. The generator itself is still watched where it is writable —
  // `globalThis.crypto.getRandomValues` — and `crypto.randomBytes` /
  // `crypto.randomUUID` on `node:crypto` install normally. The one unwatched
  // shape is therefore `import { getRandomValues } from "node:crypto"`, and
  // it is a determinism surface rather than a security one; the forced-skew
  // case below is what would catch a value from it reaching D.
  { api: 'crypto.getRandomValues', reason: 'unwritable' },
  // `randomBytes` is a Node API, not a WebCrypto one; the standard `Crypto`
  // interface has no such method. `node:crypto.randomBytes` covers it.
  { api: 'globalThis.crypto.randomBytes', reason: 'absent' },
];

let clean: ProbeRun;
let ambientA: ProbeRun;
let ambientB: ProbeRun;
let skewA: ProbeRun;
let skewB: ProbeRun;
let controlFs: ProbeRun;
let controlEnv: ProbeRun;
let controlCapability: ProbeRun;
let controlClockA: ProbeRun;
let controlClockB: ProbeRun;
let everyRun: ProbeRun[];

// One generous budget for ten child processes that each load the fork's whole
// module graph. The suite's default is 10s and this file is not the place to
// add a second load-sensitive deadline. They are spawned in ONE `Promise.all`
// and completion is the child's own exit, so nothing here waits on a clock.
const PROBE_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  [
    clean,
    ambientA,
    ambientB,
    skewA,
    skewB,
    controlFs,
    controlEnv,
    controlCapability,
    controlClockA,
    controlClockB,
  ] = await Promise.all([
    runProbe('clean', 'clean', 'CANARY-CLEAN'),
    runProbe('clean', 'ambient-a', 'CANARY-AMBIENT-A', { ambient: 'long' }),
    runProbe('clean', 'ambient-b', 'CANARY-AMBIENT-B', { ambient: 'short' }),
    runProbe('clean', 'skew-a', 'CANARY-SKEW-A', { skew: 'a' }),
    runProbe('clean', 'skew-b', 'CANARY-SKEW-B', { skew: 'b' }),
    runProbe('control-fs', 'control-fs', 'CANARY-CONTROL-FS'),
    runProbe('control-env', 'control-env', 'CANARY-CONTROL-ENV'),
    runProbe('control-capability', 'control-capability', 'CANARY-CONTROL-CAP'),
    runProbe('control-nondeterminism', 'control-clock-a', 'CANARY-CONTROL-CLOCK-A', { skew: 'a' }),
    runProbe('control-nondeterminism', 'control-clock-b', 'CANARY-CONTROL-CLOCK-B', { skew: 'b' }),
  ]);
  everyRun = [
    clean,
    ambientA,
    ambientB,
    skewA,
    skewB,
    controlFs,
    controlEnv,
    controlCapability,
    controlClockA,
    controlClockB,
  ];
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

  it('installed every monitor it claims, and names the ones this Node does not have', () => {
    // The hole this closes: `watch()` swallowed a refused `Reflect.set` in an
    // empty `catch` and skipped an absent builtin without a word, so a monitor
    // that silently never existed read exactly like a surface nothing touched.
    // Both are now facts in the report, and both are asserted.
    for (const run of everyRun) {
      expect({ mode: run.report.mode, failures: run.report.monitorInstallFailures }).toEqual({
        mode: run.report.mode,
        failures: [],
      });
      expect(run.report.monitorsAbsent.map((gap) => ({ api: gap.api, reason: gap.reason }))).toEqual(
        EXPECTED_ABSENT_MONITORS,
      );
    }
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
    // not because nothing was looked for: the recording Proxy sees `get`, `in`,
    // `ownKeys` AND `getOwnPropertyDescriptor` on `process.env`, and the fork's
    // one real environment read (`PI_PACKAGE_DIR`) happens at module load,
    // never at compile time. No stack class is excused — a runtime-internal
    // frame reading an ambient value during the compile would count.
    const ALLOWED_COMPILE_ENV_READS: string[] = [];

    for (const phase of [clean.report.compileCold, clean.report.compileWarm]) {
      expect(phase.envReads.map((event) => event.key)).toEqual(ALLOWED_COMPILE_ENV_READS);
      expect(phase.envWrites).toEqual([]);
    }
  });

  it('reads no clock and no generator during either compile call', () => {
    // NOT a purity assertion, and deliberately not stated as "zero": reading
    // the clock touches nothing ambient, and the provider path does it
    // legitimately. What is asserted is that every such read in a compile
    // phase is on `ALLOWED_COMPILE_NONDETERMINISM` with a justification. On
    // this build the list is empty and so is the measurement, in both phases
    // and under both forced skews.
    for (const run of [clean, skewA, skewB]) {
      expect(nondeterminismOffAllowlist(run.report.compileCold)).toEqual([]);
      expect(nondeterminismOffAllowlist(run.report.compileWarm)).toEqual([]);
    }
  });

  it('compiles the same bytes with the clock and every generator forced years apart', () => {
    // The determinism half, measured rather than argued. `skewed-a` pins
    // `Date.now()` and zero-argument `new Date()` at 2001-09-09 with
    // `Math.random()` at 0, fixed-zero `randomBytes`/`getRandomValues` and the
    // all-zero UUID; `skewed-b` pins 2033-05-18 with the largest double below
    // 1, all-`0xff` bytes and the all-`f` UUID. Forcing does not break the
    // fork's load — both runs report `failure: null` — so the comparison is a
    // real one, and D comes out byte-identical to the unforced run.
    expect({ a: skewA.report.failure, b: skewB.report.failure }).toEqual({ a: null, b: null });
    expect(skewA.report.requestBody).toBe(clean.report.requestBody);
    expect(skewB.report.requestBody).toBe(clean.report.requestBody);
    expect(skewB.report.requestBody).toBe(skewA.report.requestBody);
    expect(skewB.report.envelopeDigest).toBe(skewA.report.envelopeDigest);
    expect(skewB.report.warmRequestBody).toBe(skewA.report.warmRequestBody);
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
    //
    // That claim now covers the fd-based calls too, which it did not when an
    // `fs.readSync`/`fs.closeSync` was recorded as an anonymous `<fd 12>` and
    // dropped by the `<` filter below. The probe remembers what every
    // MONITORED `open`/`openSync`/`fs.promises.open` handed out and resolves a
    // later fd to the path it was opened at, so the call is measured against
    // that path like any other. An fd from an open the probe never saw
    // resolves to `unknown-fd:<n>`, which contains no `/node_modules/` segment
    // and therefore fails here rather than disappearing from the count — and
    // it is asserted by name as well, so the failure says what it is.
    const paths = load.events.map((event) => event.detail).filter((detail) => !detail.startsWith('<'));
    expect(paths.filter((detail) => !detail.includes('/node_modules/'))).toEqual([]);
    for (const phase of [load, clean.report.compileCold, clean.report.compileWarm]) {
      expect(phase.events.filter((event) => event.detail.startsWith('unknown-fd:'))).toEqual([]);
    }

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

      // The load-phase ENV READS are pinned too, not just the events. Without
      // this, a poisoned run could start reading a new ambient variable at
      // load and nothing here would notice.
      //
      // What is pinned is exactly what the run reports, and it is the same
      // `(key, origin)` set the clean run produces: `PI_PACKAGE_DIR` at
      // `config.js:313` and `cross-spawn`'s `OSTYPE` twice at module scope.
      // `PI_CODING_AGENT_DIR` and the agent-dir variable derived from the
      // poisoned manifest's name are NOT read — `getAgentDir()` is never
      // called on this path — so pinning the observed set rather than the
      // expected one is the point. Every entry is load-time, and load-time
      // cannot reach D: the byte equality asserted above is the proof, not
      // this list.
      expect(run.report.load.envReads.map((event) => ({ key: event.key, origin: event.origin }))).toEqual([
        { key: 'WATCH_REPORT_DEPENDENCIES', origin: '(runtime-internal)' },
        { key: 'NODE_V8_COVERAGE', origin: '(runtime-internal)' },
        { key: 'OSTYPE', origin: 'dep:which/which.js:2:17' },
        { key: 'OSTYPE', origin: 'dep:which/which.js:3:17' },
        { key: 'PI_PACKAGE_DIR', origin: 'fork:dist/config.js:313:32' },
      ]);
      expect(run.report.load.envWrites).toEqual([]);
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

  it('sees an environment read made inside the compile, through the plain get AND through the descriptor', () => {
    // Two shapes, because the Proxy traps them separately.
    // `Object.getOwnPropertyDescriptor(process.env, K)` hands back the VALUE
    // without ever going through `get`, so before the `gOPD` trap existed a
    // read made that way — by hand, or by anything built on the descriptor
    // path — was invisible to a gate that reported the phase as clean.
    expect(controlEnv.report.control.env).toBe(controlEnv.canaryValue);
    expect(controlEnv.report.control.envDescriptor).toBe(controlEnv.canaryValue);
    expect(
      forkEnvReads(controlEnv.report.compileCold).map((event) => ({
        key: event.key,
        via: event.via,
        origin: originFile(event.origin),
      })),
    ).toEqual([
      { key: CANARY_ENV_KEY, via: 'get', origin: 'fork:dist/core/system-prompt.js' },
      { key: CANARY_ENV_KEY, via: 'gOPD', origin: 'fork:dist/core/system-prompt.js' },
    ]);
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

  it('sees a clock and a generator read that reaches the rendered prompt, and D then differs', () => {
    // The fourth control, and the only one whose effect has to reach D: the
    // rewritten `buildSystemPrompt` appends `Date.now()` and `Math.random()`
    // to the prompt text itself. Under the two skews that text differs, so the
    // same pair of runs that came out byte-identical above now comes out
    // different — which is what makes the byte-equality case a measurement
    // instead of a property of a fixture that reads no clock.
    expect({ a: controlClockA.report.failure, b: controlClockB.report.failure }).toEqual({ a: null, b: null });
    expect(
      controlClockA.report.compileCold.nondeterminism.map((event) => ({
        api: event.api,
        origin: originFile(event.origin),
      })),
    ).toEqual([
      { api: 'Date.now', origin: 'fork:dist/core/system-prompt.js' },
      { api: 'Math.random', origin: 'fork:dist/core/system-prompt.js' },
    ]);
    expect(nondeterminismOffAllowlist(controlClockA.report.compileCold)).not.toEqual([]);
    expect(controlClockA.report.requestBody).not.toBe(controlClockB.report.requestBody);
    expect(controlClockA.report.requestBody).not.toBe(clean.report.requestBody);

    // And the control is a control: nothing about it is a purity violation,
    // which is exactly why the clock needed an assertion of its own.
    expect(purityViolations(controlClockA.report.compileCold)).toEqual([]);
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

    // The determinism predicate, stated the same way: D is invariant under a
    // forced skew for the clean pair and is not for the control pair.
    const clockIndependent = (a: ProbeRun, b: ProbeRun): boolean =>
      a.report.requestBody === b.report.requestBody;
    expect({
      clean: clockIndependent(skewA, skewB),
      controlClock: clockIndependent(controlClockA, controlClockB),
    }).toEqual({ clean: true, controlClock: false });
  });
});
