import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
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

const execFileAsync = promisify(execFile);
const BUN_BIN = resolveBunBin();
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
    expect(files).toEqual(expectedInventory(form));
    const written = await fs.readdir(outDir, { recursive: true, withFileTypes: true });
    expect(written.filter(entry => entry.isFile()).map(entry => path.relative(outDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort())
      .toEqual(files);
    const pinned = JSON.parse(await fs.readFile(path.join(outDir, 'package.json'), 'utf8'));
    expect([pinned.name, pinned.version]).toEqual([sdk.PI_PACKAGE_NAME, '1.1.0']);
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
import * as sdk from ${JSON.stringify(CLIENT_DIST)};
if (process.argv[2] !== 'task') {
  if (!await sdk.runSdkReservedHelperCommand(process.argv.slice(2))) { process.stderr.write('unknown product command\\n'); process.exit(2); }
} else {
  const input = JSON.parse(await fs.readFile(process.argv[3], 'utf8'));
  const report = { stage: 'lookup' };
  try {
    try { await import(input.piSpecifier); report.lookup = 'resolved'; } catch (error) { report.lookup = String(error); }
    report.defaultDetect = await new sdk.PiAdapter().detect();
    const adapter = new sdk.PiAdapter({ sdkHelperHost: { mode: 'self-executable', executable: process.execPath,
      ...(input.bundleEntry ? { entry: process.argv[1] } : {}) } });
    report.stage = 'detect'; report.detect = await adapter.detect();
    report.stage = 'prepare';
    const prepared = await adapter.prepare({ offer: { instruction: input.instruction }, descriptor: adapter.descriptor,
      requiredToolsetIds: [], mcpServers: {}, mcpToolsetTools: {} });
    if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
    report.stage = 'resolve';
    const runtime = await prepared.operation.resolveRuntimeLaunch({ kind: 'instruction', cwd: input.cwd, env: input.env, projectionRoot: input.projectionRoot });
    report.launch = { command: runtime.command, entry: runtime.entry, fixedArgs: runtime.fixedArgs };
    report.stage = 'start';
    const manifest = sdk.sealRuntimeOperationManifest({ taskId: 'host-payload', runtimeId: 'pi', descriptor: adapter.descriptor,
      requiredToolsetIds: [], workspace: { workspaceDir: input.cwd }, forwardedEnvironmentNames: Object.keys(runtime.env).sort() });
    const session = await prepared.operation.start({ kind: 'instruction', instruction: input.instruction, manifest, runtimeLaunch: runtime,
      env: runtime.env, mcpEnv: { PATH: input.env.PATH }, mcpServers: {}, mcpToolsetTools: {} });
    report.stage = 'events'; report.events = [];
    // A session stays open for follow-ups; the task's turn ends at turn_end.
    for await (const event of session.events) {
      report.events.push(event); await fs.writeFile(input.report, JSON.stringify(report));
      if (event.type === 'turn_end') break;
    }
    report.stage = 'close'; await session.close();
    report.stage = 'done';
  } catch (error) { report.error = String(error); }
  await fs.writeFile(input.report, JSON.stringify(report));
}
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
  stage: string; error?: string; lookup?: string;
  defaultDetect?: { kind: string }; detect?: unknown;
  launch?: { command: string; entry?: string; fixedArgs: string[] };
  events?: AgentEvent[];
}

function completion(res: ServerResponse, content: string): void {
  const base = { id: 'cmpl-host-payload', object: 'chat.completion.chunk', created: 0, model: 'host-payload-model' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end([
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
}

interface HostLayout {
  /** The command that starts the product, and its fixed launch argv before the product command. */
  readonly command: string;
  readonly prefix: readonly string[];
  /** The expected adapter launch. */
  readonly entry?: string;
  /** `PI_PACKAGE_DIR`, when the asset root is not beside the executable. */
  readonly piPackageDir?: string;
  readonly files: readonly string[];
}

/**
 * A host form and, for `interpreter+bundle`, the interpreter that runs the
 * bundle: Bun, or Node as in issue #341.
 */
type HostCase = 'interpreter+bundle (bun)' | 'interpreter+bundle (node)' | 'compiled-executable';

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
  const sdk = await loadClient();
  await fs.writeFile(path.join(buildDir, 'host-entry.ts'), HOST_ENTRY_SOURCE);
  if (host !== 'compiled-executable') {
    const form = 'interpreter+bundle';
    const node = host === 'interpreter+bundle (node)';
    const interpreter = path.join(release, node ? 'node' : 'bun');
    await fs.copyFile(node ? process.execPath : BUN_BIN!, interpreter); await fs.chmod(interpreter, 0o555);
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
  const form = 'compiled-executable';
  // The asset root is the executable directory: write the assets before the executable.
  const assets = await sdk.copyPiRuntimeAssets({ outDir: release, form });
  const executable = path.join(release, 'host');
  await execFileAsync(BUN_BIN!, ['build', 'host-entry.ts', '--compile', '--outfile', executable], { cwd: buildDir });
  return { command: executable, prefix: [], files: [...new Set(['host', ...assets.map(file => file.split('/')[0]!)])].sort() };
}

describe('official Pi in a host payload (sdkHelperHost + copyPiRuntimeAssets)', () => {
  it.skipIf(BUN_BIN === undefined).for(['interpreter+bundle (bun)', 'interpreter+bundle (node)', 'compiled-executable'] as const)('runs a Pi task from the %s host form with no package lookup', { timeout: 180_000 }, async (form, { skip }) => {
    const release = await tempRoot('byok-host-payload-release-');
    const buildDir = await tempRoot('byok-host-payload-build-');
    const runDir = await tempRoot('byok-host-payload-run-');
    const bodies: string[] = [];
    const provider = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => { bodies.push(body); completion(response, 'HOST_PAYLOAD_OK'); });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    try {
      const host = await buildHost(form, release, buildDir, skip);
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
      const cwd = path.join(runDir, 'workspace'); await fs.mkdir(cwd);
      const home = path.join(runDir, 'home'); await fs.mkdir(home);
      // A dead loopback registry: an auto-install attempt fails instead of reaching a network.
      const deadRegistry = 'http://127.0.0.1:9';
      const env = { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: runDir, PI_CODING_AGENT_DIR: agentDir,
        npm_config_registry: deadRegistry, BUN_CONFIG_DEFAULT_REGISTRY: deadRegistry,
        ...(host.piPackageDir === undefined ? {} : { PI_PACKAGE_DIR: host.piPackageDir }) };
      const reportPath = path.join(runDir, 'report.json'); const inputPath = path.join(runDir, 'input.json');
      await fs.writeFile(inputPath, JSON.stringify({ piSpecifier: PI_SPECIFIER, instruction: 'Reply with the host payload marker.',
        bundleEntry: host.entry !== undefined, cwd, env, projectionRoot: path.join(runDir, 'projections'), report: reportPath }));

      await execFileAsync(host.command, [...host.prefix, 'task', inputPath], { cwd: runDir, env, timeout: 60_000 }).catch(async (error: unknown) => {
        throw new Error(`host task failed: ${String(error)}\nreport: ${await fs.readFile(reportPath, 'utf8').catch(() => 'none')}`);
      });
      const report = JSON.parse(await fs.readFile(reportPath, 'utf8')) as HostReport;
      expect(report.error, `failed at ${report.stage}`).toBeUndefined();
      expect(report.stage).toBe('done');
      // Package lookup is denied, and the default adapter reproduces the reported probe failure.
      expect(report.lookup).toMatch(/Cannot find (package|module)/u);
      expect(report.defaultDetect).toEqual({ kind: 'probe-failed' });
      expect(report.detect).toEqual({ kind: 'available', version: '1.1.0', authPresent: false });
      expect(report.launch).toEqual({ command: host.command, ...(host.entry === undefined ? {} : { entry: host.entry }),
        fixedArgs: ['__byok_sdk_helper', 'pi-rpc'] });
      const events = report.events!;
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      expect(events.filter(event => event.type === 'progress').map(event => event.text).join('')).toBe('HOST_PAYLOAD_OK');
      expect(events.at(-1)).toEqual({ type: 'turn_end' });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain('Reply with the host payload marker.');
      // The user's extension loaded against the Pi runtime in the bundle.
      expect(JSON.parse(await fs.readFile(extensionMarker, 'utf8'))).toEqual({ version: '1.1.0', schema: 'object', api: 'function' });
    } finally {
      provider.closeAllConnections();
      await new Promise<void>(resolve => provider.close(() => resolve()));
    }
  });
});
