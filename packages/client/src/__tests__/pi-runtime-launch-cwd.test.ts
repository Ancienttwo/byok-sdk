import { projectPiMcpEnvironment } from '../adapters/pi/mcp-environment';
import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { SpawnFn } from '../adapters/pi/rpc-client';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { resolveInstalledPiRuntimeIdentity, createPiInputPreparationCompiler } from '../adapters/pi/input-preparation';
import { INPUT_PREPARATION_ARTIFACT_FORMAT, INPUT_PREPARATION_VERSION } from '../input-preparation';
import { sealRuntimeOperationManifest, type RuntimePreparedLaunchV1 } from '../types';
import { resolveBunBin } from './support/test-bun-bin';

const execFileAsync = promisify(execFile);

/**
 * The Pi RUNTIME child starts in the session cwd (the workspace or the Agent
 * home), as in OAR. The SDK no longer moves it to a separate launch
 * directory.
 *
 * Both lanes call the real PiAdapter prepare -> operation.start path. The
 * ordinary target is supplied through resolveBin. The prepared target is
 * substituted at the existing spawnFn seam because that lane selects the SDK
 * bin internally; its interpreter/script are replaced by the Bun marker host,
 * while every remaining argv token, the cwd and the env are passed unchanged.
 * The marker reports its own `process.cwd()` and implements the minimal RPC
 * replies needed to complete the real adapter start.
 */

const RECORD_VAR = 'BYOK_PI_LAUNCH_CWD_RECORD_TO';

/**
 * bun, if this machine has one. Resolved once, synchronously, so every case
 * below is either RUN or visibly SKIPPED — never a body that returns early and
 * reports as a pass. The candidate list and the BYOK_REQUIRE_BUN fail-closed
 * law live in the shared helper.
 */
const BUN_BIN = resolveBunBin();

/** The Pi child's own report, read back out of the child rather than assumed. */
interface ChildReport {
  readonly cwd: string;
}

/** The stand-in Pi runtime: reports its cwd, then answers the minimal RPC. */
const PI_ENTRY_SOURCE = [
  "import { writeFileSync } from 'node:fs';",
  `const recordTo = process.env.${RECORD_VAR};`,
  "if (recordTo === undefined) throw new Error('no record path');",
  'writeFileSync(recordTo, JSON.stringify({',
  '  cwd: process.cwd(),',
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

/** A session cwd, shaped like a canonical Agent home. */
async function sessionHome(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-agent-home-')));
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
    await fs.writeFile(preparedEntry, PI_ENTRY_SOURCE.replace(`process.env.${RECORD_VAR}`, `process.argv.find(arg => arg.startsWith('--test-record='))?.slice('--test-record='.length)`));
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

const PREPARED_SYSTEM_PROMPT = 'Report the process working directory.';

/** Compile a real retained envelope; the marker only substitutes its runtime consumer. */
async function prepareArtifact(home: string, artifactPath: string): Promise<RuntimePreparedLaunchV1> {
  const model = {
    id: 'glm-4.6', name: 'GLM 4.6', api: 'openai-completions' as const,
    provider: 'zai', baseUrl: 'http://127.0.0.1:1/v1', reasoning: false,
    input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192, maxTokens: 1024,
  };
  const binding = { inputIdentity: 'cwd-input', runtimeIdentity: 'cwd-runtime', policyIdentity: 'cwd-policy', profileRevision: 'cwd-profile' };
  const compiled = await createPiInputPreparationCompiler(resolveInstalledPiRuntimeIdentity()).compile({
    snapshot: {
      prompt: { systemPrompt: PREPARED_SYSTEM_PROMPT },
      messages: [{ role: 'user', content: 'report cwd', timestamp: 1700000000000 }], tools: [],
    },
    model, options: { cacheRetention: 'none', maxTokens: 256 }, binding, toolExecutors: {},
  });
  // The prompt `cwd` no longer reaches D: the Host owns the whole system
  // message on official Pi and no Pi prompt builder renders a `<cwd>` block,
  // so the Agent home path is nowhere in the counted request.
  const body = JSON.parse(compiled.requestBody) as { messages: { role: string; content: unknown }[] };
  expect(body.messages[0]).toEqual({ role: 'system', content: PREPARED_SYSTEM_PROMPT });
  expect(compiled.requestBody).not.toContain('<cwd>');
  expect(compiled.requestBody).not.toContain(home);
  const recordId = 'cwd-marker-record';
  await fs.writeFile(artifactPath, JSON.stringify({
    format: INPUT_PREPARATION_ARTIFACT_FORMAT, version: INPUT_PREPARATION_VERSION, recordId,
    ...compiled,
  }), { mode: 0o600 });
  return {
    agentMemory: 'none', memory: null,
    reference: { scopeId: 'cwd-scope', agentRef: 'cwd-agent', requestId: 'cwd-preparation', recordId },
    artifactPath,
    expected: { envelopeDigest: compiled.envelopeDigest, toolManifestDigest: compiled.toolManifestDigest, model, binding },
    toolBindingDigest: 'cwd-marker-tool-binding', observationDigest: 'cwd-marker-observation',
    toolImplementations: {}, toolsetDefinitionRevisions: {},
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
        expect(options.env).not.toHaveProperty(RECORD_VAR);
        return spawn(BUN_BIN!, [preparedEntry, ...args.slice(1), `--test-record=${env[RECORD_VAR]}`], options);
      }
      return spawn(command, args, options);
    }) as unknown as SpawnFn,
  });
  const offer = { instruction: 'report cwd' };
  const prepared = await adapter.prepare({ offer, descriptor: adapter.descriptor, requiredToolsetIds: [] });
  if (prepared.kind === 'reject') throw new Error(prepared.reason);
  const manifest = sealRuntimeOperationManifest({
    agentMemory: 'none',
    taskId: 'cwd-marker-task', runtimeId: 'pi', descriptor: adapter.descriptor,
    requiredToolsetIds: [], workspace: { workspaceDir: home }, forwardedEnvironmentNames: Object.keys(env).sort(),
  });
  const preparation = lane === 'prepared'
    ? await prepareArtifact(home, path.join(recordDir, 'artifact.json')) : undefined;
  const runtimeLaunch = await prepared.operation.resolveRuntimeLaunch!({
    kind: preparation === undefined ? 'instruction' : 'prepared', cwd: home, env,
    projectionRoot: path.join(recordDir, 'projections'),
  });
  const session = await prepared.operation.start({
    runtimeLaunch,
    ...(preparation === undefined ? { kind: 'instruction' as const, instruction: offer.instruction }
      : { kind: 'prepared' as const, preparation }),
    manifest, env, mcpEnv: projectPiMcpEnvironment(env),
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
  // The marker needs a real bun-family interpreter; without one there is
  // nothing to observe, so the case is visibly skipped rather than passed.
  it.skipIf(BUN_BIN === undefined)(
    'ordinary lane starts the Pi child in the session cwd',
    async () => {
      const home = await sessionHome();
      const report = await launchThroughAdapter('ordinary', home);
      expect(await fs.realpath(report.cwd)).toBe(home);
    },
    120_000,
  );

  it.skipIf(BUN_BIN === undefined)(
    'prepared lane starts the Pi child in the session cwd',
    async () => {
      const home = await sessionHome();
      const report = await launchThroughAdapter('prepared', home);
      expect(await fs.realpath(report.cwd)).toBe(home);
    },
    120_000,
  );
});
