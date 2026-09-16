import { projectPiMcpEnvironment } from '../adapters/pi/mcp-environment';
import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PiRpcClient, type SpawnFn } from '../adapters/pi/rpc-client';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { resolveInstalledPiRuntimeIdentity, createPiInputPreparationCompiler } from '../adapters/pi/input-preparation';
import { INPUT_PREPARATION_ARTIFACT_FORMAT, INPUT_PREPARATION_VERSION } from '../input-preparation';
import { sealRuntimeOperationManifest, type RuntimePreparedLaunchV1 } from '../types';
import { trustedCwd } from './fixtures/launch-cwd';

const execFileAsync = promisify(execFile);

/**
 * The Pi RUNTIME child's half of the launch-cwd boundary.
 *
 * `pi-mcp-launch-cwd.test.ts` already holds this property for the MCP *server*
 * children the Pi child opens. Nothing holds it for the Pi runtime child
 * itself: both final spawn sites hand `PiRpcClient` the task manifest
 * directory as the process cwd —
 *
 *   - ordinary lane: `pi-adapter.ts:518`  (`cwd: manifestCwd`)
 *   - prepared lane: `pi-adapter.ts:747`  (`cwd: input.manifestCwd`)
 *
 * — and that directory is writable by the agent's own tools by design. A
 * bun-family interpreter (a `bun --compile` single-file runtime, or bun
 * running the sealed prepared entry) reads `$cwd/bunfig.toml` and runs its
 * `preload` and auto-loads `$cwd/.env` BEFORE the entry's own first line, so
 * no check inside the entry can stand in for a sealed launch cwd.
 *
 * These cases are RED until the C07 P2/P3 sealed launch description lands
 * (`tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md`). Pre-fix
 * evidence: `guards/pre-fix-claim-a.log` (root-cause-prover scratchpad), which
 * observed `INJECTED=PRELOAD_EXECUTED` and `DOTENV=DOTENV_LOADED` out of the
 * child.
 *
 * Both lanes now call the real PiAdapter prepare -> operation.start path.
 * The ordinary target is supplied through resolveBin. The prepared target is
 * substituted at the existing spawnFn seam because that lane selects the SDK
 * bin internally; its interpreter/script are replaced by the Bun marker host,
 * while every remaining argv token, the cwd and the env are passed unchanged.
 * This proves the actual adapter-derived pre-entry boundary, not native session
 * correctness (covered by pi-prepared-launcher.test.ts). The marker implements
 * the minimal RPC replies needed to complete the real adapter start.
 */

const PRELOAD_GLOBAL = '__BYOK_LAUNCH_CWD_PRELOADED__';
const DOTENV_VAR = 'PI_CHILD_SEES_ENV_MARKER';
const DOTENV_VALUE = 'DOTENV_LOADED';
const RECORD_VAR = 'BYOK_PI_LAUNCH_CWD_RECORD_TO';

/**
 * bun, if this machine has one. Resolved once, synchronously, so every case
 * below is either RUN or visibly SKIPPED — never a body that returns early and
 * reports as a pass. Mirrors `pi-mcp-launch-cwd.test.ts`.
 */
const BUN_BIN = ((): string | undefined => {
  const candidates = [
    process.env.BYOK_TEST_BUN_BIN,
    path.join(os.homedir(), '.local/bin/bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(candidate)) return candidate;
  }
  return undefined;
})();

/**
 * The Pi child's own report, read back out of the child rather than assumed:
 * the cwd it actually ran in, whether the cwd's `bunfig.toml` `preload` got to
 * run before it, and whether the cwd's `.env` reached its environment.
 */
interface ChildReport {
  readonly cwd: string;
  readonly preloaded: boolean;
  readonly dotenv: string;
}

/** The stand-in Pi runtime: reports the three facts above, then exits. */
const PI_ENTRY_SOURCE = [
  "import { writeFileSync } from 'node:fs';",
  `const recordTo = process.env.${RECORD_VAR};`,
  "if (recordTo === undefined) throw new Error('no record path');",
  'writeFileSync(recordTo, JSON.stringify({',
  '  cwd: process.cwd(),',
  `  preloaded: globalThis.${PRELOAD_GLOBAL} === true,`,
  `  dotenv: process.env.${DOTENV_VAR} ?? 'absent',`,
  '}));',
  'if (process.argv.includes("--mode") || process.argv.includes("--config")) {',
  '  let buffer = "";',
  '  process.stdin.setEncoding("utf8");',
  '  process.stdin.on("data", (chunk) => {',
  '    buffer += chunk;',
  '    let end;',
  '    while ((end = buffer.indexOf("\\n")) >= 0) {',
  '      const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);',
  '      const data = command.type === "get_state" ? { sessionId: "cwd-marker-session" }',
  '        : command.type === "prompt_prepared" ? { sessionId: "cwd-marker-session", preparedDigest: command.expected.digest } : {};',
  '      process.stdout.write(JSON.stringify({ type: "response", command: command.type, id: command.id, success: true, data }) + "\\n");',
  '    }',
  '  });',
  '}',
  '',
].join('\n');

/**
 * A directory shaped exactly like a canonical Agent home that the agent's own
 * write/bash tools have reached: this uid can write it, and it carries the two
 * pre-entry loader files a bun-family interpreter honours.
 */
async function plantedAgentHome(): Promise<string> {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-agent-home-')));
  await fs.writeFile(path.join(home, 'byok-preload.ts'), `globalThis.${PRELOAD_GLOBAL} = true;\n`);
  await fs.writeFile(path.join(home, 'bunfig.toml'), 'preload = ["./byok-preload.ts"]\n');
  await fs.writeFile(path.join(home, '.env'), `${DOTENV_VAR}=${DOTENV_VALUE}\n`);
  return home;
}

/**
 * The "release" the lanes launch from: a `bun --compile` single-file binary
 * (the ordinary lane's resolved Pi bin) plus the sealed prepared entry the
 * interpreter is handed on the prepared lane. Built once per file.
 */
let releaseOnce: Promise<{ compiledBin: string; preparedEntry: string }> | undefined;
function piRelease(): Promise<{ compiledBin: string; preparedEntry: string }> {
  releaseOnce ??= (async () => {
    const bun = BUN_BIN;
    if (bun === undefined) throw new Error('no bun on this machine');
    const release = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-release-')));
    await fs.writeFile(path.join(release, 'pi-entry.ts'), PI_ENTRY_SOURCE);
    await execFileAsync(bun, ['build', '--compile', './pi-entry.ts', '--outfile', './pi-compiled'], { cwd: release });
    const preparedEntry = path.join(release, 'byok-pi-prepared.mjs');
    await fs.writeFile(preparedEntry, PI_ENTRY_SOURCE);
    return { compiledBin: path.join(release, 'pi-compiled'), preparedEntry };
  })();
  return releaseOnce;
}

/** The env shape the adapter builds for the child, plus this test's report channel. */
function runtimeEnv(recordTo: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
    [RECORD_VAR]: recordTo,
  };
}

/** Spawn the child through the real `PiRpcClient` and read its report back. */
async function launch(options: { command: string; args: string[]; cwd: string }): Promise<ChildReport> {
  const recordDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-record-'));
  const recordTo = path.join(recordDir, 'record.json');
  const rpc = new PiRpcClient({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: runtimeEnv(recordTo),
  });
  await rpc.waitClosed();
  const raw = await fs.readFile(recordTo, 'utf8');
  return JSON.parse(raw) as ChildReport;
}

/** Compile a real retained envelope; the marker only substitutes its runtime consumer. */
async function prepareArtifact(home: string, artifactPath: string, launchCwd: string): Promise<RuntimePreparedLaunchV1> {
  const model = {
    id: 'glm-4.6', name: 'GLM 4.6', api: 'openai-completions' as const,
    provider: 'zai', baseUrl: 'http://127.0.0.1:1/v1', reasoning: false,
    input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192, maxTokens: 1024,
  };
  const binding = { inputIdentity: 'cwd-input', runtimeIdentity: 'cwd-runtime', policyIdentity: 'cwd-policy', profileRevision: 'cwd-profile' };
  const compiled = await createPiInputPreparationCompiler(resolveInstalledPiRuntimeIdentity()).compile({
    snapshot: {
      prompt: { cwd: home, selectedTools: [], toolSnippets: {}, promptGuidelines: [], contextFiles: [], formattedSkills: '',
        docsPaths: { readmePath: '/sealed/README.md', docsPath: '/sealed/docs', examplesPath: '/sealed/examples' } },
      messages: [{ role: 'user', content: 'report cwd', timestamp: 1700000000000 }], tools: [],
    },
    model, options: { cacheRetention: 'none', maxTokens: 256 }, binding, toolExecutors: {},
  });
  const recordId = 'cwd-marker-record';
  await fs.writeFile(artifactPath, JSON.stringify({
    format: INPUT_PREPARATION_ARTIFACT_FORMAT, version: INPUT_PREPARATION_VERSION, recordId,
    ...compiled,
  }), { mode: 0o600 });
  return {
    reference: { scopeId: 'cwd-scope', agentRef: 'cwd-agent', requestId: 'cwd-preparation', recordId },
    artifactPath,
    expected: { envelopeDigest: compiled.envelopeDigest, toolManifestDigest: compiled.toolManifestDigest, model, binding },
    permissionMode: 'auto', toolBindingDigest: 'cwd-marker-tool-binding', observationDigest: 'cwd-marker-observation',
    launch: { cwd: launchCwd }, toolImplementations: {}, toolsetDefinitionRevisions: {},
  };
}

/** The actual adapter owns cwd/env; the test substitutes only the native runtime. */
async function launchThroughAdapter(lane: 'ordinary' | 'prepared', home: string): Promise<ChildReport> {
  const { compiledBin, preparedEntry } = await piRelease();
  const recordDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-adapter-record-'));
  const recordTo = path.join(recordDir, 'record.json');
  const env = runtimeEnv(recordTo);
  let spawnCount = 0;
  const adapter = new PiAdapter({
    resolveBin: () => ({ command: compiledBin, source: 'env' }),
    spawnFn: ((command: string, args: readonly string[], options: SpawnOptions) => {
      spawnCount++;
      // Do not reconstruct options: the real adapter's cwd/env flow directly to Bun.
      if (lane === 'prepared') {
        if (!args[0]?.endsWith('byok-pi-prepared.js') || !/^--config-digest=[0-9a-f]{64}$/.test(args[1] ?? '') || args[2] !== '--config') {
          throw new Error('prepared marker must replace the actual SDK prepared entry');
        }
        return spawn(BUN_BIN!, [preparedEntry, ...args.slice(1)], options);
      }
      return spawn(command, args, options);
    }) as unknown as SpawnFn,
  });
  const policy = { mode: 'auto' as const };
  const offer = { instruction: 'report cwd', policy };
  const prepared = await adapter.prepare({ offer, policy, descriptor: adapter.descriptor, requiredToolsetIds: [] });
  if (prepared.kind === 'reject') throw new Error(prepared.reason);
  const manifest = sealRuntimeOperationManifest({
    taskId: 'cwd-marker-task', runtimeId: 'pi', descriptor: adapter.descriptor, policy,
    requiredToolsetIds: [], workspace: { workspaceDir: home }, forwardedEnvironmentNames: Object.keys(env).sort(),
  });
  const cwd = await trustedCwd();
  const preparation = lane === 'prepared'
    ? await prepareArtifact(home, path.join(recordDir, 'artifact.json'), cwd) : undefined;
  const runtimeLaunch = await prepared.operation.resolveRuntimeLaunch!({
    kind: preparation === undefined ? 'instruction' : 'prepared', cwd: home, env,
    projectionRoot: path.join(recordDir, 'projections'),
  });
  const session = await prepared.operation.start({
    runtimeLaunch,
    ...(preparation === undefined ? { kind: 'instruction' as const, instruction: offer.instruction }
      : { kind: 'prepared' as const, preparation }),
    manifest, env, mcpEnv: projectPiMcpEnvironment(env), mcpLaunch: { cwd },
  });
  try {
    if (spawnCount !== 1) throw new Error(`expected exactly one actual adapter spawn, got ${spawnCount}`);
    const report = JSON.parse(await fs.readFile(recordTo, 'utf8')) as ChildReport;
    console.log(`[pi-runtime-launch-cwd] ${lane} ${JSON.stringify(report)}`);
    return report;
  } finally {
    await session.close();
    await fs.rm(recordDir, { recursive: true, force: true });
  }
}

describe('Pi runtime child — launch cwd', () => {
  // The vector needs a real bun-family interpreter; without one there is
  // nothing to observe, so the case is visibly skipped rather than passed.
  it.skipIf(BUN_BIN === undefined)(
    'ordinary lane (pi-adapter.ts:518) leaves the Agent home bunfig preload and .env unreachable',
    async () => {
      const home = await plantedAgentHome();
      const report = await launchThroughAdapter('ordinary', home);

      expect(report.preloaded).toBe(false);
      expect(report.dotenv).toBe('absent');
      expect(await fs.realpath(report.cwd)).not.toBe(home);
    },
    120_000,
  );

  it.skipIf(BUN_BIN === undefined)(
    'prepared lane (pi-adapter.ts:747) leaves the Agent home bunfig preload and .env unreachable',
    async () => {
      const home = await plantedAgentHome();
      const report = await launchThroughAdapter('prepared', home);

      expect(report.preloaded).toBe(false);
      expect(report.dotenv).toBe('absent');
      expect(await fs.realpath(report.cwd)).not.toBe(home);
    },
    120_000,
  );

  // The control. Same planted files, same interpreter, same `PiRpcClient`
  // spawn — with the cwd named explicitly as a writable directory that holds
  // them. If this does not fire, the two lane cases above prove nothing.
  it.skipIf(BUN_BIN === undefined)(
    'control: the planted preload and .env DO fire when the child runs in a writable directory holding them',
    async () => {
      const hostile = await plantedAgentHome();
      const { compiledBin } = await piRelease();

      const report = await launch({ command: compiledBin, args: [], cwd: hostile });

      expect(report.preloaded).toBe(true);
      expect(report.dotenv).toBe(DOTENV_VALUE);
      expect(await fs.realpath(report.cwd)).toBe(hostile);
    },
    120_000,
  );
});
