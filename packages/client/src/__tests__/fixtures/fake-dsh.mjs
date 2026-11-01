#!/usr/bin/env node
// Fake DeepSeek Harness CLI for offline adapter tests. It calls no model and
// reads no credential. Frame shapes follow the dsh 0.2.1-rc.5 ACP server as
// probed in docs/plans/2026-11-01-dsh-adapter.md §2.
//
// argv: `--version` prints FAKE_DSH_VERSION (default 0.2.1-rc.5).
// `--profile acp --help` writes $DSH_HOME/profiles/acp and exits 0
// (FAKE_DSH_NO_ACP=1: exits 2). `--profile acp --patch <file>` serves ACP.
// The prompt text selects the scenario (see `prompt` below).
// FAKE_DSH_LOG receives one JSON line per observed fact.
// FAKE_DSH_ROUTE overrides the model route session/new reports.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const log = (fact) => { if (process.env.FAKE_DSH_LOG) appendFileSync(process.env.FAKE_DSH_LOG, `${JSON.stringify(fact)}\n`); };
const home = process.env.DSH_HOME;

if (args[0] === '--version') {
  process.stdout.write(`${process.env.FAKE_DSH_VERSION ?? '0.2.1-rc.5'}\n`);
  process.exit(0);
}
if (args[0] !== '--profile' || args[1] !== 'acp') { process.stderr.write(`unexpected argv ${JSON.stringify(args)}\n`); process.exit(64); }
if (args[2] === '--help') {
  if (process.env.FAKE_DSH_NO_ACP === '1') process.exit(2);
  mkdirSync(path.join(home, 'profiles', 'acp'), { recursive: true });
  log({ kind: 'help', cwd: process.cwd() });
  process.exit(0);
}
if (args[2] !== '--patch' || args.length !== 4) { process.stderr.write(`unexpected argv ${JSON.stringify(args)}\n`); process.exit(64); }

const patch = JSON.parse(readFileSync(args[3], 'utf8'));
const acp = patch.find((entry) => entry.id === 'acp')?.config;
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(DSH_|FAKE_|TEST_)/.test(name)));
log({ kind: 'start', argv: args, cwd: process.cwd(), env, patch, pid: process.pid });

const sessions = path.join(home, 'fake-sessions');
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const result = (id, value = {}) => send({ id, result: value });
const error = (id, code, message) => send({ id, error: { code, message } });
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } });
const configOptions = () => [{
  id: 'model', name: 'Model', category: 'model', type: 'select',
  currentValue: process.env.FAKE_DSH_ROUTE ?? JSON.stringify([acp.provider, acp.model]),
  options: [],
}];
let hanging;
let reverseId = 0;
const reverse = new Map();

function prompt(id, sessionId, text) {
  if (text === 'fail') return error(id, -32603, 'Internal error: turn failed: 401: {"message":"invalid api key"}');
  if (text === 'exit') process.exit(3);
  if (text === 'hang') { hanging = { id, sessionId }; return; }
  if (text === 'permission') {
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call_p', title: 'bash', kind: 'other', status: 'in_progress', rawInput: { command: 'echo x > ../out', sandbox_permissions: 'danger-full-access' } });
    reverseId += 1;
    reverse.set(reverseId, (answer) => {
      log({ kind: 'permission-answer', answer });
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call_p', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Error: approval was cancelled' } }] });
      result(id, { stopReason: 'end_turn' });
    });
    return send({ id: reverseId, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'call_p' }, options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] } });
  }
  update(sessionId, { sessionUpdate: 'usage_update', used: 90, size: 1000 });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: `first message: ${text}` } });
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'bash', kind: 'other', status: 'in_progress', rawInput: { command: 'ls' } });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a.txt\n' } }] });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'final answer' } });
  update(sessionId, { sessionUpdate: 'usage_update', used: 100, size: 1000 });
  result(id, { stopReason: 'end_turn' });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    const answer = reverse.get(message.id);
    reverse.delete(message.id);
    answer?.(message.result ?? message.error);
    return;
  }
  log({ kind: 'request', method: message.method, params: message.params });
  const { id, method, params } = message;
  if (method === 'initialize') return result(id, { protocolVersion: Number(process.env.FAKE_DSH_PROTOCOL ?? 1), agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' }, agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } }, authMethods: [] });
  if (method === 'session/new') {
    const sessionId = process.env.FAKE_DSH_SESSION_ID ?? 'dsh-session-1';
    mkdirSync(sessions, { recursive: true });
    writeFileSync(path.join(sessions, sessionId), params.cwd);
    return result(id, { sessionId, configOptions: configOptions() });
  }
  if (method === 'session/resume') {
    const file = path.join(sessions, params.sessionId);
    if (!existsSync(file)) return error(id, -32602, `Invalid params: session is not resumable: ${params.sessionId}`);
    if (readFileSync(file, 'utf8') !== params.cwd) return error(id, -32602, `Invalid params: session cwd does not match: ${params.cwd}`);
    return result(id, { configOptions: configOptions() });
  }
  if (method === 'session/prompt') return prompt(id, params.sessionId, params.prompt.map((block) => block.text).join(''));
  if (method === 'session/cancel') {
    if (hanging) { result(hanging.id, { stopReason: 'cancelled' }); hanging = undefined; }
    return;
  }
  if (method === 'session/close') return result(id, {});
  if (id !== undefined) error(id, -32601, `Method not found: ${method}`);
});
