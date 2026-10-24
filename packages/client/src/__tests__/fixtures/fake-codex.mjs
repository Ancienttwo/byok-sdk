#!/usr/bin/env node
// Qualified app-server JSON-RPC fixture. No exec parser or exec event compatibility lane.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnProcessTreeDescendant } from './process-tree-receipt.mjs';
const argv = process.argv.slice(2);
const config = {};
for (let i = 0; i < argv.length; i++)
  if (argv[i] === '-c') {
    const value = argv[++i];
    const eq = value.indexOf('=');
    config[value.slice(0, eq)] = value.slice(eq + 1);
  }
if (argv.includes('--version')) {
  console.log(process.env.FAKE_CODEX_VERSION ?? 'codex-cli 0.160.0');
  process.exit(0);
}
if (argv[0] === 'login') {
  console.error(
    process.env.FAKE_CODEX_LOGGED_IN === '0'
      ? 'Not logged in'
      : 'Logged in using ChatGPT',
  );
  process.exit(process.env.FAKE_CODEX_LOGGED_IN === '0' ? 1 : 0);
}
if (!argv.includes('app-server')) {
  console.error('fixture requires app-server; exec is removed');
  process.exit(2);
}
if (argv.includes('--help')) {
  if (process.env.FAKE_CODEX_NO_APP_SERVER === '1') process.exit(2);
  console.log('app-server --listen stdio://');
  process.exit(0);
}
if (process.env.FAKE_CODEX_ENV_RECEIPT) {
  // Presence and comparisons only: never persist credential or ambient values.
  writeFileSync(process.env.FAKE_CODEX_ENV_RECEIPT, JSON.stringify({
    present: Object.fromEntries(Object.keys(process.env).map((name) => [name, true])),
    configMatches: process.env.MY_ALLOWED_CONFIG === 'synthetic-config',
    authDiscoveryMatches: process.env.HOME === process.env.CODEX_HOME && process.env.USER === 'synthetic-user',
  }));
}
if (process.env.FAKE_CODEX_PROCESS_TREE_FILE)
  await spawnProcessTreeDescendant({
    receiptFile: process.env.FAKE_CODEX_PROCESS_TREE_FILE,
    rootPid: process.pid,
    ignoreTerm: process.env.FAKE_CODEX_IGNORE_SIGTERM === '1',
  });
if (process.env.FAKE_CODEX_CRASH_WITH_STDERR) {
  console.error(process.env.FAKE_CODEX_CRASH_WITH_STDERR);
  process.exit(1);
}
const send = (value) => console.log(JSON.stringify(value));
const notify = (method, params) => send({ method, params });
let threadId = process.env.FAKE_CODEX_THREAD_ID ?? 'fake-thread-1';
/** Session MCP launch configs from the thread open, as real codex receives them. */
let sessionMcpServers = {};
/**
 * A real MCP stdio client, the way codex calls a session server's tool:
 * spawn it with its configured command/args/env, initialize, list tools,
 * call one tool, then close stdin and require the server to exit.
 */
async function callSessionMcpTool(name, tool, args) {
  const server = sessionMcpServers[name];
  if (!server) throw new Error(`no session MCP server ${name}`);
  const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...(server.env ?? {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const frame = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending.get(frame.id)?.(frame);
      pending.delete(frame.id);
    }
  });
  let next = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-codex', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await rpc('tools/list', {});
    if (process.env.FAKE_CODEX_MCP_TOOLS_RECEIPT) writeFileSync(process.env.FAKE_CODEX_MCP_TOOLS_RECEIPT, JSON.stringify(listed.result));
    return await rpc('tools/call', { name: tool, arguments: args });
  } finally {
    child.stdin.end();
    // A stdio MCP server exits once its client closes stdin; codex does not reap it.
    const exited = child.exitCode !== null || child.signalCode !== null || await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) {
      child.kill('SIGKILL');
      throw new Error(`session MCP server ${name} did not exit after its stdin closed`);
    }
  }
}
let turn = 0;
let active = null;
const receipt = (frame) => {
  if (process.env.FAKE_CODEX_RPC_RECEIPT)
    writeFileSync(
      process.env.FAKE_CODEX_RPC_RECEIPT,
      JSON.stringify(frame) + '\n',
      { flag: 'a' },
    );
};
const complete = (id, status = 'completed') => {
  if (active !== id) return;
  active = null;
  notify('turn/completed', {
    threadId,
    turn: {
      id,
      status,
      ...(status === 'failed'
        ? {
            error: {
              message:
                process.env.FAKE_CODEX_FAIL_MESSAGE ?? 'fixture turn failed',
              // JSON of the turn's `codexErrorInfo`, when set.
              ...(process.env.FAKE_CODEX_ERROR_INFO === undefined
                ? {}
                : { codexErrorInfo: JSON.parse(process.env.FAKE_CODEX_ERROR_INFO) }),
            },
          }
        : {}),
    },
  });
};
async function runTurn(id, input) {
  notify('turn/started', { threadId, turn: { id } });
  notify('item/started', {
    threadId,
    turnId: id,
    item: {
      id: 'cmd-1',
      type: 'commandExecution',
      command: 'echo hello',
      status: 'inProgress',
    },
  });
  if (process.env.FAKE_CODEX_EXIT_NO_TERMINAL === '1') {
    console.error('fixture stopped without terminal');
    process.exit(1);
  }
  if (process.env.FAKE_CODEX_SERVER_REQUEST) {
    send({
      id: 'server-req',
      method: process.env.FAKE_CODEX_SERVER_REQUEST,
      params: { threadId },
    });
  }
  if (process.env.FAKE_CODEX_HANG === '1') return;
  if (process.env.FAKE_CODEX_MISSING_TOOL_ID === '1') {
    notify('item/completed', {
      threadId,
      item: { type: 'commandExecution', status: 'completed' },
    });
    return;
  }
  notify('item/completed', {
    threadId,
    turnId: id,
    item: {
      id: 'cmd-1',
      type: 'commandExecution',
      command: 'echo hello',
      aggregatedOutput: 'hello\n',
      exitCode: 0,
      status: 'completed',
    },
  });
  if (process.env.FAKE_CODEX_ARTIFACT_NAME) {
    const name = process.env.FAKE_CODEX_ARTIFACT_NAME;
    writeFileSync(
      path.resolve(process.cwd(), name),
      process.env.FAKE_CODEX_ARTIFACT_CONTENT ?? 'artifact from fake codex',
    );
    notify('item/completed', {
      threadId,
      turnId: id,
      item: {
        id: 'file-1',
        type: 'fileChange',
        changes: [{ path: path.resolve(process.cwd(), name), kind: 'add' }],
        status: 'completed',
      },
    });
  }
  if (process.env.FAKE_CODEX_SUBMIT_RESULT) {
    const args = JSON.parse(process.env.FAKE_CODEX_SUBMIT_RESULT);
    const response = await callSessionMcpTool('byokagentresult', 'submit_result', args);
    notify('item/completed', {
      threadId,
      turnId: id,
      item: {
        id: 'mcp-result-1', type: 'mcpToolCall', server: 'byokagentresult', tool: 'submit_result', arguments: args,
        ...(response.error === undefined ? { result: response.result } : { error: response.error }),
        status: response.error === undefined && response.result?.isError !== true ? 'completed' : 'failed',
      },
    });
  }
  if (process.env.FAKE_CODEX_MCP_TOOL_CALL) {
    const [server, tool] = process.env.FAKE_CODEX_MCP_TOOL_CALL.split('/');
    // Real Codex enables every tool of a configured server unless the user's
    // own config narrows it with enabled_tools.
    const configured = config[`mcp_servers.${server}.enabled_tools`];
    if (config[`mcp_servers.${server}.command`] === undefined
      || (configured !== undefined && !JSON.parse(configured).includes(tool))) {
      notify('error', {
        threadId,
        error: { message: 'MCP tool requires approval' },
      });
      complete(id, 'failed');
      return;
    }
    notify('item/completed', {
      threadId,
      turnId: id,
      item: {
        id: 'mcp-1',
        type: 'mcpToolCall',
        server,
        tool,
        arguments: {},
        result: { ok: true },
        status: 'completed',
      },
    });
  }
  const messageText = input.map((p) => p.text ?? '').join('')
    ? 'hello from fake codex'
    : 'empty prompt';
  // FAKE_CODEX_MESSAGE_DELTAS=1: stream the message as two deltas, plus one
  // delta of a stale turn. FAKE_CODEX_REPLY_GATE=<dir> then waits for
  // `<dir>/release` before the completed item.
  if (process.env.FAKE_CODEX_MESSAGE_DELTAS === '1') {
    notify('item/agentMessage/delta', { threadId, turnId: 'stale-turn', itemId: 'stale-item', delta: 'STALE' });
    const half = Math.ceil(messageText.length / 2);
    for (const delta of [messageText.slice(0, half), messageText.slice(half)])
      notify('item/agentMessage/delta', { threadId, turnId: id, itemId: 'message-1', delta });
    const gate = process.env.FAKE_CODEX_REPLY_GATE;
    while (gate && !existsSync(path.join(gate, 'release'))) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  notify('item/completed', {
    threadId,
    turnId: id,
    item: {
      id: 'message-1',
      type: 'agentMessage',
      text: messageText,
    },
  });
  notify('thread/tokenUsage/updated', {
    threadId,
    tokenUsage: {
      last: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningOutputTokens: 2,
        totalTokens: 110,
      },
      total: {
        inputTokens: 100 * turn,
        cachedInputTokens: 20 * turn,
        outputTokens: 10 * turn,
        reasoningOutputTokens: 2 * turn,
      },
      modelContextWindow: 10000,
    },
  });
  if (process.env.FAKE_CODEX_TURN_FAILS === '1') {
    notify('error', {
      threadId,
      error: {
        message: process.env.FAKE_CODEX_FAIL_MESSAGE ?? 'fixture turn failed',
      },
    });
    complete(id, 'failed');
    return;
  }
  complete(id);
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    process.exit(2);
  }
  receipt(frame);
  if (frame.id === undefined) return;
  const { id, method, params = {} } = frame;
  if (!method) return;
  if (method === 'initialize') {
    send({ id, result: { userAgent: 'fake-codex' } });
    return;
  }
  if (method === 'thread/start' || method === 'thread/resume') {
    if (process.env.FAKE_CODEX_HANG_BEFORE_THREAD === '1') return;
    // Session MCP servers arrive in the open's config; codex merges them into
    // the user's own config field by field.
    for (const [name, server] of Object.entries(params.config?.mcp_servers ?? {}))
      config[`mcp_servers.${name}.command`] = JSON.stringify(server.command);
    sessionMcpServers = { ...sessionMcpServers, ...(params.config?.mcp_servers ?? {}) };
    if (method === 'thread/resume' && params.threadId !== threadId) {
      send({
        id,
        error: {
          code: Number(process.env.FAKE_CODEX_RESUME_ERROR_CODE ?? -32600),
          message: `no rollout found for thread id ${params.threadId}`,
        },
      });
      return;
    }
    send({
      id,
      result: {
        thread:
          process.env.FAKE_CODEX_NO_THREAD_STARTED === '1'
            ? {}
            : { id: process.env.FAKE_CODEX_REPORTED_THREAD_ID ?? threadId },
        model: params.model ?? 'fake-model',
        reasoningEffort: null,
      },
    });
    if (method === 'thread/resume')
      notify('thread/tokenUsage/updated', {
        threadId,
        tokenUsage: {
          total: {
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          last: null,
        },
      });
    return;
  }
  if (method === 'turn/start') {
    active = `turn-${++turn}`;
    if (turn > 1 && process.env.FAKE_CODEX_HANG_FOLLOWUP === '1') return;
    if (process.env.FAKE_CODEX_HANG_TURN_START === '1') return;
    // Two frames and no reply: a failed turn, then a frame a failing consumer can halt on.
    if (process.env.FAKE_CODEX_FAIL_IN_START === '1') {
      complete(active, 'failed');
      notify('thread/tokenUsage/updated', {
        threadId,
        tokenUsage: { total: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }, last: null },
      });
      return;
    }
    send({ id, result: { turn: { id: active } } });
    const current = active;
    setTimeout(() => void runTurn(current, params.input ?? []), 5);
    return;
  }
  if (method === 'turn/steer') {
    if (process.env.FAKE_CODEX_HANG_STEER === '1') return;
    if (params.expectedTurnId !== active) {
      send({ id, error: { code: -32000, message: 'expected turn mismatch' } });
      return;
    }
    send({ id, result: {} });
    return;
  }
  if (method === 'turn/interrupt') {
    if (process.env.FAKE_CODEX_LATE_INTERRUPT === '1') return;
    send({ id, result: {} });
    if (active) complete(active, 'interrupted');
    return;
  }
  send({ id, error: { code: -32601, message: 'unsupported fake method' } });
});
