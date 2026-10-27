#!/usr/bin/env bun
// Opt-in, zero-cost Codex qualification. No user home, login, config or provider is read.
if (process.env.BYOK_CODEX_LOOPBACK !== '1') {
  console.log(JSON.stringify({ status: 'skipped', reason: 'BYOK_CODEX_LOOPBACK=1 required', paidCalls: 0 }));
  process.exit(0);
}

const { createServer } = await import('node:http');
const { mkdtemp, mkdir, readFile, writeFile, rm, realpath } = await import('node:fs/promises');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const { execFile } = await import('node:child_process');
const { promisify } = await import('node:util');
const command = process.env.BYOK_CODEX_BIN ?? 'codex';
const inheritedPath = process.env.PATH;
const systemRoot = process.env.SystemRoot;
const root = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'cm-')));
const blockedConnections = [];
const report = { status: 'not-verified', paidCalls: 0, runtimeVersion: null, cases: [], blockedConnections };
const proxy = createServer((req, res) => {
  blockedConnections.push({ method: req.method, target: req.url });
  res.writeHead(403); res.end('External requests are forbidden by the loopback probe');
});
proxy.on('connect', (req, socket) => {
  blockedConnections.push({ method: 'CONNECT', target: req.url });
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
});
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const closeServer = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

function respond(res, item, index) {
  const id = `resp_loopback_${index}`;
  const events = [
    ['response.created', { type: 'response.created', response: { id, status: 'in_progress', output: [] } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } }],
    ...(item.type === 'function_call' ? [
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments }],
      ['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments }],
    ] : [
      ['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'loopback complete' }],
    ]),
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
    ['response.completed', { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }],
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
  res.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
}

try {
  const proxyPort = await listen(proxy);
  // detect() reads this process's environment; scrub it before importing or preparing the adapter.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    PATH: inheritedPath ?? '', ...(systemRoot === undefined ? {} : { SystemRoot: systemRoot }),
    HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'),
    OPENAI_API_KEY: 'sk-loopback-placeholder-not-a-real-key',
    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    ALL_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '127.0.0.1,localhost',
    http_proxy: `http://127.0.0.1:${proxyPort}`, https_proxy: `http://127.0.0.1:${proxyPort}`,
    all_proxy: `http://127.0.0.1:${proxyPort}`, no_proxy: '127.0.0.1,localhost',
  });
  await mkdir(process.env.HOME, { recursive: true, mode: 0o700 });
  await mkdir(process.env.CODEX_HOME, { recursive: true, mode: 0o700 });
  const version = await promisify(execFile)(command, ['--version'], { env: process.env, timeout: 5_000 });
  report.runtimeVersion = (version.stdout + version.stderr).trim();
  const { CodexAdapter } = await import('../src/adapters/codex/codex-adapter.ts');
  const { sealRuntimeOperationManifest } = await import('../src/types.ts');
  const { createExecutionScratch } = await import('../src/daemon/retention/scratch.ts');

  for (const name of ['byokagentresult', 'host']) {
    const caseRoot = join(root, name);
    const workspace = join(caseRoot, 'workspace');
    const codexHome = join(caseRoot, 'codex');
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const receipt = join(caseRoot, 'calls.jsonl');
    const helper = join(caseRoot, 'helper.mjs');
    await writeFile(helper, `import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const send = frame => console.log(JSON.stringify(frame));
readline.createInterface({input: process.stdin}).on('line', line => {
 const frame = JSON.parse(line); if (frame.id === undefined) return;
 let result;
 if (frame.method === 'initialize') result = {protocolVersion: frame.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'loopback-result',version:'1'}};
 else if (frame.method === 'tools/list') result = {tools:[{name:'submit_result',description:'Record the loopback document',inputSchema:{type:'object',properties:{summary:{type:'string'}},required:['summary'],additionalProperties:false}}]};
 else if (frame.method === 'tools/call') { appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(frame.params)+'\\n'); result={content:[{type:'text',text:'loopback result accepted'}]}; }
 else result = {};
 send({jsonrpc:'2.0',id:frame.id,result});
});\n`);
    const requests = [];
    const providerErrors = [];
    const provider = createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        try {
          if (req.method !== 'POST' || req.url !== '/v1/responses') throw new Error(`unexpected loopback request: ${req.method} ${req.url}`);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          requests.push(body);
          if (requests.length > 3) throw new Error('Codex exceeded the bounded loopback request count');
          if (requests.length === 1) {
            // Read the advertised structured tool identity; never invent an absent tool.
            const namespace = body.tools?.find(tool => tool.type === 'namespace' && tool.name === `mcp__${name}`);
            const nested = namespace?.tools?.find(tool => tool.type === 'function' && tool.name === 'submit_result');
            const flat = body.tools?.find(tool => tool.type === 'function' && tool.name === `mcp__${name}__submit_result`);
            if (nested === undefined && flat === undefined) throw new Error('Codex did not advertise the configured submit_result tool');
            respond(res, { type: 'function_call', id: 'fc_loopback', call_id: 'call_loopback', name: nested?.name ?? flat.name, ...(nested === undefined ? {} : { namespace: namespace.name }), arguments: JSON.stringify({ summary: 'loopback document' }), status: 'completed' }, requests.length);
          } else {
            respond(res, { type: 'message', id: 'msg_loopback', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'loopback complete', annotations: [] }] }, requests.length);
          }
        } catch (error) {
          providerErrors.push(error.message);
          res.writeHead(500, { connection: 'close' }); res.end(error.message);
        }
      });
    });
    let session;
    let scratch;
    let timer;
    try {
      const providerPort = await listen(provider);
      process.env.CODEX_HOME = codexHome;
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: process.env.OPENAI_API_KEY, tokens: null, last_refresh: null }), { mode: 0o600 });
      await writeFile(join(codexHome, 'config.toml'), `model = "loopback-model"\nmodel_provider = "loopback"\n[model_providers.loopback]\nname = "loopback"\nbase_url = "http://127.0.0.1:${providerPort}/v1"\nwire_api = "responses"\nenv_key = "OPENAI_API_KEY"\nsupports_websockets = false\n`, { mode: 0o600 });
      const env = { ...process.env };
      const adapter = new CodexAdapter({ resolveBin: () => ({ command, source: 'path' }), sandbox: 'inherit', agentUserMcpServers: 'excluded', operationTimeoutMs: 20_000 });
      const mcpServers = { [name]: { command: process.execPath, args: [helper] } };
      const offer = { instruction: 'Run the provided submit_result tool, then finish.' };
      const prepared = await adapter.prepare({ offer, descriptor: adapter.descriptor, requiredToolsetIds: [], mcpServers });
      if (prepared.kind !== 'prepared') throw new Error(`Codex refused preparation: ${prepared.reason}`);
      scratch = await createExecutionScratch({ root: join(caseRoot, 's') });
      const manifest = sealRuntimeOperationManifest({ taskId: `loopback-${name}`, runtimeId: adapter.descriptor.id, descriptor: adapter.descriptor, requiredToolsetIds: [], agentRef: { agentId: 'loopback-agent', profileRevision: 'r1' }, cwd: workspace, lease: { leaseId: `loopback-${name}`, canonicalHome: workspace }, workspace: { workspaceDir: workspace }, forwardedEnvironmentNames: Object.keys(env).sort() });
      session = await prepared.operation.start({ scratch, kind: 'instruction', instruction: offer.instruction, env, manifest, mcpServers });
      const events = [];
      await Promise.race([
        (async () => { for await (const event of session.events) { events.push(event); if (event.type === 'turn_end') return; } throw new Error('Codex ended without turn_end'); })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('loopback turn exceeded 60 seconds')), 60_000); }),
      ]);
      const calls = await readFile(receipt, 'utf8').then(text => text.trim().split('\n').map(line => JSON.parse(line)), error => { if (error.code === 'ENOENT') return []; throw error; });
      const outputs = requests.flatMap(request => (request.input ?? []).filter(item => item.type === 'function_call_output'));
      const approvalDenied = JSON.stringify(outputs).includes('MCP tool call requires approval, but approval policy is never');
      const passed = providerErrors.length === 0 && requests.length === 2 && (name === 'byokagentresult'
        ? calls.length === 1 && calls[0].name === 'submit_result' && calls[0].arguments?.summary === 'loopback document' && !approvalDenied
        : calls.length === 0 && approvalDenied);
      report.cases.push({ server: name, status: passed ? 'passed' : 'failed', providerRequests: requests.length, toolCalls: calls, approvalDenied, providerErrors, terminalTypes: events.map(event => event.type).filter(type => type === 'error' || type === 'turn_end') });
      if (!passed) throw new Error(`${name}: real Codex loopback did not satisfy the tool invocation boundary`);
    } finally {
      clearTimeout(timer);
      await session?.close();
      await scratch?.release();
      await closeServer(provider);
    }
  }
  report.status = 'passed';
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await closeServer(proxy);
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
