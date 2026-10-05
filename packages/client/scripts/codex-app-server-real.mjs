// Opt-in only. At most three small native turns; no login mutation or credential reads.
if (process.env.BYOK_REAL_CODEX !== '1') {
  console.log(
    JSON.stringify({
      status: 'skipped',
      reason: 'BYOK_REAL_CODEX=1 required',
      turns: 0,
    }),
  );
  process.exit(0);
}
const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { execFile } = await import('node:child_process');
const { promisify } = await import('node:util');
const { codexSession } = await import(
  '../vendor/oar/f385b91/runtimes/codex/session.ts'
);
const { spawnOwnedLineProcess } = await import(
  '../src/runtime/owned-line-process.ts'
);
const { CodexProjection } = await import('../src/adapters/codex/projection.ts');
const { CodexAdapter } = await import('../src/adapters/codex/codex-adapter.ts');
const { buildRuntimeEnv } = await import('../src/daemon/environment.ts');
const execute = promisify(execFile);
const report = {
  status: 'not-verified',
  turns: 0,
  serverRequests: [],
  cases: [],
  mcpCalls: [],
};
const detected = await new CodexAdapter().detect();
report.detection = detected;
if (detected.kind !== 'available' || !detected.authPresent) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}
const workspace = await mkdtemp(join(tmpdir(), 'byok-s2b-real-'));
const receipt = join(workspace, 'mcp-calls.jsonl');
const server = join(workspace, 'mcp.mjs');
await writeFile(
  server,
  `import readline from 'node:readline';import {appendFileSync} from 'node:fs';const send=x=>console.log(JSON.stringify(x));readline.createInterface({input:process.stdin}).on('line',line=>{const f=JSON.parse(line);if(f.id===undefined)return;let result;if(f.method==='initialize')result={protocolVersion:f.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'byoks2b',version:'1'}};else if(f.method==='tools/list')result={tools:['allowed','blocked'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{},additionalProperties:false}}))};else if(f.method==='tools/call'){appendFileSync(${JSON.stringify(receipt)},JSON.stringify({name:f.params.name})+'\\n');result={content:[{type:'text',text:'verified-'+f.params.name}]};}else result={};send({jsonrpc:'2.0',id:f.id,result});});`,
);
const overrides = {
  sandbox_mode: '"danger-full-access"',
  'mcp_servers.byoks2b.command': JSON.stringify(process.execPath),
  'mcp_servers.byoks2b.args': JSON.stringify([server]),
  'mcp_servers.byoks2b.enabled_tools': '["allowed","blocked"]',
  'mcp_servers.byoks2b.tools.allowed.approval_mode': '"approve"',
};
// Bound this research probe to its own MCP server. CLI name readback is not tool behavior evidence.
const listed = await execute('codex', ['mcp', 'list', '--json'], {
  timeout: 5000,
});
for (const entry of JSON.parse(listed.stdout))
  if (entry.name !== 'byoks2b') {
    if (entry.transport.type === 'stdio')
      overrides[`mcp_servers.${entry.name}.command`] = '"/bin/false"';
    else
      overrides[`mcp_servers.${entry.name}.url`] = '"http://127.0.0.1:9/mcp"';
    overrides[`mcp_servers.${entry.name}.enabled`] = 'false';
  }
const env = buildRuntimeEnv({
  ambient: process.env,
  requirements: { credentialNames: [] },
});
let raw;
let projection;
let complete;
let child;
const stream = {};
let current = [];
let native = [];
const records = [];
try {
  raw = await codexSession(
    (command, args, opts) => {
      const extra = Object.entries(overrides).flatMap(([key, value]) => [
        '-c',
        `${key}=${value}`,
      ]);
      child = spawnOwnedLineProcess(command, [...args, ...extra], opts);
      return child;
    },
    { kind: 'available', via: 'executable', command: 'codex' },
    { cwd: workspace, env },
    1000,
    {
      onReady: (id) => {
        projection = new CodexProjection(workspace, id);
      },
      onRecord: (record) => {
        records.push(record);
        if (record.kind === 'request' && record.direction === 'toApp')
          report.serverRequests.push(record.body.type);
        projection?.consume(stream, record, (event) => current.push(event));
        if (record.kind === 'frame' && record.body.origin === 'byok-native') {
          if (record.body.type === 'thread/tokenUsage/updated')
            report.tokenUsageNotification = true;
          if (
            record.body.type === 'item/completed' &&
            record.body.native.item?.type === 'mcpToolCall'
          )
            native.push(record.body.native.item);
          if (record.body.type === 'turn/completed')
            complete?.(record.body.native.turn.status);
        }
      },
      maxBytes: 16 * 1024 * 1024,
    },
  );
  for (const [name, prompt] of [
    ['basic', 'Reply exactly OK. Do not use tools.'],
    [
      'authorized',
      'Call byoks2b allowed exactly once. Do not use shell or other tools. Report its returned text.',
    ],
    [
      'enabled-without-preapproval',
      'Attempt byoks2b blocked exactly once. Do not use shell or other tools. Report if it is refused.',
    ],
  ]) {
    current = [];
    native = [];
    let timer;
    const finished = new Promise((resolve, reject) => {
      complete = resolve;
      timer = setTimeout(
        () => reject(new Error('real turn deadline exceeded')),
        60000,
      );
    });
    report.turns++;
    try {
      const accepted = await raw.prompt(prompt);
      if (accepted.response.body.kind !== 'accepted')
        throw new Error(accepted.response.body.reason ?? 'prompt refused');
      const status = await finished;
      let calls = [];
      try {
        calls = (await readFile(receipt, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {}
      const usage = current.findIndex((e) => e.type === 'usage');
      const end = current.findIndex((e) => e.type === 'turn_end');
      report.cases.push({
        name,
        status,
        usageBeforeTurnEnd: usage >= 0 && end > usage,
        events: current.map((e) => e.type),
        nativeMcp: native.map((item) => ({
          server: item.server,
          tool: item.tool,
          status: item.status,
          error: item.error ?? null,
        })),
        calls,
      });
      if (status !== 'completed') break;
    } finally {
      clearTimeout(timer);
      complete = undefined;
    }
  }
  try {
    report.mcpCalls = (await readFile(receipt, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {}
  report.basicVerified =
    report.cases[0]?.status === 'completed' &&
    report.cases[0]?.usageBeforeTurnEnd === true &&
    report.tokenUsageNotification === true;
  report.authorizedVerified =
    report.cases
      .find((c) => c.name === 'authorized')
      ?.nativeMcp.some(
        (item) => item.tool === 'allowed' && item.status === 'completed',
      ) === true && report.mcpCalls.some((c) => c.name === 'allowed');
  report.unauthorizedAttemptObserved =
    report.cases
      .find((c) => c.name === 'enabled-without-preapproval')
      ?.nativeMcp.some((item) => item.tool === 'blocked') === true;
  report.unauthorizedExecuted = report.mcpCalls.some(
    (c) => c.name === 'blocked',
  );
  report.status =
    report.basicVerified &&
    report.authorizedVerified &&
    report.unauthorizedAttemptObserved
      ? 'verified'
      : 'partial';
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  try {
    await raw?.dispose();
  } catch (error) {
    report.disposalError = String(error);
  } finally {
    await child?.dispose().catch((error) => {
      report.disposalError = String(error);
    });
    await rm(workspace, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === 'verified' ? 0 : 1;
