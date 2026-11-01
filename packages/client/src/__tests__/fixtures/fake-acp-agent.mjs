#!/usr/bin/env node
// Fake ACP agent over stdio for offline adapter tests. It calls no model and
// reads no login. Frame shapes follow OAR ddec7e5 tests/fixtures
// (fake-acp-agent.mjs, fake-acp-grok.mjs: Grok 1.0.25 wire, Apache-2.0).
//
// argv: `--version` prints a version; `agent stdio --help` prints help;
// otherwise the last argument must be `stdio` and the process serves ACP.
// The prompt text selects the scenario (see `prompt` below).
// FAKE_ACP_LOG, when set in the child env, receives one JSON line per
// observed fact (argv, env, cwd, requests) so a test can assert the wire.
// FAKE_ACP_REPLY_GATE=<dir>: the default reply waits for `<dir>/release`
// after its two chunks and before the prompt answer.
// FAKE_ACP_INITIALIZE=exit ends the agent on `initialize`; =error answers it
// with an internal error.
// `inspect --json` logs an `inspect` fact and prints FAKE_ACP_INSPECT (default:
// no servers and no plugins); FAKE_ACP_INSPECT=fail exits 1 instead.
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write(`${process.env.FAKE_ACP_VERSION ?? 'grok 1.0.62 (fixture)'}\n`);
  process.exit(0);
}
if (args.includes('--help')) {
  if (process.env.FAKE_ACP_NO_STDIO === '1') { process.stderr.write("error: unrecognized subcommand 'stdio'\n"); process.exit(2); }
  process.stdout.write('Run the agent over stdio\n');
  process.exit(0);
}
if (args[0] === 'inspect') {
  if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify({ kind: 'inspect', argv: args, cwd: process.cwd(), env: process.env })}\n`);
  if (process.env.FAKE_ACP_INSPECT === 'fail') { process.stderr.write('inspect failed\n'); process.exit(1); }
  process.stdout.write(`${process.env.FAKE_ACP_INSPECT ?? '{"mcpServers":[],"plugins":[]}'}\n`);
  process.exit(0);
}
if (args.at(-1) !== 'stdio') { process.stderr.write(`unexpected argv ${JSON.stringify(args)}\n`); process.exit(64); }

const SESSION = process.env.FAKE_ACP_SESSION_ID ?? 'fake-grok-session';
const log = (fact) => { if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(fact)}\n`); };
log({ kind: 'start', argv: args, cwd: process.cwd(), env: process.env, pid: process.pid });

const pending = new Map();
const reverse = new Map();
let reverseId = 0;
let ledgers = 0;

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const result = (id, value = {}) => send({ id, result: value });
const error = (id, code, message, data) => send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const update = (value, sessionId = SESSION) => send({ method: 'session/update', params: { sessionId, update: value } });
const vendor = (value, sessionId = SESSION) => send({ method: '_x.ai/session_notification', params: { sessionId, update: value } });
const text = (value, sessionId) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } }, sessionId);
const ask = (method, params) => new Promise((resolve) => {
  reverseId += 1;
  const id = `client-${reverseId}`;
  reverse.set(id, resolve);
  send({ id, method, params });
});

/** One prompt's answer, with Grok's per-prompt ledger in `_meta.usage`. */
function answer(stopReason = 'end_turn') {
  ledgers += 1;
  return { stopReason, _meta: { totalTokens: 1000 + ledgers, modelId: 'fixture-model', usage: { inputTokens: 100, outputTokens: 7, totalTokens: 107, cachedReadTokens: 64, cacheCreationTokens: 0, modelCalls: 1 } } };
}

function promptText(params) {
  const block = (Array.isArray(params?.prompt) ? params.prompt : []).find((item) => item?.type === 'text');
  return typeof block?.text === 'string' ? block.text : '';
}

async function prompt(message) {
  const full = promptText(message.params);
  log({ kind: 'prompt', text: full });
  // The daemon may put rules before the task; the last line selects the scenario.
  const input = full.trim().split('\n').at(-1) ?? '';
  if (input === 'hold' || process.env.FAKE_ACP_HANG === '1') { pending.set(message.id, 'hold'); return; }
  if (input === 'hold-silent') { pending.set(message.id, 'silent'); return; }
  if (input === 'exit') { process.exit(9); }
  // Grok's own words for a -32603; `fail-text:` adds the provider's answer as `data`.
  if (input === 'fail') { error(message.id, -32603, 'Internal error'); return; }
  if (input.startsWith('fail-text:')) { error(message.id, -32603, 'Internal error', input.slice('fail-text:'.length)); return; }
  if (input === 'rate-limited') { error(message.id, -32003, 'Rate limited'); return; }
  // Grok names the cause of a -32603 in the retry_state that ended its retries.
  if (input.startsWith('retry-failed:')) {
    vendor({ sessionUpdate: 'retry_state', type: 'failed', error_type: input.slice('retry-failed:'.length) });
    error(message.id, -32603, 'Internal error');
    return;
  }
  // The same two lines in one write: the client reads them in one pipe chunk, as it does under load.
  if (input.startsWith('retry-failed-one-write:')) {
    const retry = { method: '_x.ai/session_notification', params: { sessionId: SESSION, update: { sessionUpdate: 'retry_state', type: 'failed', error_type: input.slice('retry-failed-one-write:'.length) } } };
    const failed = { id: message.id, error: { code: -32603, message: 'Internal error' } };
    process.stdout.write([retry, failed].map((frame) => `${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`).join(''));
    return;
  }
  if (input === 'huge') { text('x'.repeat(256 * 1024)); result(message.id, answer()); return; }
  if (input === 'tool') {
    text('Let me look. ');
    update({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'run_terminal_command', status: 'pending', rawInput: { command: 'ls' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }], rawOutput: { type: 'Bash', exit_code: 0 } });
    text('Found ');
    text('a.txt.');
    result(message.id, answer());
    return;
  }
  if (input === 'tool-failed') {
    update({ sessionUpdate: 'tool_call', toolCallId: 'call-2', title: 'read_file', status: 'pending', rawInput: { path: 'missing' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'not found' } }] });
    text('No file.');
    result(message.id, answer());
    return;
  }
  if (input === 'child') {
    vendor({ sessionUpdate: 'subagent_spawned', subagent_id: 'fake-child', parent_session_id: SESSION, child_session_id: 'fake-child' });
    text('child-says-hi', 'fake-child');
    update({ sessionUpdate: 'tool_call', toolCallId: 'child-call', title: 'read_file', status: 'pending', rawInput: {} }, 'fake-child');
    vendor({ sessionUpdate: 'subagent_finished', subagent_id: 'fake-child', child_session_id: 'fake-child', status: 'completed' });
    text('parent-answer');
    result(message.id, answer());
    return;
  }
  if (input === 'permission') {
    const reply = await ask('session/request_permission', {
      sessionId: SESSION,
      toolCall: { toolCallId: 'permission-tool', title: 'Permission fixture', kind: 'execute', status: 'pending' },
      options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Always allow' }],
    });
    log({ kind: 'permission', reply });
    text(`permission:${reply?.outcome?.outcome ?? 'none'}`);
    result(message.id, answer());
    return;
  }
  if (input === 'terminal' || input === 'terminal-hang' || input === 'terminal-compat') {
    // Grok sends one quoted shell line as `command` with no `args`.
    const command = input === 'terminal'
      ? `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.env.FAKE_TERMINAL_MARK ?? 'unset')"`
      : input === 'terminal-compat'
        ? `${JSON.stringify(process.execPath)} -e "process.stdout.write(['GROK_CLAUDE_AGENTS_ENABLED','GROK_CLAUDE_RULES_ENABLED','GROK_CURSOR_AGENTS_ENABLED','GROK_CURSOR_RULES_ENABLED'].map(name=>process.env[name]??'unset').join())"`
        : `${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)"`;
    const created = await ask('terminal/create', { sessionId: SESSION, command, env: [{ name: 'FAKE_TERMINAL_MARK', value: 'terminal-ok' }] });
    log({ kind: 'terminal', created });
    if (input === 'terminal-hang') { pending.set(message.id, 'silent'); return; }
    const exit = await ask('terminal/wait_for_exit', { sessionId: SESSION, terminalId: created.terminalId });
    const output = await ask('terminal/output', { sessionId: SESSION, terminalId: created.terminalId });
    await ask('terminal/release', { sessionId: SESSION, terminalId: created.terminalId });
    log({ kind: 'terminal-done', exit, output });
    text(`terminal:${output.output}`);
    result(message.id, answer());
    return;
  }
  text('echo:');
  text(input);
  const gate = process.env.FAKE_ACP_REPLY_GATE;
  while (gate && !existsSync(path.join(gate, 'release'))) await new Promise((resolve) => setTimeout(resolve, 10));
  result(message.id, answer());
}

function request(message) {
  switch (message.method) {
    case 'initialize':
      log({ kind: 'initialize', params: message.params });
      if (process.env.FAKE_ACP_INITIALIZE === 'exit') process.exit(1);
      if (process.env.FAKE_ACP_INITIALIZE === 'error') { error(message.id, -32603, 'Internal error'); return; }
      result(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} }, promptCapabilities: { image: false }, mcpCapabilities: { http: true } },
        authMethods: [{ id: 'cached_token', name: 'Cached login' }],
        _meta: { defaultAuthMethodId: 'cached_token' },
      });
      return;
    case 'authenticate':
      if (process.env.FAKE_ACP_AUTH === 'refuse') { error(message.id, -32000, 'Authentication required'); return; }
      result(message.id);
      return;
    case 'session/new':
      log({ kind: 'open', method: message.method, params: message.params });
      result(message.id, { sessionId: SESSION });
      return;
    case 'session/resume':
      log({ kind: 'open', method: message.method, params: message.params });
      if (message.params?.sessionId !== SESSION) { error(message.id, -32603, 'session not found', { code: 'FS_NOT_FOUND' }); return; }
      result(message.id, {});
      return;
    case 'session/set_model':
      log({ kind: 'model', params: message.params });
      if (message.params?.modelId === 'no-such-model') { error(message.id, -32602, 'Invalid params: unknown model'); return; }
      result(message.id, { _meta: { modelId: message.params?.modelId } });
      return;
    case 'session/prompt':
      void prompt(message);
      return;
    case 'session/close':
      log({ kind: 'close' });
      result(message.id);
      return;
    default:
      error(message.id, -32601, `unknown ACP method: ${message.method}`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && typeof message.method !== 'string') {
    const resolve = reverse.get(message.id);
    reverse.delete(message.id);
    resolve?.(message.result ?? { error: message.error });
    return;
  }
  if (message.id === undefined) {
    if (message.method === 'session/cancel') {
      log({ kind: 'cancel' });
      // A `silent` prompt models an agent that never answers its cancel.
      for (const [id, kind] of [...pending]) {
        if (kind === 'silent') continue;
        pending.delete(id);
        result(id, answer('cancelled'));
      }
    }
    return;
  }
  request(message);
});
