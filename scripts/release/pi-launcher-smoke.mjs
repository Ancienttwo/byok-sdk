// Installed composition: no prompt, provider request, real profile or OS key access.
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { SqliteProviderProfileStore, parseModelProviderProfile, exactProviderProfileBinding, buildPiProviderProjection } from '@byok-sdk/keys';
import { parsePiRuntimeIdentity, PI_DEPENDENCY_SPECIFIER } from './pi-runtime-identity.mjs';

import { PiAdapter } from '@byok-sdk/client/adapters';
import { resolveTrustedLaunchCwd, sealRuntimeOperationManifest } from '@byok-sdk/client';

const require = createRequire(import.meta.url);
const keysRoot = path.dirname(require.resolve('@byok-sdk/keys/package.json'));
const clientRoot = path.dirname(require.resolve('@byok-sdk/client/package.json'));
// Exact client dependency, never an unversioned PATH executable. The pin is an
// npm alias onto the SDK's Pi fork, so the specifier and the installed path
// stay upstream while the manifest inside carries the fork identity.
const piEntry = fileURLToPath(import.meta.resolve(PI_DEPENDENCY_SPECIFIER));
const piRoot = path.dirname(path.dirname(piEntry));
const piManifest = JSON.parse(await readFile(path.join(piRoot, 'package.json'), 'utf8'));
const clientManifest = JSON.parse(await readFile(path.join(clientRoot, 'package.json'), 'utf8'));
const piRuntime = parsePiRuntimeIdentity(clientManifest, '@byok-sdk/client package.json');
assert.equal(piManifest.name, piRuntime.packageName);
assert.equal(piManifest.version, piRuntime.version);
const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'packed-pi-launcher-')));
const projectionRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'packed-pi-projections-')));
const sdkPiEntry = path.join(clientRoot, 'dist/bin/byok-pi-rpc.js');
let requests = 0;
const server = createServer((_req, res) => { requests++; res.writeHead(500); res.end('No inference allowed'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const modelConfig = {
  contextWindow: 1_000_000, maxTokens: 131_072, reasoning: true, thinkingLevel: 'low',
  thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
  compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true,
    supportsUsageInStreaming: true, maxTokensField: 'max_tokens', thinkingFormat: 'zai', zaiToolStream: true },
};
let child;
async function rpcState(command,args,options,custodyProbe) {
  child=spawn(command,args,{...options,stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close');
  let stderr=''; child.stderr.on('data',bytes=>{stderr+=bytes.toString();});
  const lines=createInterface({input:child.stdout});
  const timer=setTimeout(()=>child.kill('SIGTERM'),30_000);
  try {
    const iterator = lines[Symbol.asyncIterator]();
    const request = async (frame) => {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
      for (;;) {
        const line = await iterator.next();
        if (line.done) throw new Error(stderr || `SDK Pi closed before ${frame.type}`);
        const event = JSON.parse(line.value);
        if (event.type === 'response' && event.id === frame.id) {
          assert.equal(event.success, true, event.error || stderr);
          return event.data;
        }
      }
    };
    const state = await request({type:'get_state',id:'packed-state'});
    if (custodyProbe !== undefined) {
      // Native RPC has a command string, so serialize these two fixed absolute
      // argv elements with POSIX shell quoting. No task text or secrets enter it.
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      const argv = [process.execPath, custodyProbe];
      assert.ok(argv.every(value => path.isAbsolute(value)));
      const result = await request({type:'bash',id:'custody-probe',command:argv.map(quote).join(' '),excludeFromContext:true});
      assert.equal(result.exitCode,0,JSON.stringify(result));
      const observed = JSON.parse(result.output.trim());
      assert.equal(await realpath(observed.cwd),dir);
      assert.deepEqual(observed.present,[],'ambient canary/control names reached the keys-launched runtime');
      const after = await request({type:'get_messages',id:'after-probe'});
      assert.equal(after.messages.length,1,'custody probe must be the only session message');
      assert.equal(after.messages[0].role,'bashExecution');
      assert.equal(after.messages[0].excludeFromContext,true,'custody probe entered model context');
    }
    return state;
  } finally {
    clearTimeout(timer);lines.close();child.stdin.end();child.kill('SIGTERM');
    const force=setTimeout(()=>child.kill('SIGKILL'),5_000);
    await closed;clearTimeout(force);
  }
}
try {
  const sessionDir = path.join(dir, 'sessions');
  const profileDbPath = path.join(dir, 'profiles.db');
  const toolsMarker = path.join(dir, 'active-tools.json');
  const mcpConfigPath = path.join(dir, 'mcp.json');
  const custodyProbe = path.join(dir, 'custody-probe.mjs');
  await writeFile(custodyProbe, `const names=['ZAI_API_KEY','UNRELATED_CANARY','BYOK_PI_MCP_CONFIG_PATH','BYOK_PI_PERMISSION_MODE']; process.stdout.write(JSON.stringify({cwd:process.cwd(),present:names.filter(name=>process.env[name]!==undefined)})+'\\n');`);
  const toolsObserver = path.join(dir, 'tools-observer.mjs');
  const sdkMcpExtension = path.join(clientRoot, 'dist/adapters/pi/mcp-extension.js');
  const reservedServerCwdMarker = path.join(dir, 'reserved-server-cwd.txt');
  // The directory proof is a property of the HOST, not of the packed tarball,
  // and a host that cannot prove it is not a packaging failure. An elevated
  // Windows runner can write `%SystemRoot%` (`platform_default_is_writable`)
  // and a uid-0 POSIX daemon can write everything
  // (`root_cannot_prove_write_boundary`); both refusals are the boundary
  // working. So this smoke branches rather than asserting a proof it cannot
  // demand: with a directory, it runs the full launch smoke below; without
  // one, it asserts the FAIL-CLOSED path instead — the packed adapter must
  // refuse to start a non-empty `mcpServers` task with no launch binding, and
  // must surface why. Any other `unavailable` reason still fails the smoke.
  //
  // `BYOK_RELEASE_SMOKE_FORCE_UNPROVABLE_LAUNCH_CWD=1` makes the resolver
  // report `root_cannot_prove_write_boundary` on a host where the proof would
  // have succeeded. It exists so the fail-closed branch is executable — and is
  // executed — off Windows; it is a test seam, never a product path.
  const trustedLaunch = await resolveTrustedLaunchCwd(
    undefined,
    process.env.BYOK_RELEASE_SMOKE_FORCE_UNPROVABLE_LAUNCH_CWD === '1' ? { getuid: () => 0 } : {},
  );
  const launchUnprovable = trustedLaunch.kind !== 'resolved';
  if (launchUnprovable) {
    assert.ok(
      trustedLaunch.reason === 'platform_default_is_writable'
        || trustedLaunch.reason === 'root_cannot_prove_write_boundary',
      `no trusted MCP launch directory here, and the reason is not one this smoke accepts: ${trustedLaunch.reason}`,
    );
    console.log(`pi-launcher-smoke: trusted launch directory unavailable (${trustedLaunch.reason}); asserted fail-closed refusal instead`);
  } else {
    assert.notEqual(trustedLaunch.dir, dir);
  }
  // A real stdio MCP server, so the installed package's own MCP extension is
  // run against a server that really has to start and really has to answer,
  // rather than stubbed away. Hand-rolled for the same reason the in-repo
  // fixtures are: the SDK ships an MCP client, not a server, and the release
  // smoke must not grow a dependency the published package does not have.
  //
  // What this proves and what it does not: the extension loads inside the
  // installed Pi, registers one tool per OBSERVED tool for the host toolset
  // server, and — for the SDK-reserved helper below — really connects,
  // handshakes and reads `tools/list` off a live child through
  // `McpServerPool`. It does NOT reach `tools/call`: only a model turn invokes
  // a registered tool, and this smoke sends no prompt and allows no inference.
  // The call path (lazy open, drift re-verification, the call itself, the
  // close) is covered against the same shape of server by
  // `packages/client/src/__tests__/mcp-extension-call.test.ts`.
  const fixtureServer = path.join(dir, 'fixture-mcp-server.mjs');
  await writeFile(fixtureServer, `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
// The directory this server was actually started in, read back out of the
// child. Both runtime and MCP process cwd must use the proven sealed directory;
// the writable session cwd is transported separately in the SDK host config.
let initialized = false;
const TOOL = { name: process.argv[2] ?? 'echo', description: 'Echo text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } };
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined || request.id === null) {
    if (request.method === 'notifications/initialized') initialized = true;
    return;
  }
  if (request.method === 'initialize') return reply(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'byok-release-fixture', version: '1.0.0' } });
  if (request.method === 'tools/list' && initialized) {
    if (process.argv[3]) writeFileSync(process.argv[3], process.cwd());
    return reply(request.id, { tools: [TOOL] });
  }
  if (request.method === 'tools/call') return reply(request.id, { content: [{ type: 'text', text: 'ok' }], isError: false });
});
`);
  // Exactly what the daemon would hand a task: the servers plus the
  // observation it took at admission. The extension registers from the
  // observation and discovers nothing of its own.
  const mcpTaskConfig = {
    mcpEnv: { PATH: process.env.PATH ?? '', HOME: dir },
    mcpServers: {
      fixture: { command: process.execPath, args: [fixtureServer] },
      // An SDK-RESERVED helper, which the extension reads live at
      // `session_start` instead of from an observation. It is the one entry
      // that makes the installed `McpServerPool` open a real connection during
      // this smoke; a host toolset server stays unopened until it is called.
      byokagentteam: { command: process.execPath, args: [fixtureServer, 'relay_probe', reservedServerCwdMarker] },
    },
    observation: {
      fixture: {
        toolsetId: 'release.smoke.v1',
        serverName: 'fixture',
        serverInfo: { name: 'byok-release-fixture', version: '1.0.0' },
        protocolVersion: '2025-11-25',
        tools: [{
          name: 'echo',
          description: 'Echo text back.',
          // The operator's own read/mutation classification. Required under
          // the `readonly` policy this smoke runs, which is what makes the
          // tool registrable at all.
          readOnly: true,
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        }],
      },
    },
    permissionMode: 'readonly',
    toolImplementations: {},
    // The daemon resolves this once per offer and the extension refuses to open
    // any server without it; the installed package must therefore honour it out
    // of the packed tarball, launcher script included. Absent on a host where
    // no directory could be proven — which is exactly the shape the fail-closed
    // branch below requires the packed extension to refuse.
    ...(launchUnprovable ? {} : { launchCwd: trustedLaunch.dir }),
  };
  await writeFile(mcpConfigPath, JSON.stringify(mcpTaskConfig));
  // Separate installed MCP registry proof. The SDK host intentionally accepts
  // no caller extensions and native RPC has no tool-registry inspection. This
  // no-prompt native session uses the same installed SDK MCP factory with one
  // inline test observer; it is NOT registry evidence inside the keys child.
  await writeFile(toolsObserver, `import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createAgentSessionServices,createAgentSession,AgentSessionRuntime} from ${JSON.stringify(piEntry)};
import {createByokMcpExtension} from ${JSON.stringify(sdkMcpExtension)};
const config=JSON.parse(readFileSync(${JSON.stringify(mcpConfigPath)},'utf8'));
const services=await createAgentSessionServices({
 cwd:${JSON.stringify(dir)},agentDir:${JSON.stringify(path.join(dir,'observer-agent'))},
 resourceLoaderOptions:{noExtensions:true,noSkills:true,extensionFactories:[
  createByokMcpExtension(config),
  pi=>pi.on('session_start',()=>writeFileSync(${JSON.stringify(toolsMarker)},JSON.stringify(pi.getActiveTools())))
 ]}
});
assert.deepEqual(services.resourceLoader.getExtensions().errors,[]);
const created=await createAgentSession({cwd:services.cwd,agentDir:services.agentDir,modelRuntime:services.modelRuntime,settingsManager:services.settingsManager,resourceLoader:services.resourceLoader});
await created.session.bindExtensions({mode:'rpc'});
assert.equal(created.session.messages.length,0);
const runtime=new AgentSessionRuntime(created.session,services,async()=>{throw new Error('observer never replaces sessions');});
await runtime.dispose();
`);
  const profile = parseModelProviderProfile({
    adapter: 'openai_compatible', auth_mode: 'none', base_url: `http://127.0.0.1:${server.address().port}/v1`,
    capabilities: [], created_at: '2026-09-10T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z',
    display_name: 'Packed explicit model', enabled: true, kind: 'model', model: 'glm-5.3-flash',
    profile_ref: 'packed-zai', provider_kind: 'custom', pi_model: modelConfig,
  });
  const store = new SqliteProviderProfileStore({ path: profileDbPath });
  await store.save(profile);
  const { pi_model: _, ...withoutPi } = profile;
  const missingPi = parseModelProviderProfile({ ...withoutPi, profile_ref: 'missing-pi', auth_mode: 'bearer', enabled: false });
  await store.save(missingPi);
  const stale = parseModelProviderProfile({ ...profile, profile_ref: 'stale-pi', enabled: false });
  const staleBinding = exactProviderProfileBinding(stale);
  await store.save(parseModelProviderProfile({ ...stale, pi_model: { ...modelConfig, maxTokens: 16_384 } }));
  await store.close();
  const binding = exactProviderProfileBinding(profile);
  const isolatedHome = path.join(dir, 'home');
  await mkdir(isolatedHome);
  const env = {
    PATH: process.env.PATH, HOME: isolatedHome, USERPROFILE: isolatedHome,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC } : {}),
    BYOK_PI_MCP_CONFIG_PATH: mcpConfigPath, BYOK_PI_PERMISSION_MODE: 'readonly',
    ZAI_API_KEY: 'synthetic-must-not-forward', UNRELATED_CANARY: 'synthetic-must-not-forward',
  };
  // A missing launch-owned digest refusal proves Node loaded the installed SDK entry graph
  // before any native session, provider request or credential lookup can begin.
  const startupEnv = { ...env };
  delete startupEnv.BYOK_PI_MCP_CONFIG_PATH;
  delete startupEnv.BYOK_PI_PERMISSION_MODE;
  const startup = spawnSync(process.execPath, [sdkPiEntry], {cwd:dir,env:startupEnv,encoding:'utf8',timeout:15_000});
  assert.equal(startup.status, 78, startup.stderr || String(startup.error));
  assert.match(startup.stderr, /^byok-pi-rpc: exactly one --config-digest=<sha256> is required\n$/);
  assert.doesNotMatch(startup.stderr, /ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find (?:module|package)|Unknown file extension/);
  console.log('[release-pack] installed Node byok-pi-rpc imports reached the exact missing-config-digest refusal; sessions=0');

  // Capture the actual installed adapter after the explicit resource phase.
  let directInvocation;
  let directConfig;
  let directConfigBytes;
  const adapter = new PiAdapter({
    spawnFn: (command,args,options) => {
      directInvocation={command,args,options};
      directConfigBytes=readFileSync(args[args.indexOf('--config')+1],'utf8');
      directConfig=JSON.parse(directConfigBytes);
      throw new Error('capture before prompt');
    },
  });
  const detected = await adapter.detect();
  assert.equal(detected.kind,'available');
  assert.equal(detected.version,piManifest.version);
  const policy = {mode:'readonly'};
  const directEnv = {...startupEnv,PI_CODING_AGENT_DIR:path.join(dir,'direct-agent')};
  delete directEnv.ZAI_API_KEY; delete directEnv.UNRELATED_CANARY;
  await mkdir(directEnv.PI_CODING_AGENT_DIR,{recursive:true});
  await writeFile(path.join(directEnv.PI_CODING_AGENT_DIR,'models.json'),JSON.stringify(buildPiProviderProjection(profile)));
  await writeFile(path.join(directEnv.PI_CODING_AGENT_DIR,'settings.json'),JSON.stringify({defaultProvider:'byok-sdk-packed-zai',defaultModel:profile.model}));
  const prepared = await adapter.prepare({offer:{instruction:'Never sent',policy},policy,descriptor:adapter.descriptor,requiredToolsetIds:[],
    mcpServers:mcpTaskConfig.mcpServers,mcpToolsetTools:mcpTaskConfig.observation});
  assert.equal(prepared.kind,'prepared');
  assert.equal(typeof prepared.operation.resolveRuntimeLaunch,'function');
  let directRuntime;
  const captureDirect = async () => {
    directRuntime=await prepared.operation.resolveRuntimeLaunch({kind:'instruction',cwd:dir,env:directEnv,projectionRoot:path.join(dir,'direct-projections')});
    const manifest=sealRuntimeOperationManifest({taskId:'packed-direct-capture',runtimeId:'pi',descriptor:adapter.descriptor,
      policy,requiredToolsetIds:[],workspace:{workspaceDir:dir},forwardedEnvironmentNames:Object.keys(directRuntime.env).sort()});
    await prepared.operation.start({kind:'instruction',mcpEnv:mcpTaskConfig.mcpEnv,manifest,instruction:'Never sent',env:directRuntime.env,runtimeLaunch:directRuntime,
      mcpServers:mcpTaskConfig.mcpServers,mcpToolsetTools:mcpTaskConfig.observation,
      ...(launchUnprovable?{}:{mcpLaunch:{cwd:trustedLaunch.dir}})});
  };
  try {
    if (launchUnprovable) {
      await assert.rejects(captureDirect,/MCP servers without a trusted launch directory|Pi process cwd unavailable/);
      assert.equal(directInvocation,undefined,'unprovable launch reached spawn');
      assert.equal(requests,0);
      console.log(`[release-pack] installed Pi${piManifest.version} detect passed; explicit admission refused unprovable launch (${trustedLaunch.reason}); spawns=0 prompts=0`);
    } else {
      await assert.rejects(captureDirect,/pi runtime process could not be spawned/);
      assert.equal(directInvocation.command,directRuntime.binding.command);
      assert.deepEqual(directInvocation.args.slice(0,1),[sdkPiEntry]);
      assert.equal(directInvocation.options.cwd,trustedLaunch.dir);
      assert.equal(directInvocation.options.shell,undefined);
      assert.ok(!directInvocation.args.includes('--extension'),'ordinary entry must own its factories');
      assert.ok(directInvocation.args.includes('--no-skills'));
      assert.equal(directConfig.format,'byok.pi.rpc-launch');
      assert.equal(directConfig.cwd,dir);
      assert.deepEqual(directConfig.mcp.observation,mcpTaskConfig.observation);
      assert.equal(directConfig.mcp.launchCwd,trustedLaunch.dir);
      const configPath=directInvocation.args[directInvocation.args.indexOf('--config')+1];
      await mkdir(path.dirname(configPath),{recursive:true});
      await writeFile(configPath,directConfigBytes);
      try {
        // Direct defaults require configured auth; keys below selects its auth-free
        // model explicitly. Keep the earlier model-less refusal observable.
        await assert.rejects(
          rpcState(directInvocation.command,directInvocation.args,directInvocation.options),
          /No models available/,
        );
        assert.equal(requests,0,'credential-free direct startup must not call the provider');
        console.log('[release-pack] direct no-credential modelFallbackMessage refusal passed; requests=0');
        await writeFile(path.join(directEnv.PI_CODING_AGENT_DIR,'auth.json'),JSON.stringify({
          'byok-sdk-packed-zai': {type:'api_key',key:'synthetic-local-smoke-not-a-credential'},
        }),{mode:0o600});
        const state=await rpcState(directInvocation.command,directInvocation.args,directInvocation.options);
        assert.equal(state.messageCount,0);
        assert.equal(await realpath((await readFile(reservedServerCwdMarker,'utf8')).trim()),await realpath(trustedLaunch.dir));
      } finally {await rm(path.dirname(configPath),{recursive:true,force:true});}
      console.log(`[release-pack] installed Pi${piManifest.version} explicit resolve/start capture and SDK host RPC passed; session/process cwd split and real reserved MCP handshake observed; prompts=0`);
    }
  } finally {await directRuntime?.release();}

  for (const [rejectedBinding, expected] of [
    [exactProviderProfileBinding(missingPi), /requires explicit pi_model/],
    [staleBinding, /hash mismatch/],
  ]) {
    const check = spawnSync(process.execPath, [path.join(keysRoot, 'dist/bin/pi-provider-launcher.js'),
      '--pi-bin', process.execPath, '--pi-entry', sdkPiEntry, '--profile-db', profileDbPath, '--session-dir', sessionDir,
      '--provider', rejectedBinding.profileRef, '--model', rejectedBinding.modelId,
      '--profile-revision', rejectedBinding.profileRevision, '--profile-hash', rejectedBinding.profileHash,
      '--required-capabilities', '[]', '--validate-only', 'true',
    ], { cwd: dir, env, encoding: 'utf8', timeout: 5000 });
    assert.equal(check.status, 1);
    assert.match(check.stderr, expected);
  }
  // The full launch smoke: only reachable with a proven launch directory,
  // because everything it asserts is about WHERE the servers started.
  if (launchUnprovable) {
    // The one fact in that block that is about the TARBALL rather than about
    // this host, so it is asserted on both branches.
    await access(path.join(clientRoot, 'bin', 'byok-launch-cwd.mjs'));
    console.log(`[release-pack] launch boundary unprovable on this host (${trustedLaunch.reason}); the packed tarball's fail-closed refusal was asserted instead of the launch smoke`);
  } else {
    // Obtain keys projection directory and commitments through the installed
    // adapter's resource phase, exactly as a real operation does. No credential
    // is read: this profile declares auth_mode:none and start is intercepted.
    let keysInvocation;
    let keysConfig;
    let keysConfigBytes;
    const keysAdapter=new PiAdapter({
      byokLauncher:{command:process.execPath,args:[path.join(keysRoot,'dist/bin/pi-provider-launcher.js')],profileDbPath,sessionDir},
      spawnFn:(command,args,options)=>{
        keysInvocation={command,args,options};
        keysConfigBytes=readFileSync(args[args.indexOf('--config')+1],'utf8');
        keysConfig=JSON.parse(keysConfigBytes);
        throw new Error('capture before prompt');
      },
    });
    const keysPolicy={mode:'auto'}; // RPC custody probe is outside readonly-policy evidence.
    const selection={lane:'byok-profile',runtimeId:'pi',providerProfile:binding};
    const keysPrepared=await keysAdapter.prepare({offer:{instruction:'Never sent',policy:keysPolicy,dispatchSelection:selection},policy:keysPolicy,
      descriptor:keysAdapter.descriptor,requiredToolsetIds:[],mcpServers:mcpTaskConfig.mcpServers,mcpToolsetTools:mcpTaskConfig.observation});
    assert.equal(keysPrepared.kind,'prepared');
    const keysRuntime=await keysPrepared.operation.resolveRuntimeLaunch({kind:'instruction',cwd:dir,env,projectionRoot});
    try {
      const manifest=sealRuntimeOperationManifest({taskId:'packed-keys-capture',runtimeId:'pi',descriptor:keysAdapter.descriptor,
        policy:keysPolicy,dispatchSelection:selection,requiredToolsetIds:[],workspace:{workspaceDir:dir},forwardedEnvironmentNames:Object.keys(keysRuntime.env).sort()});
      await assert.rejects(keysPrepared.operation.start({kind:'instruction',mcpEnv:mcpTaskConfig.mcpEnv,manifest,instruction:'Never sent',env:keysRuntime.env,runtimeLaunch:keysRuntime,
        mcpServers:mcpTaskConfig.mcpServers,mcpToolsetTools:mcpTaskConfig.observation,mcpLaunch:{cwd:trustedLaunch.dir}}),/pi runtime process could not be spawned/);
      const option=(name)=>keysInvocation.args[keysInvocation.args.indexOf(name)+1];
      assert.deepEqual(JSON.parse(option('--launch-binding')),keysRuntime.binding);
      assert.equal(option('--pi-cwd'),trustedLaunch.dir);
      assert.deepEqual(JSON.parse(option('--pi-fixed-args')),keysRuntime.binding.fixedArgv);
      assert.equal(option('--pi-entry'),sdkPiEntry);
      assert.equal(keysInvocation.options.cwd,trustedLaunch.dir);
      assert.equal(keysInvocation.options.env.ZAI_API_KEY,undefined);
      assert.equal(keysInvocation.options.env.UNRELATED_CANARY,undefined);
      assert.equal(keysInvocation.options.env.BYOK_PI_MCP_CONFIG_PATH,undefined);
      const configPath=option('--config');
      await mkdir(path.dirname(configPath),{recursive:true}); await writeFile(configPath,keysConfigBytes);
      await rm(reservedServerCwdMarker,{force:true});
      try {
        const state=await rpcState(keysInvocation.command,keysInvocation.args,{...keysInvocation.options,env:{
          ...keysInvocation.options.env,
          // Deliberately challenge the real keys projection with extra ambient
          // names after the captured client boundary, without changing argv.
          ZAI_API_KEY:env.ZAI_API_KEY,UNRELATED_CANARY:env.UNRELATED_CANARY,
          BYOK_PI_MCP_CONFIG_PATH:env.BYOK_PI_MCP_CONFIG_PATH,BYOK_PI_PERMISSION_MODE:env.BYOK_PI_PERMISSION_MODE,
        }},custodyProbe);
        assert.equal(state.model.provider,'byok-sdk-packed-zai');
        assert.equal(state.model.id,profile.model);
        assert.equal(state.model.contextWindow,modelConfig.contextWindow);
        assert.equal(state.model.maxTokens,modelConfig.maxTokens);
        assert.equal(state.model.reasoning,true);
        assert.deepEqual(state.model.thinkingLevelMap,modelConfig.thinkingLevelMap);
        for (const [key,value] of Object.entries(modelConfig.compat)) assert.equal(state.model.compat[key],value);
        assert.equal(state.thinkingLevel,modelConfig.thinkingLevel);
        assert.equal(state.messageCount,0);
        const reservedCwd=(await readFile(reservedServerCwdMarker,'utf8')).trim();
        assert.equal(await realpath(reservedCwd),await realpath(trustedLaunch.dir));
        assert.notEqual(reservedCwd,dir);
      } finally {await rm(path.dirname(configPath),{recursive:true,force:true});}
    } finally {await keysRuntime.release();}

    // Preserve the original active MCP registry checks as explicitly separate
    // native-session evidence; no custom extension is injected into the SDK host.
    const observed=spawnSync(process.execPath,[toolsObserver],{cwd:trustedLaunch.dir,env:startupEnv,encoding:'utf8',timeout:30_000});
    assert.equal(observed.status,0,observed.stderr||String(observed.error));
    const activeTools=JSON.parse(await readFile(toolsMarker,'utf8'));
    assert.ok(activeTools.includes('mcp__fixture__echo'),`registered tools: ${activeTools.join(', ')}`);
    assert.ok(activeTools.includes('relay_probe'),`reserved helper tool missing: ${activeTools.join(', ')}`);
    assert.ok(!activeTools.includes('mcp'),'the retired MCP proxy tool must not be registered');
    assert.ok(!activeTools.includes('mcpScript'),'the retired mcpScript tool must not be registered');
    await access(path.join(clientRoot,'bin','byok-launch-cwd.mjs'));
    assert.equal(requests,0);
    console.log(`[release-pack] keys -> installed SDK Pi${piManifest.version} host model/start, actual inherited-subprocess custody/session-cwd probe (auto policy), and real MCP handshake/cwd passed; sealed process cwd is the captured spawn input; LLM requests=0`);
    console.log('[release-pack] separate installed native MCP session active-tool assertions passed; active registry inside the keys-launched child is NOT observed');
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
  await rm(projectionRoot, { recursive: true, force: true });
}
