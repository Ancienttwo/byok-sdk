import { testScratchRoot } from './fixtures/execution-scratch';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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
    const adapter = new sdk.PiAdapter({ runtimeEnvironment: { pass: ['PI_CODING_AGENT_DIR', 'PAYLOAD_TEST_PRODUCT_REEXEC'] }, sdkHelperHost: { mode: 'self-executable', executable: process.execPath,
      ...(input.bundleEntry ? { entry: process.argv[1] } : {}) }, ...(input.piPackageDir === undefined ? {} : { packageDir: input.piPackageDir }) });
    report.stage = 'detect'; report.detect = await adapter.detect();
    report.stage = 'prepare';
    const prepared = await adapter.prepare({ offer: { instruction: input.instruction }, descriptor: adapter.descriptor,
      requiredToolsetIds: [], mcpServers: {}, mcpToolsetTools: {} });
    if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
    const scratch=await sdk.createExecutionScratch({root:input.scratchRoot});
    report.stage = 'resolve';
    const runtime = await prepared.operation.resolveRuntimeLaunch({ kind: 'instruction', cwd: input.cwd, env: input.env, scratch });
    report.launch = { command: runtime.command, entry: runtime.entry, fixedArgs: runtime.fixedArgs };
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
  gateCalls?: { toolName: string; nativeAgentId?: string }[];
}

function completion(res: ServerResponse, content: string, tool?: { name: string; arguments: string }): void {
  const base = { id: 'cmpl-host-payload', object: 'chat.completion.chunk', created: 0, model: 'host-payload-model' };
  const delta = tool === undefined ? { role: 'assistant', content } : { role: 'assistant', tool_calls: [{ index: 0, id: `call-${content}`, type: 'function', function: tool }] };
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
    const provider = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const tools = (JSON.parse(body) as { tools?: { function: { name: string } }[] }).tools ?? [];
        if (!tools.some(tool => tool.function.name === 'subagent')) {
          // The child reads one file, which its gate extension must authorize, then answers.
          childBodies.push(body);
          if (childBodies.length === 1) completion(response, 'child-read', { name: 'read', arguments: JSON.stringify({ path: 'child-input.txt' }) });
          else completion(response, 'CHILD_OK');
          return;
        }
        bodies.push(body);
        if (bodies.length < 3) completion(response, String(bodies.length), subagentCall(bodies.length === 2));
        else completion(response, 'HOST_PAYLOAD_OK');
      });
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
        bundleEntry: host.entry !== undefined, piPackageDir: host.piPackageDir, cwd, env, scratchRoot: testScratchRoot(), report: reportPath }));

      await execFileAsync(host.command, [...host.prefix, 'task', inputPath], { cwd: runDir, env, timeout: 60_000 }).catch(async (error: unknown) => {
        throw new Error(`host task failed: ${String(error)}\nreport: ${await fs.readFile(reportPath, 'utf8').catch(() => 'none')}`);
      });
      const report = JSON.parse(await fs.readFile(reportPath, 'utf8')) as HostReport;
      expect(report.error, `failed at ${report.stage}`).toBeUndefined();
      expect(report.stage).toBe('done');
      // Package lookup is denied, and the default adapter reproduces the reported probe failure.
      // The only Pi package a lookup can find is the foreign one above the release.
      expect(report.lookup).toMatch(/^foreign$|Cannot find (package|module)/u);
      expect(report.defaultDetect).toEqual({ kind: 'probe-failed' });
      // The default provider's models.json apiKey is pi's login (#345).
      expect(report.detect).toEqual({
        kind: 'available', version: '1.5.0', authPresent: true,
        versionVerdict: { state: 'allow', qualifiedVersion: '1.5.0' },
      });
      expect(report.launch).toEqual({ command: host.command, ...(host.entry === undefined ? {} : { entry: host.entry }),
        fixedArgs: ['__byok_sdk_helper', 'pi-rpc'] });
      const events = report.events!;
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      expect(events.filter(event => event.type === 'progress').map(event => event.text).join('')).toBe('HOST_PAYLOAD_OK');
      expect(events.at(-1)).toEqual({ type: 'turn_end' });
      expect(bodies).toHaveLength(3);
      expect(bodies[0]).toContain('Reply with the host payload marker.');
      // #1589: the foreground child ran in the product's Pi from the asset root. The
      // background run is refused with a tool error, never re-executes the product,
      // and no child of it reaches the provider.
      expect(childBodies).toHaveLength(2);
      expect(report.gateCalls).toContainEqual({ toolName: 'read', nativeAgentId: expect.stringMatching(/^pi-subagent:/u) });
      const results = (JSON.parse(bodies[2]!) as { messages: { role: string; content: unknown }[] }).messages
        .filter(message => message.role === 'tool').map(message => JSON.stringify(message.content));
      expect(results).toHaveLength(2);
      expect(results[0]).toContain('CHILD_OK');
      // The compiled form's Pi executable override is the launch-private directory, which cannot be spawned.
      expect(results[1]).toMatch(form === 'compiled-executable'
        ? /Failed to start async run .*async runner did not produce a pid/u
        : /Failed to start async run .*Background children require the host npm package \(@earendil-works\/pi-coding-agent\) with its dependencies/u);
      expect(existsSync(reexecMarker)).toBe(false);
      // The user's extension loaded against the Pi runtime in the bundle.
      expect(JSON.parse(await fs.readFile(extensionMarker, 'utf8'))).toEqual({ version: '1.5.0', schema: 'object', api: 'function' });
    } finally {
      provider.closeAllConnections();
      await new Promise<void>(resolve => provider.close(() => resolve()));
    }
  });
});
