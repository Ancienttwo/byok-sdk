#!/usr/bin/env node
// Synthetic Hermes Agent CLI for HermesAdapter tests. No Python, no model.
//
//   hermes --version                 version line (FAKE_HERMES_VERSION)
//   hermes gateway run ...           long-lived gateway that answers the
//                                    control-channel `identify` verb, as the
//                                    real gateway does (gateway/control_socket.py):
//                                    <home>/gateway.sock on POSIX, the named
//                                    pipe hermes-gateway-<hash> on Windows
//   hermes [--yolo] acp              ACP v1 agent over stdio (the viewer)
//
// The viewer refuses session/new unless a ready gateway serves its
// HERMES_HOME, as the real viewer cannot run a turn without one. Every
// observable input is appended to FAKE_HERMES_RECEIPT as one JSON line.
// FAKE_HERMES_REPLY_GATE=<dir>: the closing reply streams as `Do`, `ne`,
// then waits for `<dir>/release` before its last chunk `.`.
// FAKE_HERMES_TOOL_TREE=<file>: the gateway starts a tool parent whose child left its group (setsid);
// session/cancel SIGKILLs that parent for the gateway, orphaning the tool.
// On Windows, ci.yml's windows-client job runs it under hermes-adapter.test.ts and hermes-custody.test.ts (#712).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawnProcessTreeDescendant } from './process-tree-receipt.mjs';

const argv = process.argv.slice(2);
const env = process.env;
const home = env.HERMES_HOME;
const receipt = (entry) => {
  if (env.FAKE_HERMES_RECEIPT) appendFileSync(env.FAKE_HERMES_RECEIPT, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};

if (argv.includes('--version')) {
  receipt({ mode: 'version', home, hermesEnv: Object.keys(env).filter((name) => name.startsWith('HERMES_')).sort() });
  console.log(env.FAKE_HERMES_VERSION ?? 'Hermes Agent v0.22.2+2364.g0b10b9f (2026.9.24) · stable · local 0b10b9f8155a');
  console.log('Install directory: /synthetic/hermes-agent');
  process.exit(0);
}

const hermesEnv = Object.keys(env).filter((name) => name.startsWith('HERMES_')).sort();
// Native: on Windows the JS realpath keeps 8.3 short names; Hermes resolves the long form.
const realHome = () => realpathSync.native(home);

/** `windows_pipe_name` in Hermes's gateway/control_socket.py, derived here independently of the adapter. */
function controlPath() {
  if (process.platform !== 'win32') return path.join(home, 'gateway.sock');
  const hash = createHash('sha256').update(realHome().replaceAll('/', '\\').toLowerCase(), 'utf8').digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\hermes-gateway-${hash}`;
}

function serveIdentify(socketPath, identity) {
  if (process.platform !== 'win32' && existsSync(socketPath)) unlinkSync(socketPath);
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      socket.end(`${JSON.stringify({ ok: true, protocol: 1, id: 1, result: identity() })}\n`);
    });
  });
  server.listen(socketPath);
  return server;
}

if (argv[0] === 'gateway' && argv[1] === 'run') {
  receipt({ mode: 'gateway', argv, home, cwd: process.cwd(), hermesEnv, seededCache: existsSync(path.join(home, 'models_dev_cache.json')) });
  if (env.FAKE_HERMES_GATEWAY_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {});
  if (env.FAKE_HERMES_PROCESS_TREE_FILE) {
    await spawnProcessTreeDescendant({
      receiptFile: env.FAKE_HERMES_PROCESS_TREE_FILE,
      rootPid: process.pid,
      ignoreTerm: env.FAKE_HERMES_GATEWAY_IGNORE_SIGTERM === '1',
    });
  }
  if (env.FAKE_HERMES_TOOL_TREE) spawn(process.execPath, [new URL('./process-tree-descendant.mjs', import.meta.url).pathname, env.FAKE_HERMES_TOOL_TREE, String(process.pid), '0', '', '1'], { stdio: 'ignore' });
  // The real gateway prints a banner on stdout even with --quiet.
  console.log('Hermes Gateway Starting...');
  // FAKE_HERMES_GATEWAY_EXIT_BEFORE_READY=1: the gateway ends without ever answering identify.
  if (env.FAKE_HERMES_GATEWAY_EXIT_BEFORE_READY === '1') process.exit(1);
  const readyAt = Date.now() + Number(env.FAKE_HERMES_GATEWAY_READY_DELAY_MS ?? 0);
  const served = realHome();
  serveIdentify(controlPath(), () => ({
    kind: 'hermes-gateway',
    pid: env.FAKE_HERMES_GATEWAY_WRONG_PID === '1' ? process.pid + 100_000 : process.pid,
    state: env.FAKE_HERMES_GATEWAY_NEVER_READY === '1' || Date.now() < readyAt ? 'starting' : 'ready',
    served_profiles: [{ profile_id: served, home: served }],
  }));
  // A gateway fetches model metadata into its home; the adapter carries it to the next profile.
  writeFileSync(path.join(home, 'models_dev_cache.json'), JSON.stringify({ synthetic: true }));
  setInterval(() => {}, 60_000);
} else if (argv.includes('acp')) {
  runViewer();
} else {
  console.error(`fake-hermes: unsupported arguments ${argv.join(' ')}`);
  process.exit(2);
}

function identifyGateway() {
  return new Promise((resolve) => {
    const socket = net.createConnection(controlPath());
    let buffer = '';
    socket.on('connect', () => socket.write('{"protocol":1,"id":1,"verb":"identify"}\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) { socket.destroy(); resolve(JSON.parse(buffer).result); }
    });
    socket.on('error', () => resolve(undefined));
  });
}

/**
 * Stand-in for the detached gateway a real viewer starts when it finds none:
 * a double-forked orphan in its own session that takes over the control
 * socket. Nothing in the viewer's process tree leads to it, so only the
 * adapter's explicit stop can end it. It exits by itself after 20 s.
 */
async function startForeignGateway() {
  const socketPath = controlPath();
  const readyFile = path.join(home, 'gateway.sock.foreign');
  const server = `const net=require('node:net'),fs=require('node:fs');const [sock,served,ready]=process.argv.slice(1);
try{fs.unlinkSync(sock)}catch{}setTimeout(()=>process.exit(0),20000);
net.createServer(s=>{let b='';s.on('data',c=>{b+=c;if(b.includes('\\n'))s.end(JSON.stringify({ok:true,protocol:1,id:1,result:{pid:process.pid,state:'ready',served_profiles:[{home:served}]}})+'\\n')})}).listen(sock,()=>fs.writeFileSync(ready,String(process.pid)));`;
  const launcher = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',process.argv[1],...process.argv.slice(2)],{detached:true,stdio:'ignore'}).unref();`;
  spawn(process.execPath, ['-e', launcher, server, socketPath, realHome(), readyFile], { stdio: 'ignore' });
  for (let waited = 0; waited < 5_000; waited += 20) {
    if (existsSync(readyFile)) return Number(readFileSync(readyFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('foreign gateway did not start');
}

function runViewer() {
  receipt({ mode: 'acp', argv, home, cwd: process.cwd(), hermesEnv });
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } });
  const sessionId = env.FAKE_HERMES_SESSION_ID ?? 'fake-hermes-session-1';
  let nextId = 1000;
  const waiting = new Map();
  let pendingPrompt;
  let turns = 0;

  const ask = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

  async function prompt(id, params) {
    turns += 1;
    const text = params.prompt?.[0]?.text ?? '';
    receipt({ mode: 'acp', method: 'session/prompt', text, turn: turns });
    if (env.FAKE_HERMES_FAIL_DETAILS) {
      send({ id, error: { code: -32603, message: 'Internal error', data: { details: env.FAKE_HERMES_FAIL_DETAILS } } });
      return;
    }
    update(sessionId, { sessionUpdate: 'session_info_update', title: text });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: `m${turns}`, content: { type: 'text', text: 'Hello' } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: `m${turns}`, content: { type: 'text', text: ` turn ${turns}` } });
    if (env.FAKE_HERMES_KILL_GATEWAY_ON_PROMPT === '1') {
      // The gateway dies mid-turn; the real viewer then loses its turn with no answer.
      process.kill((await identifyGateway()).pid, 'SIGKILL');
      pendingPrompt = id;
      return;
    }
    if (env.FAKE_HERMES_HANG === '1' || env.FAKE_HERMES_IGNORE_CANCEL === '1') {
      pendingPrompt = id;
      return;
    }
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: `t${turns}`, title: 'terminal: ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } });
    if (env.FAKE_HERMES_PERMISSION === '1') {
      const answer = await ask('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: `t${turns}`, title: 'write_file: .env' },
        options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
      });
      receipt({ mode: 'acp', method: 'permission-answer', answer });
    }
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: `t${turns}`, status: 'completed', rawOutput: 'file.txt' });
    const gate = env.FAKE_HERMES_REPLY_GATE;
    for (const chunk of gate ? ['Do', 'ne', '.'] : ['Done.']) {
      while (gate && chunk === '.' && !existsSync(path.join(gate, 'release'))) await new Promise((resolve) => setTimeout(resolve, 10));
      update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: `m${turns}b`, content: { type: 'text', text: chunk } });
    }
    update(sessionId, { sessionUpdate: 'usage_update', used: 20, size: 1000 });
    send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } } });
  }

  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    const message = JSON.parse(line);
    if (message.method === undefined) {
      waiting.get(message.id)?.(message.result ?? message.error);
      waiting.delete(message.id);
      return;
    }
    const { id, method, params } = message;
    if (method === 'initialize') {
      receipt({ mode: 'acp', method, params });
      // FAKE_HERMES_VIEWER_EXIT_ON_INITIALIZE=1: the ACP viewer ends without answering initialize.
      if (env.FAKE_HERMES_VIEWER_EXIT_ON_INITIALIZE === '1') process.exit(1);
      const setup = { id: 'hermes-setup', name: 'Configure Hermes provider', type: 'terminal', args: ['--setup'] };
      send({ id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        authMethods: env.FAKE_HERMES_AUTH === '0' ? [setup] : [{ id: 'custom', name: 'custom runtime credentials' }, setup],
      } });
    } else if (method === 'session/new') {
      const gateway = await identifyGateway();
      receipt({ mode: 'acp', method, params, gatewayPid: gateway?.pid });
      if (gateway?.state !== 'ready') {
        send({ id, error: { code: -32603, message: 'Internal error', data: { details: 'Gateway connection failed; no local fallback' } } });
        return;
      }
      if (env.FAKE_HERMES_VIEWER_TAKES_SOCKET === '1') receipt({ mode: 'foreign-gateway', pid: await startForeignGateway() });
      send({ id, result: { sessionId, modes: { currentModeId: 'default', availableModes: [] } } });
    } else if (method === 'session/set_mode') {
      receipt({ mode: 'acp', method, params });
      send({ id, result: {} });
    } else if (method === 'session/prompt') {
      void prompt(id, params);
    } else if (method === 'session/cancel') {
      receipt({ mode: 'acp', method, params });
      if (env.FAKE_HERMES_TOOL_TREE) process.kill(JSON.parse(readFileSync(env.FAKE_HERMES_TOOL_TREE, 'utf8')).descendantPid, 'SIGKILL');
      if (pendingPrompt !== undefined && env.FAKE_HERMES_IGNORE_CANCEL !== '1') {
        send({ id: pendingPrompt, result: { stopReason: 'cancelled', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } });
        pendingPrompt = undefined;
      }
    } else if (id !== undefined) {
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  });
}
