if (process.env.BYOK_REAL_CODEX !== '1') { console.log(JSON.stringify({ status: 'skipped', turns: 0, reason: 'BYOK_REAL_CODEX=1 required' })); process.exit(0); }
const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { execFile, spawn } = await import('node:child_process');
const { promisify } = await import('node:util');
const { codexSession } = await import('../vendor/oar/ef893ac/runtimes/codex/session.ts');
const { spawnOwnedLineProcess } = await import('../src/runtime/owned-line-process.ts');
const { CodexProjection } = await import('../src/adapters/codex/projection.ts');
const { CodexAdapter } = await import('../src/adapters/codex/codex-adapter.ts');
const { buildRuntimeEnv } = await import('../src/daemon/environment.ts');
const { logger, deferred, bounded, startAdapter, collect, tapChild } = await import('./real-s8-utils.mjs');
const emit = logger(process.env.BYOK_REAL_LOG ?? '/tmp/byok-s8-codex.jsonl');
const report = { turns: 0, cases: [], baseline: '4b9485e6' };
const env = buildRuntimeEnv({ ambient: process.env, requirements: { credentialNames: [] } });
const adapterProbe = new CodexAdapter(); report.detection = await adapterProbe.detect(); emit({ kind: 'detection', result: report.detection });
if (report.detection.kind !== 'available' || !report.detection.authPresent) { emit({ kind: 'summary', report }); process.exit(1); }
const workspace = await mkdtemp(join(tmpdir(), 'byok-s8-codex-'));
const receipt = join(workspace, 'calls.jsonl'), server = join(workspace, 'mcp.mjs');
await writeFile(server, `import {createInterface} from 'node:readline';import{appendFileSync}from'node:fs';const send=x=>console.log(JSON.stringify(x));createInterface({input:process.stdin}).on('line',line=>{const f=JSON.parse(line);if(f.id===undefined)return;let result;if(f.method==='initialize')result={protocolVersion:f.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'byoks8',version:'1'}};else if(f.method==='tools/list')result={tools:['allowed','excluded'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{},additionalProperties:false}}))};else if(f.method==='tools/call'){appendFileSync(${JSON.stringify(receipt)},JSON.stringify({name:f.params.name})+'\\n');result={content:[{type:'text',text:'S8_CALLED_'+f.params.name}]};}else result={};send({jsonrpc:'2.0',id:f.id,result});});`);
const overrides = { 'mcp_servers.byoks8.command': JSON.stringify(process.execPath), 'mcp_servers.byoks8.args': JSON.stringify([server]),
  'mcp_servers.byoks8.enabled_tools': '["allowed"]', 'mcp_servers.byoks8.tools.allowed.approval_mode': '"approve"' };
const listed = await promisify(execFile)('codex', ['mcp', 'list', '--json'], { timeout: 5000 });
for (const entry of JSON.parse(listed.stdout)) if (entry.name !== 'byoks8') {
  overrides[`mcp_servers.${entry.name}.${entry.transport.type === 'stdio' ? 'command' : 'url'}`] = JSON.stringify(entry.transport.type === 'stdio' ? '/bin/false' : 'http://127.0.0.1:9/mcp');
  overrides[`mcp_servers.${entry.name}.enabled`] = 'false';
}
const extra = Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${value}`]);
let raw, child, projection, finished, startedTool;
const stream = {}; let current = [];
try {
  raw = await codexSession((command, args, options) => (child = spawnOwnedLineProcess(command, [...args, ...extra], options)),
    { kind: 'available', via: 'executable', command: 'codex' }, { cwd: workspace, env }, 1000, {
      onReady: id => { projection = new CodexProjection(workspace, id); },
      onRecord: record => {
        if (record.kind === 'frame' && record.body.origin === 'byok-native') {
          const { type, native } = record.body;
          if (['item/started', 'item/completed', 'turn/started', 'turn/completed', 'thread/tokenUsage/updated'].includes(type)) emit({ kind: 'native', type, data: native });
          if (type === 'item/started' && native.item?.type === 'commandExecution') startedTool?.resolve(native.item);
          if (type === 'turn/completed') finished?.resolve(native.turn.status);
        }
        projection?.consume(stream, record, event => { current.push(event); emit({ kind: 'raw-projection.event', event }); });
      }, maxBytes: 16 * 1024 * 1024,
    });
  for (const [name, prompt] of [
    ['excluded-tool', 'Call byoks8 allowed once, then attempt byoks8 excluded once; if excluded is unavailable reply S8_EXCLUDED_UNAVAILABLE; do not use shell or other tools.'],
    ['steer', 'Run the shell command sleep 6, then reply exactly S8_ORIGINAL; do nothing else.'],
  ]) {
    if (report.turns >= 4) throw new Error('Codex turn budget exceeded');
    current = []; finished = deferred(); startedTool = deferred(); report.turns++; emit({ kind: 'turn.submit', ordinal: report.turns, name, prompt });
    const accepted = await raw.prompt(prompt); emit({ kind: 'prompt.response', name, response: accepted.response });
    if (accepted.response.body.kind !== 'accepted') throw new Error('prompt refused');
    let steer;
    if (name === 'steer') {
      const signal = await bounded(Promise.race([startedTool.promise.then(item => ({ item })), finished.promise.then(status => ({ status }))]), 'steer tool start');
      if (signal.item) { emit({ kind: 'steer.submit', input: 'Reply exactly S8_STEER_ACCEPTED instead of S8_ORIGINAL.' });
        const response = await raw.steer('Reply exactly S8_STEER_ACCEPTED instead of S8_ORIGINAL.');
        steer = response.response; emit({ kind: 'steer.response', response }); }
      else steer = { noRunningTool: true, status: signal.status };
    }
    const status = await bounded(finished.promise, name);
    const text = current.filter(e => e.type === 'progress').map(e => e.text).join('');
    let calls = []; try { calls = (await readFile(receipt, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
    report.cases.push({ name, status, text, steer, calls, steerConsumed: name === 'steer' && text.includes('S8_STEER_ACCEPTED') });
    emit({ kind: 'case', result: report.cases.at(-1) });
  }
  await raw.dispose(); await child.dispose(); raw = undefined; child = undefined;
  // Actual BYOK prepare/operation/session; only probe-local MCP overrides bound ambient servers.
  const adapter = new CodexAdapter({ spawnFn: (command, args, options) => {
    const processChild = spawn(command, [...args, ...extra], options);
    tapChild(processChild, frame => { if (frame.method === 'thread/tokenUsage/updated') emit({ kind: 'adapter.native.usage', frame }); });
    return processChild;
  } });
  if (report.turns >= 4) throw new Error('Codex turn budget exceeded');
  report.turns++; emit({ kind: 'turn.submit', ordinal: report.turns, name: 'adapter-context', prompt: 'Reply exactly S8_CODEX_OK without using tools.' });
  let session;
  try {
    session = await startAdapter(adapter, 'Reply exactly S8_CODEX_OK without using tools.', workspace, env, 'real-s8-codex');
    const result = await bounded(collect(session, emit), 'CodexAdapter turn');
    const usage = result.events.find(event => event.type === 'usage');
    report.cases.push({ name: 'adapter-context', ...result, verified: usage?.contextSource === 'provider' && Number.isSafeInteger(usage.contextTokens) && usage.contextWindow > 0 });
  } finally { await session?.close(); }
} catch (error) { report.error = String(error); }
finally {
  try { await raw?.dispose(); } finally { await child?.dispose(); await rm(workspace, { recursive: true, force: true }); }
}
emit({ kind: 'summary', report }); console.log(JSON.stringify(report, null, 2));
process.exitCode = report.cases.length === 3 ? 0 : 1;
