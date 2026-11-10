import { testScratchRoot } from './fixtures/execution-scratch';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import exportLayout from '../adapters/pi/pi-export-asset-layout.json';
import todoLayout from '../adapters/pi/todo-locale-layout.json';
import { REQUIRE_BUN_ENV, resolveBunBin } from './support/test-bun-bin';
import { writeKoffiAssetRoot } from '../../../../scripts/testing/sdk-koffi-asset-root.mjs';
import { startLoopbackProvider } from './runtime-contract/loopback';

const execFileAsync = promisify(execFile);
const BUN_BIN = resolveBunBin();
const NODE_BIN = process.env.SEA_NODE ?? process.execPath;
const require = createRequire(import.meta.url);
const CLIENT_DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
type ClientDist = typeof import('../index');
const loadClient = async (): Promise<ClientDist> => await import(CLIENT_DIST) as ClientDist;
const PI_SPECIFIER = '@earendil-works/pi-coding-agent';

/** The asset root inventory of each form, independent of the helper's own tables. */
function expectedInventory(form: 'interpreter+bundle' | 'compiled-executable'): string[] {
  const theme = form === 'interpreter+bundle' ? 'dist/modes/interactive/theme' : 'theme';
  const todo = todoLayout.basePath;
  return [
    'package.json', `${theme}/dark.json`, `${theme}/light.json`,
    ...exportLayout.files.map(file => `${exportLayout.basePaths[form]}/${file}`),
    'photon_rs_bg.wasm',
    `${todo}/LICENSE`, `${todo}/PROVENANCE.md`, `${todo}/manifest.json`, `${todo}/source-manifest.json`,
    ...todoLayout.locales.map(locale => `${todo}/locales/${locale}.json`),
  ].sort();
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

describe('copyPiRuntimeAssets', () => {
  it.each(['interpreter+bundle', 'compiled-executable'] as const)('writes the %s asset root that the Pi host verifies', async (form) => {
    const sdk = await loadClient();
    const outDir = path.join(await tempRoot('byok-pi-assets-'), 'pi');
    const files = await sdk.copyPiRuntimeAssets({ outDir, form });
    const subagentFiles = files.filter(file => /^pi-subagent(s|-extensions)\//u.test(file));
    expect(files.filter(file => !subagentFiles.includes(file))).toEqual(expectedInventory(form));
    // The client's pi-subagents with its runtime dependencies, and the SDK child extensions.
    const subagents = JSON.parse(await fs.readFile(path.join(outDir, 'pi-subagents/package.json'), 'utf8'));
    expect([subagents.name, subagents.version]).toEqual(['pi-subagents', '0.87.0']);
    for (const dependency of [...Object.keys(subagents.dependencies), 'jsbi']) expect(subagentFiles).toContain(`pi-subagents/node_modules/${dependency}/package.json`);
    expect(subagentFiles.filter(file => file.startsWith('pi-subagent-extensions/'))).toEqual(['pi-subagent-extensions/pi-subagent-file-scope.js', 'pi-subagent-extensions/pi-subagent-gate.js']);
    const written = await fs.readdir(outDir, { recursive: true, withFileTypes: true });
    expect(written.filter(entry => entry.isFile()).map(entry => path.relative(outDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort())
      .toEqual(files);
    const pinned = JSON.parse(await fs.readFile(path.join(outDir, 'package.json'), 'utf8'));
    expect([pinned.name, pinned.version]).toEqual([sdk.PI_PACKAGE_NAME, '1.5.0']);
  });

  it('pins the published 0.87.0 bootstrap paths and both runner argv shapes', async () => {
    const sdk = await loadClient();
    const root = path.join(await tempRoot('byok-pi-runner-pin-'), 'pi');
    await sdk.copyPiRuntimeAssets({ outDir: root, form: 'interpreter+bundle' });
    const pkg = path.join(root, 'pi-subagents');
    expect(JSON.parse(await fs.readFile(path.join(pkg, 'package.json'), 'utf8')).version).toBe('0.87.0');
    for (const file of ['src/runs/background/subagent-runner-bootstrap.js', 'src/runs/background/binary-bootstrap.js',
      'runner-peer-preload.mjs', 'workflow-script-process.cjs', 'workflow-script-worker.cjs']) {
      expect((await fs.stat(path.join(pkg, file))).isFile()).toBe(true);
    }
    const spawn = await fs.readFile(path.join(pkg, 'src/runs/background/async-execution.js'), 'utf8');
    expect(spawn).toContain('resolveRuntimeModulePath(asyncRunnerModuleDir, "subagent-runner-bootstrap")');
    expect(spawn).toContain('["--import", new URL("../../../runner-peer-preload.mjs", import.meta.url).href]');
    expect(spawn).toContain('? [...preload, runner, cfgPath]');
    expect(spawn).toContain('["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session", "--mode", "rpc", "--extension", bootstrap]');
    const supervisor = await fs.readFile(path.join(pkg, 'src/workflows/workflow-script-worker.js'), 'utf8');
    expect(supervisor).toContain('fork(WORKFLOW_PROCESS_URL, [acorn]');
    expect(supervisor).toMatch(/"--permission",\s*"--allow-worker"/u);
  });

  it('refuses a non-empty asset root and leaves it unchanged', async () => {
    const sdk = await loadClient();
    const outDir = await tempRoot('byok-pi-assets-stale-');
    await fs.writeFile(path.join(outDir, 'stale.json'), '{}');
    await expect(sdk.copyPiRuntimeAssets({ outDir, form: 'interpreter+bundle' })).rejects.toThrow(/is not empty/);
    expect(await fs.readdir(outDir)).toEqual(['stale.json']);
  });
});

/**
 * A product host entry. It bundles the built SDK root, re-enters SDK helpers,
 * and otherwise runs one Pi task through the real adapter with `sdkHelperHost`.
 * The specifier is read at runtime, so the bundler cannot resolve it.
 */
const HOST_ENTRY_SOURCE = `
import fs from 'node:fs/promises';
import util from 'node:util';
import * as sdk from ${JSON.stringify(CLIENT_DIST)};
async function main() {
if (process.env.PAYLOAD_TEST_CHILD_START && process.argv[2] === '--no-extensions') await fs.appendFile(process.env.PAYLOAD_TEST_CHILD_START, 'runner started\\n');
if (process.argv[2] !== 'task') {
  if (!await sdk.runSdkReservedHelperCommand(process.argv.slice(2))) {
    if (process.env.PAYLOAD_TEST_PRODUCT_REEXEC) await fs.appendFile(process.env.PAYLOAD_TEST_PRODUCT_REEXEC, JSON.stringify(process.argv.slice(2)) + '\\n');
    process.stderr.write('unknown product command\\n'); process.exit(2);
  }
} else {
  const input = JSON.parse(await fs.readFile(process.argv[3], 'utf8'));
  const report = { stage: 'lookup' };
  try {
    try { report.lookup = (await import(input.piSpecifier)).FOREIGN === true ? 'foreign' : 'resolved'; } catch (error) { report.lookup = String(error); }
    report.defaultDetect = await new sdk.PiAdapter().detect();
    // The Host sets PI_CODING_AGENT_DIR itself, so the runtime gets it only through pass (#1095); the asset root is packageDir (#1315).
    const adapter = new sdk.PiAdapter({ runtimeEnvironment: { pass: ['PI_CODING_AGENT_DIR', 'PAYLOAD_TEST_PRODUCT_REEXEC', 'PAYLOAD_TEST_CHILD_START'] }, sdkHelperHost: { mode: 'self-executable', executable: process.execPath,
      ...(input.bundleEntry ? { entry: process.argv[1] } : {}) }, ...(input.piPackageDir === undefined ? {} : { packageDir: input.piPackageDir }),
      ...(input.nativeAssetRoot === undefined ? {} : { nativeAssetRoot: input.nativeAssetRoot }) });
    report.stage = 'detect'; report.detect = await adapter.detect();
    report.stage = 'prepare';
    const prepared = await adapter.prepare({ offer: { instruction: input.instruction }, descriptor: adapter.descriptor,
      requiredToolsetIds: [], mcpServers: {}, mcpToolsetTools: {} });
    if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
    const scratch=await sdk.createExecutionScratch({root:input.scratchRoot});
    report.stage = 'resolve';
    const runtime = await prepared.operation.resolveRuntimeLaunch({ kind: 'instruction', cwd: input.cwd, env: input.env, scratch });
    report.launch = { command: runtime.command, entry: runtime.entry, fixedArgs: runtime.fixedArgs };
    report.pathPreserved = runtime.env.PATH === input.env.PATH;
    const actual = await fs.stat(runtime.command); const original = await fs.stat(process.execPath);
    report.sameExecutable = actual.dev === original.dev && actual.ino === original.ino;
    report.stage = 'start'; report.gateCalls = [];
    // The auto gate's IPC reaches every native Pi subagent child through its required gate extension.
    const toolAuthorization = { timeoutMs: 10000, authorize: async call => { report.gateCalls.push({ toolName: call.toolName, nativeAgentId: call.nativeAgentId }); return { decision: 'allow' }; } };
    const manifest = sdk.sealRuntimeOperationManifest({ taskId: 'host-payload', runtimeId: 'pi', descriptor: adapter.descriptor,
      requiredToolsetIds: [], workspace: { workspaceDir: input.cwd }, forwardedEnvironmentNames: Object.keys(runtime.env).sort() });
    const session = await prepared.operation.start({ scratch, kind: 'instruction', instruction: input.instruction, manifest, runtimeLaunch: runtime,
      env: runtime.env, mcpEnv: { PATH: input.env.PATH }, mcpServers: {}, mcpToolsetTools: {}, toolAuthorization });
    report.stage = 'events'; report.events = [];
    // A session stays open for follow-ups; the task's turn ends at turn_end.
    for await (const event of session.events) {
      report.events.push(event); await fs.writeFile(input.report, JSON.stringify(report));
      if (event.type === 'turn_end') break;
    }
    if (input.statusProbe) {
      await session.followUp({ instruction: 'STATUS_PROBE_1642' });
      for await (const event of session.events) {
        report.events.push(event);
        if (event.type === 'turn_end') break;
      }
    }
    report.sdkDir = (await fs.readdir(scratch.sdkDir)).sort();
    report.privateSubagentRuntime = report.sdkDir.includes('pi-subagent-runtime');
    report.runnerStatuses = await Promise.all((await fs.readdir(scratch.runtimeDir, { recursive: true })).filter(file => file.endsWith('/status.json') || file.endsWith('\\status.json'))
      .map(async file => JSON.parse(await fs.readFile(scratch.runtimeDir + '/' + file, 'utf8'))));
    report.runnerErrors = await Promise.all((await fs.readdir(scratch.runtimeDir, { recursive: true })).filter(file => file.endsWith('runner.stderr.log'))
      .map(file => fs.readFile(scratch.runtimeDir + '/' + file, 'utf8')));
    report.stage = 'close'; await session.close();
    report.stage = 'done';
  } catch (error) { report.error = String(error); report.errorDetail = util.inspect(error, { depth: 8 }); }
  await fs.writeFile(input.report, JSON.stringify(report));
}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
`;

/**
 * A user Pi extension (issue #341). It imports Pi's host-provided packages, as
 * Pi's package contract lets it, and records what it received.
 */
function userExtensionSource(marker: string): string {
  return `import { writeFileSync } from 'node:fs';
import { VERSION, type ExtensionAPI } from ${JSON.stringify(PI_SPECIFIER)};
import { Type } from 'typebox';
const schema: unknown = Type.Object({});
export default function userExtension(pi: ExtensionAPI): void {
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ version: VERSION, schema: typeof schema, api: typeof pi.on }));
}
`;
}

interface HostReport {
  stage: string; error?: string; errorDetail?: string; lookup?: string;
  defaultDetect?: { kind: string }; detect?: unknown;
  launch?: { command: string; entry?: string; fixedArgs: string[] };
  pathPreserved?: boolean; sameExecutable?: boolean; privateSubagentRuntime?: boolean; sdkDir?: string[];
  events?: AgentEvent[]; runnerErrors?: string[]; runnerStatuses?: { state?: string; steps?: { error?: string }[] }[];
  gateCalls?: { toolName: string; nativeAgentId?: string }[];
}

function completion(res: ServerResponse, content: string, tool?: { name: string; arguments: string }, assistantText?: string): void {
  const base = { id: 'cmpl-host-payload', object: 'chat.completion.chunk', created: 0, model: 'host-payload-model' };
  const delta = tool === undefined ? { role: 'assistant', content } : { role: 'assistant', ...(assistantText === undefined ? {} : { content: assistantText }), tool_calls: [{ index: 0, id: `call-${content}`, type: 'function', function: tool }] };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end([
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: tool === undefined ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
}

/** The parent asks for one foreground and then one background child; only a request without the subagent tool is a child. */
function subagentCall(background: boolean): { name: string; arguments: string } {
  return { name: 'subagent', arguments: JSON.stringify({ agent: 'payload-child', task: 'Reply with the child marker.', model: 'host-stub/host-payload-model',
    async: background, context: 'fresh', output: false, artifacts: false, timeoutMs: 20_000 }) };
}

interface HostLayout {
  /** The command that starts the product, and its fixed launch argv before the product command. */
  readonly command: string;
  readonly prefix: readonly string[];
  /** The expected adapter launch. */
  readonly entry?: string;
  /** `PiAdapterOptions.packageDir`, when the asset root is not beside the executable. */
  readonly piPackageDir?: string;
  /** `PiAdapterOptions.nativeAssetRoot`: a bundled Windows product loads koffi from the SDK native assets, not from a package. */
  readonly nativeAssetRoot?: string;
  readonly files: readonly string[];
}

/**
 * A host form and, for `interpreter+bundle`, the interpreter that runs the
 * bundle: Bun, or Node as in issue #341.
 */
type HostCase = 'interpreter+bundle (bun)' | 'interpreter+bundle (node)' | 'compiled-executable' | 'compiled-executable (configured assets)' | 'node-sea';

/**
 * Why a copied interpreter does not run from the release directory, or
 * undefined when it does. A Node linked against libraries beside its install
 * (Homebrew or nvm on macOS load `@rpath/libnode.*.dylib`) is not
 * self-contained, so its copy proves no payload. Linking instead of copying
 * proves none either: Node resolves `process.execPath` through a symlink, so
 * the host would relaunch the install outside the release.
 */
async function relocationFailure(interpreter: string): Promise<string | undefined> {
  try {
    await execFileAsync(interpreter, ['--version'], { timeout: 30_000 });
    return undefined;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    return `${process.execPath} does not run when copied into the release: ${stderr || String(error)}`;
  }
}

/**
 * The product build: bundle the SDK into the host entry and create its Pi
 * asset root. A Node that cannot be relocated skips the case through `skip`.
 */
async function buildHost(host: HostCase, release: string, buildDir: string, skip: (note: string) => never): Promise<HostLayout> {
  const layout = await buildHostPayload(host, release, buildDir, skip);
  if (process.platform !== 'win32') return layout;
  const sdk = await loadClient();
  return { ...layout, nativeAssetRoot: await writeKoffiAssetRoot(path.join(buildDir, 'native'), sdk.sdkNativeAssetTargets['win32-x64']) };
}

async function buildHostPayload(host: HostCase, release: string, buildDir: string, skip: (note: string) => never): Promise<HostLayout> {
  const sdk = await loadClient();
  await fs.writeFile(path.join(buildDir, 'host-entry.ts'), HOST_ENTRY_SOURCE);
  if (host === 'interpreter+bundle (bun)' || host === 'interpreter+bundle (node)') {
    const form = 'interpreter+bundle';
    const node = host === 'interpreter+bundle (node)';
    const interpreter = path.join(release, (node ? 'node' : 'bun') + (process.platform === 'win32' ? '.exe' : ''));
    await fs.copyFile(node ? NODE_BIN : BUN_BIN!, interpreter); await fs.chmod(interpreter, 0o555);
    const failure = node ? await relocationFailure(interpreter) : undefined;
    if (failure !== undefined) {
      // The formal gate runs every host form; only a local run may skip one.
      if (process.env[REQUIRE_BUN_ENV] === '1') throw new Error(failure);
      skip(failure);
    }
    const assetRoot = path.join(release, 'pi-assets');
    await sdk.copyPiRuntimeAssets({ outDir: assetRoot, form });
    const bundle = path.join(release, 'host.js');
    await execFileAsync(BUN_BIN!, ['build', 'host-entry.ts', '--target', node ? 'node' : 'bun', '--format', 'esm', '--outfile', bundle], { cwd: buildDir });
    return { command: interpreter, prefix: node ? [bundle] : ['--no-install', bundle], entry: bundle, piPackageDir: assetRoot,
      files: [path.basename(interpreter), 'host.js', 'pi-assets'].sort() };
  }
  const executable = path.join(release, process.platform === 'win32' ? 'host.exe' : 'host');
  if (host === 'node-sea') {
    const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
    if (!(await fs.readFile(NODE_BIN)).includes(Buffer.from(fuse))) {
      if (process.env[REQUIRE_BUN_ENV] === '1') throw new Error('Node SEA needs an official Node binary with the SEA fuse');
      skip('set SEA_NODE to an official relocatable Node binary');
    }
    const assets = await sdk.copyPiRuntimeAssets({ outDir: release, form: 'interpreter+bundle' });
    const { build } = require('esbuild') as typeof import('esbuild');
    const { byokSdkPackaging } = await import('../../dist/adapters/packaging.js');
    const bundle = path.join(buildDir, 'host.cjs');
    await build({ entryPoints: [path.join(buildDir, 'host-entry.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node24',
      // The SDK root can evaluate Pi before helper dispatch: declare bundled peers at build time (#341).
      define: { PI_BUNDLED_NODE: 'true' }, outfile: bundle, plugins: [byokSdkPackaging({ format: 'sea' })], logLevel: 'silent' });
    const blob = path.join(buildDir, 'sea.blob');
    const config = path.join(buildDir, 'sea-config.json');
    await fs.writeFile(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
    await execFileAsync(NODE_BIN, ['--experimental-sea-config', config]);
    await fs.copyFile(NODE_BIN, executable); await fs.chmod(executable, 0o755);
    if (process.platform === 'darwin') await execFileAsync('codesign', ['--remove-signature', executable]);
    const postject = createRequire(new URL('../../../../examples/packaging/package.json', import.meta.url))('postject') as {
      inject(file: string, name: string, data: Buffer, options: Record<string, string>): Promise<void>;
    };
    await postject.inject(executable, 'NODE_SEA_BLOB', await fs.readFile(blob), { sentinelFuse: fuse,
      ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}) });
    if (process.platform === 'darwin') await execFileAsync('codesign', ['--sign', '-', executable]);
    return { command: executable, prefix: [], files: [...new Set([path.basename(executable), ...assets.map(file => file.split('/')[0]!)])].sort() };
  }
  const form = 'compiled-executable';
  const configured = host === 'compiled-executable (configured assets)';
  const assetRoot = configured ? path.join(release, 'pi-assets') : release;
  const assets = await sdk.copyPiRuntimeAssets({ outDir: assetRoot, form });
  await execFileAsync(BUN_BIN!, ['build', 'host-entry.ts', '--compile', '--outfile', executable], { cwd: buildDir });
  return { command: executable, prefix: [], ...(configured ? { piPackageDir: assetRoot } : {}),
    files: configured ? [path.basename(executable), 'pi-assets'].sort()
      : [...new Set([path.basename(executable), ...assets.map(file => file.split('/')[0]!)])].sort() };
}

describe('official Pi in a host payload (sdkHelperHost + copyPiRuntimeAssets)', () => {
  it.skipIf(BUN_BIN === undefined)('keeps Host slash commands out of child launch while model and tool text stays literal in a compiled product (#1642)', { timeout: 180_000 }, async () => {
    const root = await tempRoot('byok-host-command-'), release = path.join(root, 'release'), build = path.join(root, 'build');
    await fs.mkdir(release); await fs.mkdir(build);
    const host = await buildHost('compiled-executable', release, build, note => { throw new Error(note); });
    for (const name of ['host-exact', 'host-bg', 'watchdog-on', 'watchdog-session', 'host-mid', 'model-text', 'tool-result', 'workflow-control']) {
      const run = path.join(root, name), agent = path.join(run, 'agent'), cwd = path.join(run, 'workspace'), home = path.join(run, 'home');
      await fs.mkdir(path.join(agent, 'agents'), { recursive: true }); await fs.mkdir(cwd); await fs.mkdir(home);
      const marker = `PROOF_1642_${name}`, slash = `/run payload-child ${marker}`;
      let sent = false, waited = false, status = false;
      const childRequests: string[] = [];
      const provider = await startLoopbackProvider('openai-chat', request => {
        if (!request.tools.some(tool => tool.name === 'subagent')) {
          childRequests.push(request.text); return { kind: 'text', chunks: [`CHILD_${marker}`] };
        }
        const latest = [...JSON.parse(request.text).messages].reverse().find(message => message.role === 'user');
        if (JSON.stringify(latest?.content).includes('STATUS_PROBE_1642')) {
          if (!status) { status = true; return { kind: 'tool', tool: { name: 'subagent' }, args: { action: 'status' } }; }
          return { kind: 'text', chunks: ['STATUS_DONE'] };
        }
        if (!sent) {
          sent = true;
          if (name === 'model-text') return { kind: 'text', chunks: [slash] };
          if (name === 'tool-result') return { kind: 'tool', tool: { name: 'read' }, args: { path: 'slash-result.txt' } };
          if (name === 'workflow-control') return { kind: 'tool', tool: { name: 'subagent' }, args: { workflow: './proof.js', async: true } };
        }
        if (name === 'workflow-control' && !waited) { waited = true; return { kind: 'tool', tool: { name: 'bg_wait' }, args: { all: true, timeoutMs: 30_000 } }; }
        return { kind: 'text', chunks: [`PARENT_${marker}`] };
      });
      try {
        await fs.writeFile(path.join(agent, 'models.json'), JSON.stringify({ providers: { 'host-stub': { api: 'openai-completions', baseUrl: provider.baseUrl,
          apiKey: 'synthetic', models: [{ id: 'contract-model', name: 'Loopback proof', input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 256 }] } } }));
        await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'host-stub', defaultModel: 'contract-model' }));
        await fs.writeFile(path.join(agent, 'agents/payload-child.md'), '---\nname: payload-child\ndescription: Loopback proof child\nmodel: host-stub/contract-model\ntools: read\n---\nReply to the task.');
        await fs.writeFile(path.join(cwd, 'slash-result.txt'), slash);
        await fs.writeFile(path.join(cwd, 'proof.js'), `return runs.run("proof", {agent:"payload-child",task:${JSON.stringify(marker)}});`);
        const childStart = path.join(run, 'runner-started');
        const env = { PATH: process.env.PATH ?? '', HOME: home, USER: os.userInfo().username, TMPDIR: run, PI_CODING_AGENT_DIR: agent,
          PAYLOAD_TEST_CHILD_START: childStart, npm_config_registry: 'http://127.0.0.1:9', BUN_CONFIG_DEFAULT_REGISTRY: 'http://127.0.0.1:9' };
        const watchdog = name === 'watchdog-on' || name === 'watchdog-session';
        const refused = name === 'host-exact' || name === 'host-bg' || watchdog, reportPath = path.join(run, 'report.json'), input = path.join(run, 'input.json');
        await fs.writeFile(input, JSON.stringify({ piSpecifier: PI_SPECIFIER, instruction: watchdog ? `/subagents-watchdog ${name === 'watchdog-on' ? 'on' : 'session on'}`
          : name === 'host-exact' ? slash : name === 'host-bg' ? `${slash} --bg` : name === 'host-mid' ? `Literal text: ${slash}` : marker,
          cwd, env, scratchRoot: testScratchRoot(), report: reportPath, statusProbe: !refused, nativeAssetRoot: host.nativeAssetRoot }));
        await execFileAsync(host.command, ['task', input], { cwd: run, env, timeout: 60_000 });
        const report = JSON.parse(await fs.readFile(reportPath, 'utf8')) as HostReport;
        const launches = report.gateCalls!.filter(call => call.toolName === 'subagent_launch');
        if (refused) {
          expect(report.error).toContain(`pi_host_command_denied: /${watchdog ? 'subagents-watchdog' : 'run'}`);
          expect(report.stage).toBe('start'); expect(report.gateCalls).toEqual([]); expect(provider.requests).toEqual([]);
        } else {
          expect(report.error).toBeUndefined(); expect(report.stage).toBe('done');
          const bodies = provider.requests.map(request => request.text).join('\n');
          expect(bodies, JSON.stringify(report.runnerStatuses)).toContain(name === 'workflow-control' ? `CHILD_${marker}` : slash);
          expect(report.events?.some(event => event.type === 'tool_result' && JSON.stringify(event).includes('Status target:'))).toBe(true);
          if (name === 'model-text') expect(report.events?.filter(event => event.type === 'progress').map(event => event.text).join('')).toContain(slash);
          if (name === 'tool-result') expect(report.events?.some(event => event.type === 'tool_result' && JSON.stringify(event).includes(slash))).toBe(true);
        }
        expect(childRequests).toHaveLength(name === 'workflow-control' ? 1 : 0);
        expect(launches).toHaveLength(name === 'workflow-control' ? 1 : 0);
        expect(existsSync(childStart)).toBe(name === 'workflow-control');
        expect(report.runnerStatuses ?? []).toHaveLength(name === 'workflow-control' ? 2 : 0);
      } finally { await provider.close(); }
    }
  });
  it.skipIf(BUN_BIN === undefined).for(['interpreter+bundle (bun)', 'interpreter+bundle (node)', 'compiled-executable', 'compiled-executable (configured assets)', 'node-sea'] as const)('runs a Pi task from the %s host form with no package lookup', { timeout: 180_000 }, async (form, { skip }) => {
    // #1589: a foreign Pi installed above the product; pi-subagents must never load it.
    const outer = await tempRoot('byok-host-payload-release-');
    const release = path.join(outer, 'release'); await fs.mkdir(release);
    const foreignPi = path.join(outer, 'node_modules', '@earendil-works', 'pi-coding-agent');
    await fs.mkdir(foreignPi, { recursive: true });
    await fs.writeFile(path.join(foreignPi, 'package.json'), JSON.stringify({ name: PI_SPECIFIER, version: '1.5.0', type: 'module', exports: { '.': './index.js' } }));
    // It has no SDK: a child session created from it fails, so the foreground child below proves the product's Pi ran it.
    await fs.writeFile(path.join(foreignPi, 'index.js'), 'export const FOREIGN = true;\n');
    const buildDir = await tempRoot('byok-host-payload-build-');
    const runDir = await tempRoot('byok-host-payload-run-');
    const bodies: string[] = [];
    const childBodies: string[] = [];
    const configuredMarker = path.join(runDir, 'configured-bootstrap-executed');
    const background = form === 'compiled-executable';
    const workflowText = '```js workflow\nreturn runs.run("main", { agent: "payload-child", task: "Read child-input.txt and reply.", model: "host-stub/host-payload-model" });\n```';
    const provider = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const tools = (JSON.parse(body) as { tools?: { function: { name: string } }[] }).tools ?? [];
        if (!tools.some(tool => tool.function.name === 'subagent')) {
          // The child reads one file, which its gate extension must authorize, then answers.
          childBodies.push(body);
          const messages = (JSON.parse(body) as { messages: { role: string }[] }).messages;
          if (!messages.some(message => message.role === 'tool')) completion(response, 'child-read', { name: 'read', arguments: JSON.stringify({ path: 'child-input.txt' }) });
          else completion(response, 'CHILD_OK');
          return;
        }
        bodies.push(body);
        if (bodies.length < 3) completion(response, String(bodies.length), subagentCall(bodies.length === 2));
        else if (background && [3, 5, 6].includes(bodies.length)) completion(response, `wait-${bodies.length}`, { name: 'bg_wait', arguments: JSON.stringify({ timeoutMs: 30_000 }) });
        else if ((background && bodies.length === 4) || (!background && bodies.length === 3)) completion(response, 'workflow',
          { name: 'subagent', arguments: JSON.stringify({ workflow: true, ...(background ? { async: true } : {}) }) }, workflowText);
        else if (!background && bodies.length === 4) {
          const call = subagentCall(true), args = JSON.parse(call.arguments); delete args.async;
          completion(response, 'default-background', { ...call, arguments: JSON.stringify(args) });
        }
        else if (!background && bodies.length === 5) completion(response, 'foreground-workflow',
          { name: 'subagent', arguments: JSON.stringify({ workflow: true, async: false }) }, workflowText);
        else if (form === 'compiled-executable (configured assets)' && bodies.length === 6) completion(response, 'wait-missing-assets',
          { name: 'bg_wait', arguments: JSON.stringify({ timeoutMs: 15_000 }) });
        else completion(response, 'HOST_PAYLOAD_OK');
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    try {
      const host = await buildHost(form, release, buildDir, skip);
      if (form === 'compiled-executable (configured assets)') await fs.writeFile(
        path.join(host.piPackageDir!, 'pi-subagents/src/runs/background/binary-bootstrap.js'),
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(configuredMarker)}, 'executed'); export default function bootstrap() {}`);
      // The download holds only the product and its Pi asset root. No node_modules.
      expect((await fs.readdir(release)).sort()).toEqual(host.files);

      const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
      const agentDir = path.join(runDir, 'agent'); await fs.mkdir(agentDir);
      const model = { id: 'host-payload-model', name: 'Synthetic host payload model', api: 'openai-completions', provider: 'host-stub',
        baseUrl: providerUrl, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192, maxTokens: 256 };
      await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'host-stub': {
        api: 'openai-completions', baseUrl: providerUrl, apiKey: 'synthetic-host-payload', models: [model] } } }));
      // The user's own Pi package, as `pi install` records it: its TypeScript
      // extension imports Pi's host-provided packages, which only the bundle holds.
      const userPackage = path.join(runDir, 'user-pi-package');
      const extensionMarker = path.join(runDir, 'user-extension.json');
      await fs.mkdir(userPackage);
      await fs.writeFile(path.join(userPackage, 'package.json'), JSON.stringify({ name: 'byok-user-pi-package', version: '0.0.0',
        type: 'module', peerDependencies: { [PI_SPECIFIER]: '*', typebox: '*' }, pi: { extensions: ['./index.ts'] } }));
      await fs.writeFile(path.join(userPackage, 'index.ts'), userExtensionSource(extensionMarker));
      await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'host-stub', defaultModel: model.id,
        packages: [userPackage] }));
      await fs.mkdir(path.join(agentDir, 'agents'));
      await fs.writeFile(path.join(agentDir, 'agents', 'payload-child.md'), '---\nname: payload-child\ndescription: Loopback child of the host payload\nmodel: host-stub/host-payload-model\ntools: read\n---\nAnswer the task.');
      const reexecMarker = path.join(runDir, 'product-reexec.jsonl');
      const cwd = path.join(runDir, 'workspace'); await fs.mkdir(cwd);
      await fs.writeFile(path.join(cwd, 'child-input.txt'), 'child input');
      const home = path.join(runDir, 'home'); await fs.mkdir(home);
      // A dead loopback registry: an auto-install attempt fails instead of reaching a network.
      const deadRegistry = 'http://127.0.0.1:9';
      // USER: Bun's os.userInfo() reads it. The login shell comes from the
      // account database, so the child needs no SHELL (#1095).
      const env = { PATH: process.env.PATH ?? '', HOME: home, USER: os.userInfo().username, TMPDIR: runDir, PI_CODING_AGENT_DIR: agentDir,
        npm_config_registry: deadRegistry, BUN_CONFIG_DEFAULT_REGISTRY: deadRegistry, PAYLOAD_TEST_PRODUCT_REEXEC: reexecMarker };
      const reportPath = path.join(runDir, 'report.json'); const inputPath = path.join(runDir, 'input.json');
      await fs.writeFile(inputPath, JSON.stringify({ piSpecifier: PI_SPECIFIER, instruction: 'Reply with the host payload marker.',
        bundleEntry: host.entry !== undefined, piPackageDir: host.piPackageDir, nativeAssetRoot: host.nativeAssetRoot, cwd, env, scratchRoot: testScratchRoot(), report: reportPath }));

      await execFileAsync(host.command, [...host.prefix, 'task', inputPath], { cwd: runDir, env, timeout: 60_000 }).catch(async (error: unknown) => {
        throw new Error(`host task failed: ${String(error)}\nreport: ${await fs.readFile(reportPath, 'utf8').catch(() => 'none')}`);
      });
      const report = JSON.parse(await fs.readFile(reportPath, 'utf8')) as HostReport;
      expect(report.error, `failed at ${report.stage}: ${report.errorDetail}`).toBeUndefined();
      expect(report.stage).toBe('done');
      // Package lookup is denied, and the default adapter reproduces the reported probe failure.
      // The only Pi package a lookup can find is the foreign one above the release.
      // A Node 25.7+ SEA main script's import() loads built-in modules only (#1741).
      expect(report.lookup).toMatch(/^foreign$|Cannot find (package|module)|No such built-in module/u);
      expect(report.defaultDetect).toEqual({ kind: 'probe-failed' });
      // The default provider's models.json apiKey is pi's login (#345).
      expect(report.detect).toEqual({
        kind: 'available', version: '1.5.0', authPresent: true,
        versionVerdict: { state: 'allow', qualifiedVersion: '1.5.0' },
      });
      expect(report.pathPreserved).toBe(true);
      if (!background) {
        expect(report.privateSubagentRuntime).toBe(false);
        // #1741: a SEA takes the interpreter branch, never the Bun-only prepareBundledSubagents import().
        if (form === 'node-sea') expect(report.sdkDir).toContain('pi-subagents-host-sdk');
        expect(report.sameExecutable).toBe(true);
        expect((await fs.readdir(release)).sort()).toEqual(host.files);
      }
      expect(report.launch).toEqual({ command: host.command, ...(host.entry === undefined ? {} : { entry: host.entry }),
        fixedArgs: ['__byok_sdk_helper', 'pi-rpc'] });
      const events = report.events!;
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      expect(events.filter(event => event.type === 'progress').map(event => event.text).join(''))
        .toBe(workflowText.repeat(background ? 1 : 2) + 'HOST_PAYLOAD_OK');
      expect(events.at(-1)).toEqual({ type: 'turn_end' });
      expect(bodies.length).toBeGreaterThanOrEqual(background ? 7 : 3);
      expect(bodies[0]).toContain('Reply with the host payload marker.');
      expect(childBodies, JSON.stringify(report.runnerErrors)).toHaveLength(background ? 6 : 2);
      const childIds = new Set(report.gateCalls!.filter(call => call.toolName === 'read').map(call => call.nativeAgentId));
      expect(childIds.size).toBe(background ? 3 : 1);
      for (const id of childIds) expect(id).toMatch(/^pi-subagent:/u);
      const results = (JSON.parse(bodies.at(-1)!) as { messages: { role: string; content: unknown }[] }).messages
        .filter(message => message.role === 'tool').map(message => JSON.stringify(message.content));
      expect(results[0]).toContain('CHILD_OK');
      if (background) {
        expect(report.gateCalls).toContainEqual({ toolName: 'subagent_launch' });
        expect(results.join('\n')).not.toContain('pi_background_unavailable');
        expect(results.join('\n')).toContain('No active async runs');
      } else {
        const missing = form === 'compiled-executable (configured assets)';
        expect(results).toHaveLength(missing ? 6 : 5);
        if (missing) {
          expect(results[3]).toContain('Async: payload-child');
          expect(results[3]).not.toContain('pi_background_unavailable');
          expect(results[5]).toMatch(/failed/iu);
          expect(results[5]).toContain('No runs remain in flight');
          expect(report.runnerStatuses!.some(status => status.state === 'failed' && status.steps?.some(step =>
            step.error?.includes('pi_background_unavailable: background Pi subagents and workflows require the shipped pi-subagents and pi-subagent-extensions assets beside the real executable.'))),
            JSON.stringify(report.runnerStatuses)).toBe(true);
        }
        for (const [index, result] of results.entries()) {
          if (index === 0 || (missing && (index === 3 || index === 5))) continue;
          expect(result).toContain('pi_background_unavailable');
          expect(result).toContain('Foreground non-workflow subagents work');
          if (form === 'node-sea') for (const text of ['Node SEA', '0.87.0', 'resolveNodeExecutable',
            'fork on process.execPath', 'cannot stand in for Node', 'Bun-compiled product']) expect(result).toContain(text);
          else if (form === 'compiled-executable (configured assets)') {
            expect(result).toContain('assets beside the real executable');
            expect(result).toContain('configured Pi assets');
          } else expect(result).toContain('the background runner cannot re-enter a bundle run by an interpreter');
        }
        expect(report.gateCalls!.some(call => call.toolName === 'subagent_launch')).toBe(false);
      }
      expect(existsSync(reexecMarker)).toBe(false);
      expect(existsSync(configuredMarker)).toBe(false);
      if (form === 'compiled-executable') {
        const foreignRoot = await tempRoot('byok-hostile-bun-root-');
        const foreignBootstrap = path.join(foreignRoot, 'assets/pi-subagents/src/runs/background/binary-bootstrap.js');
        const marker = path.join(foreignRoot, 'executed');
        await fs.mkdir(path.dirname(foreignBootstrap), { recursive: true });
        await fs.writeFile(foreignBootstrap, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'foreign'); export default function foreign() {}`);
        const fixed = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-session', '--mode', 'rpc', '--extension'];
        const runnerEnv = { ...env, BYOK_PI_SUBAGENT_RUNTIME_DIR: foreignRoot, PI_SUBAGENT_RUNNER_CONFIG: path.join(runDir, 'foreign-config.json') };
        await expect(execFileAsync(host.command, [...fixed, foreignBootstrap], { env: runnerEnv, timeout: 10_000 }))
          .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('invalid SDK Pi runner re-entry') });
        const installed = path.join(release, 'pi-subagents/src/runs/background/binary-bootstrap.js');
        await fs.rename(installed, installed + '.saved');
        try {
          await fs.symlink(foreignBootstrap, installed, 'file');
          await expect(execFileAsync(host.command, [...fixed, installed], { env: runnerEnv, timeout: 10_000 }))
            .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('untrusted bundled subagent asset') });
        } finally { await fs.rm(installed, { force: true }); await fs.rename(installed + '.saved', installed); }
        expect(existsSync(marker)).toBe(false);
      }
      // The user's extension loaded against the Pi runtime in the bundle.
      expect(JSON.parse(await fs.readFile(extensionMarker, 'utf8'))).toEqual({ version: '1.5.0', schema: 'object', api: 'function' });
    } finally {
      provider.closeAllConnections();
      await new Promise<void>(resolve => provider.close(() => resolve()));
    }
  });
});
