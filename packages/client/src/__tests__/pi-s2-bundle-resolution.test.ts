import { runtimeRecordFixture } from './fixtures/runtime-resolution';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { PermissionPolicy } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { getDocsPath, getExamplesPath, getReadmePath, projectSystemPromptSnapshot } from '@earendil-works/pi-coding-agent';
import { assemblePreparedPiToolSurface } from '../adapters/pi/prepared-tools';
import { resolveInstalledPiRuntimeIdentity, createPiInputPreparationCompiler } from '../adapters/pi/input-preparation';
import { createPreparedToolSurfaceAssembler } from '../daemon/prepared-tool-surface';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import { classifyMcpToolsetServerObservation, observeMcpServer } from '../mcp/observation';
import { INPUT_PREPARATION_ARTIFACT_FORMAT, INPUT_PREPARATION_VERSION } from '../input-preparation';
import { TOOL_IMPLEMENTATION_RESOLVER_UNCONFIGURED } from '../daemon/tool-implementation-identity';
import { trustedCwd } from './fixtures/launch-cwd';

const execFileAsync = promisify(execFile);
const BUN_BIN = [process.env.BYOK_TEST_BUN_BIN, path.join(os.homedir(), '.local/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));
const CLIENT_DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const POLICY: PermissionPolicy = { mode: 'readonly', allowTools: [] };

/**
 * The bootstrap is a Salesko-style SDK consumer, not a copy of resolution code.
 * It captures the REAL adapter's final spawn after the configuration was written.
 * The same artifact's other entry is the SDK's real reserved-helper dispatcher.
 * No test resolver, native shim, custom extension loader or argv0 dispatch exists.
 */
const BUNDLE_ENTRY_SOURCE = `
import fs from 'node:fs/promises';
import path from 'node:path';
import {readFileSync} from 'node:fs';
// Both bootstrap and helper use the same fixture-only ownership seam before
// loading SDK code. It changes uid only within this artifact's release tree;
// this is not evidence of a privileged production installation.
const fixtureRelease=path.dirname(process.argv[1]);
const lstat=fs.lstat.bind(fs);
if(process.argv[2]!=='capture-untrusted') fs.lstat=async (...args)=>{
  const stat=await lstat(...args);
  const target=String(args[0]);
  return target===fixtureRelease||target.startsWith(fixtureRelease+path.sep)?Object.assign(stat,{uid:0}):stat;
};
let sdk;
try { sdk = await import(${JSON.stringify(CLIENT_DIST)}); } catch (error) {
  if(process.argv[2]==='capture'||process.argv[2]==='capture-untrusted'){
    const input=JSON.parse(await fs.readFile(process.argv[3],'utf8'));
    await fs.writeFile(input.report,JSON.stringify({stage:'sdk-module-load',error:String(error)}));
  }
  throw error;
}
if (process.argv[2] !== 'capture' && process.argv[2] !== 'capture-untrusted') {
  if (!await sdk.runSdkReservedHelperCommand(process.argv.slice(2))) throw new Error('not an SDK helper invocation');
} else {
  const input=JSON.parse(await fs.readFile(process.argv[3],'utf8'));
  let capture; let runtime; let stage='prepare'; let resolveCalls=[];
  try {
    const adapter=new sdk.PiAdapter({spawnFn:(command,args,options)=>{
      const configPath=args[args.indexOf('--config')+1];
      const configBytes=readFileSync(configPath,'utf8');
      capture={command,args,options,configPath,configBytes,config:JSON.parse(configBytes)};
      throw new Error('S2_CAPTURE_BEFORE_PROMPT');
    }});
    const prepared=await adapter.prepare({offer:{instruction:'Never sent',policy:input.policy},policy:input.policy,
      descriptor:adapter.descriptor,requiredToolsetIds:[],mcpServers:input.mcpServers,mcpToolsetTools:input.observation});
    if(prepared.kind!=='prepared') throw new Error(prepared.reason);
    stage='resolve';
    runtime=await prepared.operation.resolveRuntimeLaunch({kind:input.kind,cwd:input.cwd,env:input.env,
      projectionRoot:input.projectionRoot,authority:{resolve:async locator=>{resolveCalls.push(locator);return input.record;}}});
    stage='start';
    const manifest=sdk.sealRuntimeOperationManifest({taskId:'s2-'+input.kind,runtimeId:'pi',descriptor:adapter.descriptor,
      policy:input.policy,requiredToolsetIds:[],workspace:{workspaceDir:input.cwd},forwardedEnvironmentNames:Object.keys(runtime.env).sort()});
    await prepared.operation.start({kind:input.kind,...(input.kind==='prepared'?{preparation:input.preparation}:{instruction:'Never sent'}),
      manifest,runtimeLaunch:runtime,env:runtime.env,mcpEnv:input.mcpEnv,mcpServers:input.mcpServers,
      mcpToolsetTools:input.observation,mcpLaunch:input.launch,mcpToolImplementations:input.implementations});
    throw new Error('unexpected prompt-capable start');
  } catch(error) {
    await fs.writeFile(input.report,JSON.stringify({stage,error:String(error),capture,resolveCalls,
      binding:runtime?.binding,description:runtime?.decision,env:runtime?.env}));
  } finally {await runtime?.release();}
}
`;

interface Capture {
  command: string; args: string[]; options: { cwd: string; env: Record<string, string> };
  configPath: string; configBytes: string; config: unknown;
}
interface Report {
  stage: string; error?: string; capture?: Capture;
  binding?: { command: string; entry: string; fixedArgv: string[]; cwd: string; envCommitments: Record<string, string> };
  description?: { kind: string; description?: { assetRoot: string } };
  env?: Record<string, string>;
  resolveCalls?: unknown[];
}

async function digest(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function rpcState(capture: Capture): Promise<unknown> {
  await fs.mkdir(path.dirname(capture.configPath), { recursive: true });
  await fs.writeFile(capture.configPath, capture.configBytes);
  return await new Promise((resolve, reject) => {
    // Exact adapter capture, including argv, cwd and environment; never append
    // model flags or replace an entry to make a failed startup pass.
    const child = spawn(capture.command, capture.args, { ...capture.options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; let stdout = ''; let answer: unknown;
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stderr.on('data', bytes => { stderr += String(bytes); });
    child.stdout.on('data', bytes => {
      stdout += String(bytes);
      for (const line of stdout.split('\n').slice(0, -1)) {
        try {
          const frame = JSON.parse(line);
          if (frame.type === 'response' && frame.id === 's2-state') {
            if (frame.success) answer = frame.data;
            else stderr += JSON.stringify(frame);
            child.kill('SIGTERM');
          }
        } catch { /* Keep raw output for the startup diagnostic. */ }
      }
    });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (answer !== undefined) resolve(answer);
      else reject(new Error(`native startup exit=${code}: ${stderr}\n${stdout}`));
    });
    child.stdin.write(`${JSON.stringify({ type: 'get_state', id: 's2-state' })}\n`);
  });
}

/** Valid counted prepared input, made by the real assembler/compiler outside isolation. */
async function preparedFixture(root: string, cwd: string, env: Record<string, string>, providerUrl: string) {
  const script = path.join(root, 'mcp-fixture-server.mjs');
  await fs.copyFile(fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url)), script);
  const server = { command: process.execPath, args: [script, '{}'] };
  const registry = new McpToolsetRegistry({ 's2.echo.v1': { mcpServers: { fixture: server }, readOnlyTools: { fixture: ['echo'] } } });
  const compiler = createPiInputPreparationCompiler(resolveInstalledPiRuntimeIdentity());
  const runtimeIdentity = `${compiler.runtime.packageName}@${compiler.runtime.packageVersion}+${compiler.runtime.upstreamCommit}.${compiler.runtime.forkBuild}`;
  const assembled = await createPreparedToolSurfaceAssembler({ toolsetRegistry: registry, runtimeEnv: () => env })
    .assemble({ requiredToolsets: ['s2.echo.v1'], permissionMode: POLICY.mode, runtimeIdentity });
  if (!assembled.ok) throw new Error(`fixture assembly failed: ${assembled.detail}`);
  const surface = assembled.surface;
  const observed = await observeMcpServer('fixture', server, { env, cwd: surface.launch.launchCwd, timeoutMs: 15_000 });
  const observation = { fixture: classifyMcpToolsetServerObservation(observed, { toolsetId: 's2.echo.v1', readOnlyTools: ['echo'] }) };
  const validation = await assemblePreparedPiToolSurface({ policy: POLICY, countedPermissionMode: POLICY.mode,
    observation, toolsetDefinitionRevisions: surface.toolsetDefinitionRevisions,
    servers: [{ serverName: 'fixture', toolsetId: 's2.echo.v1', command: server.command, args: server.args }],
    launch: surface.launch, toolImplementations: { fixture: TOOL_IMPLEMENTATION_RESOLVER_UNCONFIGURED }, runtimeIdentity,
    expectedToolBindingDigest: surface.toolBindingDigest, expectedObservationDigest: surface.observationDigest,
    host: { call: async () => { throw new Error('fixture validation must not call a tool'); } } });
  if (!validation.ok) throw new Error(`invalid prepared fixture: ${validation.code}: ${validation.message}`);
  const model = { id: 'glm-4.6', name: 'Synthetic GLM 4.6 fixture', api: 'openai-completions' as const, provider: 'zai',
    baseUrl: providerUrl, reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192, maxTokens: 1024 };
  const binding = { inputIdentity: 's2-input', runtimeIdentity, policyIdentity: 's2-policy', profileRevision: 's2-profile' };
  // A startup-only fixture. No prompt_prepared frame is ever sent, but the
  // retained envelope is real, rather than bypassing the adapter's artifact guard.
  const compiled = await compiler.compile({ snapshot: { prompt: projectSystemPromptSnapshot({ cwd, selectedTools: surface.tools.map(tool => tool.name),
    toolSnippets: {}, promptGuidelines: [], contextFiles: [], formattedSkills: '',
    docsPaths: { readmePath: getReadmePath(), docsPath: getDocsPath(), examplesPath: getExamplesPath() } }),
    messages: [{ role: 'user', content: 'Never sent', timestamp: 1 }], tools: surface.tools },
    model, options: { cacheRetention: 'none', maxTokens: 512 }, binding, toolExecutors: surface.toolExecutors });
  const artifactPath = path.join(root, 'prepared-artifact.json');
  await fs.writeFile(artifactPath, JSON.stringify({ format: INPUT_PREPARATION_ARTIFACT_FORMAT, version: INPUT_PREPARATION_VERSION,
    recordId: 's2-record', requestDigest: compiled.requestDigest, envelopeDigest: compiled.envelopeDigest,
    toolManifestDigest: compiled.toolManifestDigest, requestBody: compiled.requestBody, counterProjection: compiled.counterProjection,
    projection: compiled.projection, residual: [...compiled.residual], envelope: compiled.envelope }));
  return { model, runtime: compiler.runtime, mcpServers: { fixture: server }, observation,
    implementations: { fixture: TOOL_IMPLEMENTATION_RESOLVER_UNCONFIGURED }, launch: { cwd: surface.launch.launchCwd },
    preparation: { reference: { scopeId: 's2', agentRef: 's2', requestId: 's2', recordId: 's2-record' }, artifactPath,
      expected: { envelopeDigest: compiled.envelopeDigest, toolManifestDigest: compiled.toolManifestDigest, model, binding },
      permissionMode: POLICY.mode, toolBindingDigest: surface.toolBindingDigest, observationDigest: surface.observationDigest,
      launch: { cwd: surface.launch.launchCwd }, toolImplementations: { fixture: TOOL_IMPLEMENTATION_RESOLVER_UNCONFIGURED },
      toolsetDefinitionRevisions: surface.toolsetDefinitionRevisions }, cwd };
}

describe('Pi launch path — S2 release containment', () => {
  it.skipIf(BUN_BIN === undefined)(
    'resolves every Pi launch path inside the release, with no escape into the bun install cache and no auto-install',
    async () => {
      const bun = BUN_BIN!;
      const release = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-s2-release-')));
      const runDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-s2-run-')));
      const cacheDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-s2-cache-')));
      const registryAttempts: string[] = []; let providerRequests = 0;
      const registry = createServer((request, response) => { registryAttempts.push(request.url ?? ''); response.writeHead(503).end(); });
      const provider = createServer((_request, response) => { providerRequests++; response.writeHead(503).end(); });
      await Promise.all([new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve)), new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))]);
      try {
        const registryUrl = `http://127.0.0.1:${(registry.address() as { port: number }).port}`;
        const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
        const home = path.join(runDir, 'empty-home'); await fs.mkdir(home);
        // Bootstrap alone uses --no-install and an explicit Bun cache. The real
        // prepared host rejects BUN_* loader controls, so its exact captured
        // environment instead isolates HOME and we audit the default cache too.
        const env = { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: runDir, npm_config_registry: registryUrl,
          PI_CODING_AGENT_DIR: path.join(runDir, 'agent') };
        const bootstrapEnv = { ...env, BUN_INSTALL_CACHE_DIR: cacheDir, BUN_CONFIG_DEFAULT_REGISTRY: registryUrl };
        const fixture = await preparedFixture(runDir, runDir, { PATH: env.PATH }, providerUrl);
        await fs.mkdir(env.PI_CODING_AGENT_DIR);
        await fs.writeFile(path.join(env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { zai: {
          api: 'openai-completions', baseUrl: providerUrl, apiKey: 'synthetic-never-sent', models: [fixture.model] } } }));
        await fs.writeFile(path.join(env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'zai', defaultModel: 'glm-4.6' }));
        await fs.writeFile(path.join(release, 'sdk-entry.ts'), BUNDLE_ENTRY_SOURCE);
        await execFileAsync(bun, ['build', './sdk-entry.ts', '--target', 'bun', '--format', 'esm', '--outfile', './sdk-entry.js'], { cwd: release });
        const bundle = path.join(release, 'sdk-entry.js');
        const interpreter = path.join(release, 'bun'); await fs.copyFile(bun, interpreter); await fs.chmod(interpreter, 0o555);
        await fs.chmod(bundle, 0o444);
        // Interpreted runtime assets from the exact installed pin. No Node
        // package implementation or node_modules is copied; export template/
        // vendor scripts are browser export resources. Photon WASM is executable
        // code, sealed here as a component; its loader closure awaits native gate.
        const nativeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
        const assetRoot = path.join(release, 'assets');
        const assetPaths = ['package.json', 'dist/modes/interactive/theme/dark.json', 'dist/modes/interactive/theme/light.json',
          'dist/core/export-html/template.html', 'dist/core/export-html/template.css', 'dist/core/export-html/template.js',
          'dist/core/export-html/vendor/marked.min.js', 'dist/core/export-html/vendor/highlight.min.js'];
        const assets: Array<{ path: string; digest: string }> = [];
        for (const relative of assetPaths) {
          const target = path.join(assetRoot, relative); await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(path.join(nativeRoot, relative), target); await fs.chmod(target, 0o444);
          assets.push({ path: relative, digest: await digest(target) });
        }
        const nativeRequire = createRequire(path.join(nativeRoot, 'package.json'));
        const photonSource = path.join(path.dirname(nativeRequire.resolve('@silvia-odwyer/photon-node')), 'photon_rs_bg.wasm');
        const photonTarget = path.join(assetRoot, 'photon_rs_bg.wasm');
        await fs.copyFile(photonSource, photonTarget); await fs.chmod(photonTarget, 0o444);
        assets.push({ path: 'photon_rs_bg.wasm', digest: await digest(photonTarget) });
        assets.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        const paths: Record<string, string> = {}; const tier1: string[] = []; const nativeBlockers: string[] = [];
        for (const kind of ['instruction', 'prepared'] as const) {
          const entryKind = kind === 'instruction' ? 'pi-rpc' : 'pi-prepared';
          const reportPath = path.join(runDir, `${kind}-report.json`);
          const inputPath = path.join(runDir, `${kind}-input.json`);
          const record = { kind: 'attested', authority: 'host-install-record', manifestRevision: 's2-fixture', form: 'interpreter+bundle',
            installPath: bundle, closureDigest: await digest(bundle), closureKind: 'artifact',
            interpreter: { path: interpreter, digest: await digest(interpreter), // Synthetic host assertion, not a platform installer/load-command verification.
              loadCommandsDigest: '0'.repeat(64) },
            launchArgv: ['__byok_sdk_helper', entryKind], launchCwd: await trustedCwd(), assetRoot, assets,
            nativeProvenance: { packageName: fixture.runtime.packageName, packageVersion: fixture.runtime.packageVersion,
              upstreamBase: fixture.runtime.upstreamBase, upstreamCommit: fixture.runtime.upstreamCommit,
              forkBuild: fixture.runtime.forkBuild, compilerVersion: fixture.runtime.compilerVersion } };
          await fs.writeFile(inputPath, JSON.stringify({ ...fixture, release, policy: POLICY, kind, env, mcpEnv: { PATH: env.PATH },
            record: runtimeRecordFixture(record as never), projectionRoot: path.join(runDir, 'projections'), report: reportPath }));
          // With the fixture ownership seam OFF, the real product must reject
          // this non-root-owned artifact before final spawn. Not an installer test.
          if (kind === 'instruction' && process.getuid !== undefined && process.getuid() !== 0) {
            await execFileAsync(interpreter, ['--no-install', bundle, 'capture-untrusted', inputPath], { cwd: runDir, env: bootstrapEnv, timeout: 20_000 });
            const untrusted = JSON.parse(await fs.readFile(reportPath, 'utf8')) as Report;
            expect(untrusted.stage).toBe('resolve');
            expect(untrusted.error).toContain('runtime implementation unavailable: install_record_mismatch');
            expect(untrusted.capture).toBeUndefined();
            console.info('S2 ownership negative: actual uid rejected without the fixture uid seam; spawns=0');
          }
          try { await execFileAsync(interpreter, ['--no-install', bundle, 'capture', inputPath], { cwd: runDir, env: bootstrapEnv, timeout: 20_000 }); }
          catch (error) {
            if (!existsSync(reportPath)) { nativeBlockers.push(`${entryKind} bootstrap failed before adapter evidence: ${String(error)}`); continue; }
          }
          const report = JSON.parse(await fs.readFile(reportPath, 'utf8')) as Report;
          if (report.stage === 'sdk-module-load') { nativeBlockers.push(`${entryKind} SDK/native graph load (Tier 1 unresolved): ${report.error}`); continue; }
          if (!report.capture || !report.binding || !report.env) { tier1.push(`${entryKind} ${report.stage}: ${report.error}`); continue; }
          expect(report.resolveCalls).toEqual([{ subject: { kind: 'runtime', runtimeId: 'pi' }, runtimeEntry: entryKind }]);
          expect(report.capture.command).toBe(report.binding.command);
          expect(report.capture.args.slice(0, 3)).toEqual([report.binding.entry, ...report.binding.fixedArgv]);
          expect(report.capture.options.cwd).toBe(report.binding.cwd);
          expect(report.capture.options.env.PI_PACKAGE_DIR).toBe(report.binding.envCommitments.PI_PACKAGE_DIR);
          paths[`${entryKind}.command`] = report.binding.command;
          paths[`${entryKind}.entry`] = report.binding.entry;
          expect(report.description?.kind).toBe('attested');
          expect(report.description?.description?.assetRoot).toBe(report.env.PI_PACKAGE_DIR);
          paths[`${entryKind}.PI_PACKAGE_DIR`] = report.env.PI_PACKAGE_DIR!;
          paths[`${entryKind}.assetRoot`] = report.description!.description!.assetRoot;
          try {
            const state = await rpcState(report.capture) as { messageCount: number; model: { id: string } };
            expect(state.messageCount).toBe(0); expect(state.model.id).toBe(fixture.model.id);
          } catch (error) {
            const detail = String(error);
            if (/installed pi closure could not be verified|Cannot find package|Could not resolve.*package/u.test(detail)) tier1.push(`${entryKind} startup resolution: ${detail}`);
            else nativeBlockers.push(`${entryKind}: ${detail}`);
          } finally { await fs.rm(path.dirname(report.capture.configPath), { recursive: true, force: true }); }
        }
        // These paths are real adapter outputs; authored record/fixture paths
        // are never substituted when resolution failed before a binding existed.
        const result = { paths };
        const escaped = Object.entries(result.paths)
          .filter(([, resolved]) =>
            !resolved.startsWith(release + path.sep) || resolved.includes(`${path.sep}install${path.sep}cache${path.sep}`))
          .map(([name, resolved]) => `${name} -> ${resolved}`);
        const childCache = path.join(home, '.bun', 'install', 'cache');
        console.info(JSON.stringify({ tier1, nativeBlockers, resolvedPaths: paths, escaped,
          bootstrapCache: await fs.readdir(cacheDir), childCache: existsSync(childCache) ? await fs.readdir(childCache) : [],
          registryAttempts, providerRequests }));
        expect(escaped, `Pi launch paths resolved outside the release ${release}`).toEqual([]);
        expect(await fs.readdir(cacheDir), 'the S2 launch path auto-installed into the bun cache').toEqual([]);
        expect(existsSync(childCache) ? await fs.readdir(childCache) : [], 'the actual host auto-installed into its isolated HOME cache').toEqual([]);
        // Bun 1.4.2 registry override was independently measured with two
        // loopback tripwires; this does not claim whole-network isolation.
        expect(registryAttempts, 'local registry tripwire observed an install attempt (not a whole-network isolation claim)').toEqual([]);
        expect(providerRequests, 'startup must never send a provider request').toBe(0);
        expect(tier1, 'Tier 1 real SDK bootstrap/launch resolution').toEqual([]);
        if (nativeBlockers.length === 0) expect(Object.keys(paths)).toHaveLength(8);
        expect(nativeBlockers, 'Tier 2 native startup blockers; not evidence that Tier 1 escaped or passed').toEqual([]);
      } finally {
        await Promise.all([new Promise<void>(resolve => registry.close(() => resolve())), new Promise<void>(resolve => provider.close(() => resolve()))]);
        await Promise.all([release, runDir, cacheDir].map(dir => fs.rm(dir, { recursive: true, force: true })));
      }
    }, 120_000,
  );
});
