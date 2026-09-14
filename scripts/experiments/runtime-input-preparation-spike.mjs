/**
 * Provider-free feasibility probe, not a public SDK implementation.
 * Two native Pi processes share an immutable input artifact; the consume
 * process reaches an Undici mock transport. A socket guard independently
 * denies any external connection if the mock is bypassed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const piRoot = '/opt/homebrew/Cellar/node@24/24.18.0/lib/node_modules/@earendil-works/pi-coding-agent';
const node = '/opt/homebrew/Cellar/node@24/24.18.0/bin/node';
const entry = join(piRoot, 'dist/bundle/cli.js');
assert.equal(JSON.parse(readFileSync(join(piRoot, 'package.json'))).version, '0.85.1');
const out = resolve('_ops/c07-runtime-input');
mkdirSync(out, { recursive: true });
const fixture = mkdtempSync(join(tmpdir(), 'byok-runtime-input-'));
const cwd = join(fixture, 'cwd');
mkdirSync(cwd);
const contextPath = join(cwd, 'AGENTS.md');
writeFileSync(contextPath, 'C07_AUTHORIZED_SYNTHETIC_CONTEXT\n');
const digest = value => createHash('sha256').update(value).digest('hex');
const bundleRoot = join(piRoot, 'dist/bundle');
const bundleDigest = () => digest(JSON.stringify(readdirSync(bundleRoot, { recursive: true }).filter(p => p.endsWith('.js')).sort().map(p => [p, digest(readFileSync(join(bundleRoot, p)))])));
const binding = {
  tenant: 'synthetic-tenant', device: 'synthetic-device', agent: 'synthetic-agent',
  profileRevision: 1, runtime: 'pi', provider: 'zai', model: 'glm-5.3-flash',
  endpoint: 'https://api.z.ai/api/coding/paas/v4',
  sourceRevision: 1, hostInputHash: digest('C07_SYNTHETIC_INPUT'),
  contextHash: digest(readFileSync(contextPath)), runtimeBundleHash: bundleDigest(),
};
const bindingPath = join(fixture, 'binding.json');
writeFileSync(bindingPath, JSON.stringify(binding));
const artifactPath = join(fixture, 'prepared.json');
const acceptedPath = join(fixture, 'accepted-digest.txt');
const extension = join(fixture, 'artifact-extension.ts');
writeFileSync(extension, `
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const hash = (x:any) => createHash('sha256').update(x).digest('hex');
const fail = (reason:string) => {
 writeFileSync(process.env.C07_CASE_RESULT!, JSON.stringify({status:'rejected',reason}));
 process.exit(42);
};
export default function(pi:any) {
 pi.on('before_provider_request', (event:any) => {
  (globalThis as any).__c07InstallMock();
  const current = JSON.parse(readFileSync(process.env.C07_BINDING!, 'utf8'));
  if (hash(readFileSync(process.env.C07_CONTEXT!)) !== current.contextHash) fail('context_drift');
  const root = process.env.C07_PI_BUNDLE!;
  const bundleHash = hash(JSON.stringify(readdirSync(root, { recursive: true }).filter((p:any) => p.endsWith('.js')).sort().map((p:any) => [p, hash(readFileSync(join(root, p)))])));
  if (bundleHash !== current.runtimeBundleHash) fail('runtime_drift');
  if (event.payload.model !== current.model) fail('runtime_model_drift');
  if (process.env.C07_PHASE === 'prepare') {
   const body = JSON.stringify(event.payload);
   const artifact = {schemaVersion:'byok.runtime-input.spike.v1',binding:current,payload:body};
   const bytes = JSON.stringify(artifact);
   writeFileSync(process.env.C07_ARTIFACT!, bytes);
   writeFileSync(process.env.C07_ACCEPTED!, hash(bytes));
   writeFileSync(process.env.C07_CASE_RESULT!, JSON.stringify({status:'prepared',payloadSha256:hash(body)}));
   process.exit(0);
  }
  let bytes:string;
  try { bytes = readFileSync(process.env.C07_ARTIFACT!, 'utf8'); }
  catch { fail('artifact_missing'); return; }
  if (hash(bytes!) !== readFileSync(process.env.C07_ACCEPTED!, 'utf8')) fail('artifact_integrity');
  const artifact = JSON.parse(bytes!);
  if (JSON.stringify(artifact.binding) !== JSON.stringify(current)) fail('binding_drift');
  // Only this explicit extension is loaded. It is the last payload author.
  // Production needs an SDK-owned authenticated handle; this local digest is
  // an experiment oracle, not a credential or authorization mechanism.
  writeFileSync(process.env.C07_CASE_RESULT!, JSON.stringify({status:'consuming',payloadSha256:hash(artifact.payload)}));
  return JSON.parse(artifact.payload);
 });
}
`);
const preload = join(fixture, 'transport.mjs');
writeFileSync(preload, `
import net from 'node:net';
import { writeFileSync, appendFileSync } from 'node:fs';
import { MockAgent, setGlobalDispatcher } from '${piRoot}/node_modules/undici/index.js';
net.Socket.prototype.connect = function() {
 appendFileSync(process.env.C07_SOCKET_LOG, 'DENIED\\n');
 throw new Error('C07_EXTERNAL_NETWORK_FORBIDDEN');
};
const mock = new MockAgent();
mock.disableNetConnect();
globalThis.__c07InstallMock = () => setGlobalDispatcher(mock);
mock.get('https://api.z.ai').intercept({
 path:'/api/coding/paas/v4/chat/completions',method:'POST'
}).reply(options => {
 if (process.env.C07_PHASE !== 'consume') throw new Error('PREPARE_REACHED_TRANSPORT');
 const body=String(options.body);
 writeFileSync(process.env.C07_WIRE, body);
 const frames=[
 {id:'offline',object:'chat.completion.chunk',model:'glm-5.3-flash',choices:[{index:0,delta:{role:'assistant',content:'OFFLINE_FIXTURE'},finish_reason:null}]},
 {id:'offline',object:'chat.completion.chunk',model:'glm-5.3-flash',choices:[{index:0,delta:{},finish_reason:'stop'}]}
 ];
 return {statusCode:200,data:frames.map(x=>'data: '+JSON.stringify(x)+'\\n\\n').join('')+'data: [DONE]\\n\\n',responseOptions:{headers:{'content-type':'text/event-stream'}}};
});
`);

function run(name, phase, expectedExit) {
  const agent = join(fixture, name + '-agent');
  mkdirSync(agent);
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  const resultPath = join(fixture, name + '-result.json');
  const wirePath = join(fixture, name + '-wire.json');
  const socketPath = join(fixture, name + '-sockets.log');
  const result = spawnSync(node, [
    '--import', preload, entry,
    '--provider', 'zai', '--model', 'glm-5.3-flash', '--thinking', 'high',
    '--api-key', 'synthetic-not-a-credential',
    '--no-session', '--no-extensions', '-e', extension,
    '--no-skills', '--no-prompt-templates', '--no-themes',
    '-p', 'C07_SYNTHETIC_INPUT',
  ], {
    cwd, encoding: 'utf8', timeout: 30000,
    env: {
      PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent, NO_COLOR: '1',
      C07_PHASE: phase, C07_ARTIFACT: artifactPath, C07_ACCEPTED: acceptedPath,
      C07_BINDING: bindingPath, C07_CONTEXT: contextPath, C07_PI_BUNDLE: bundleRoot,
      C07_CASE_RESULT: resultPath, C07_WIRE: wirePath, C07_SOCKET_LOG: socketPath,
    },
  });
  writeFileSync(join(out, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  assert(!existsSync(socketPath), name + ': socket guard fired');
  assert.equal(result.status, expectedExit, name + ': see ' + name + '.log');
  const observed = JSON.parse(readFileSync(resultPath));
  if (expectedExit !== 0 || phase === 'prepare') assert(!existsSync(wirePath), name + ': unexpected provider boundary');
  return { name, ...observed, wire: existsSync(wirePath) ? readFileSync(wirePath, 'utf8') : null };
}
const cases = [];
cases.push(run('prepare', 'prepare', 0));
const original = readFileSync(artifactPath, 'utf8');
const prepared = JSON.parse(original);
assert(prepared.payload.includes('C07_AUTHORIZED_SYNTHETIC_CONTEXT'));
assert.equal(JSON.parse(prepared.payload).tools.length, 4);
const consumed = run('consume', 'consume', 0);
assert.equal(consumed.wire, prepared.payload, 'actual transport bytes differ');
cases.push(consumed);
const corrupt = JSON.parse(original);
corrupt.payload += ' ';
writeFileSync(artifactPath, JSON.stringify(corrupt));
const tampered = run('tampered-artifact', 'consume', 42);
assert.equal(tampered.reason, 'artifact_integrity');
cases.push(tampered);
writeFileSync(artifactPath, original);
writeFileSync(bindingPath, JSON.stringify({ ...binding, profileRevision: 2 }));
const drift = run('binding-drift', 'consume', 42);
assert.equal(drift.reason, 'binding_drift');
cases.push(drift);
writeFileSync(bindingPath, JSON.stringify(binding));
writeFileSync(contextPath, 'CHANGED_AUTHORIZED_CONTEXT\n');
const contextDrift = run('context-drift', 'consume', 42);
assert.equal(contextDrift.reason, 'context_drift');
cases.push(contextDrift);

const sources = [entry, join(piRoot, 'dist/bundle/chunks/chunk-JVUZSMYM.js'), extension, preload];
const evidence = {
  schemaVersion: 'byok.runtime-input.preparation-consume-spike.v1',
  status: 'PASS', probeSha256: digest(readFileSync(new URL(import.meta.url))), runtimeBundleHash: bundleDigest(), artifactBytes: Buffer.byteLength(original),
  payloadBytes: Buffer.byteLength(prepared.payload), payloadSha256: digest(prepared.payload),
  cases: cases.map(({ wire, ...row }) => ({ ...row, reachedMockTransport: wire !== null })),
  sourceHashes: sources.map(path => ({ path, sha256: digest(readFileSync(path)) })),
  externalNetworkConnections: 0, credentialReads: 0, sdkTaskSubmissions: 0,
  modelGenerations: 0, mockTransportRequests: 1, fixture,
  limitations: [
    'Native CLI controlled final hook feasibility only; SDK public primitive absent.',
    'Prepare starts an isolated CLI and writes only disposable fixture files; production pure compiler is not proven.',
    'Synthetic binding/digest is an oracle, not transport authentication or SDK artifact lifecycle.',
    'No tokenizer/inference accounting, Host CAS, real home/MCP or multimodal acceptance.',
  ],
};
writeFileSync(join(out, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ status: evidence.status, cases: evidence.cases, payloadBytes: evidence.payloadBytes,
  externalNetworkConnections: 0, sdkTaskSubmissions: 0, mockTransportRequests: 1 }));
