#!/usr/bin/env node
// Qualified app-server JSON-RPC fixture. No exec parser or exec event compatibility lane.
import { writeFileSync } from 'node:fs';
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
if (argv[0] === 'mcp' && argv[1] === 'get') {
  const name = argv[2];
  let enabled_tools = [];
  try {
    enabled_tools = JSON.parse(
      config[`mcp_servers.${name}.enabled_tools`] ?? '[]',
    );
  } catch {}
  console.log(JSON.stringify({ name, enabled: true, enabled_tools }));
  process.exit(0);
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
  const { toolImplementationLaunchEnvNamesDigest, toolImplementationLoaderEnvValuesDigest } =
    await import('@byok-sdk/implementation-identity');
  // Presence and comparisons only: never persist credential or ambient values.
  writeFileSync(process.env.FAKE_CODEX_ENV_RECEIPT, JSON.stringify({
    present: Object.fromEntries(Object.keys(process.env).map((name) => [name, true])),
    configMatches: process.env.MY_ALLOWED_CONFIG === 'synthetic-config',
    authDiscoveryMatches: process.env.HOME === process.env.CODEX_HOME && process.env.USER === 'synthetic-user',
    namesDigestMatches: toolImplementationLaunchEnvNamesDigest(process.env) === process.env.FAKE_CODEX_ENV_NAMES_DIGEST,
    loaderDigestMatches: toolImplementationLoaderEnvValuesDigest(process.env) === process.env.FAKE_CODEX_ENV_LOADER_DIGEST,
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
  if (process.env.FAKE_CODEX_MCP_TOOL_CALL) {
    const [server, tool] = process.env.FAKE_CODEX_MCP_TOOL_CALL.split('/');
    const enabled = JSON.parse(
      config[`mcp_servers.${server}.enabled_tools`] ?? '[]',
    );
    if (!enabled.includes(tool)) {
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
  notify('item/completed', {
    threadId,
    turnId: id,
    item: {
      id: 'message-1',
      type: 'agentMessage',
      text: input.map((p) => p.text ?? '').join('')
        ? 'hello from fake codex'
        : 'empty prompt',
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
    if (method === 'thread/resume' && params.threadId !== threadId) {
      send({
        id,
        error: {
          code: -32000,
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
    send({ id, result: { turn: { id: active } } });
    const current = active;
    setTimeout(() => void runTurn(current, params.input ?? []), 5);
    return;
  }
  if (method === 'turn/steer') {
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
