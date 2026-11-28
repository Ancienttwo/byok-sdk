#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const log = (fact) => appendFileSync(process.env.FAKE_CURSOR_LOG, `${JSON.stringify(fact)}\n`);
log({ argv, pid: process.pid, credentialNames: Object.keys(process.env).filter(name => /^CURSOR_/i.test(name)), cwd: process.cwd() });
const invocation = argv.join(' ');
if (invocation === '--version') {
  console.log(process.env.FAKE_CURSOR_VERSION ?? '2026.09.18-9a7762b');
  process.exit(0);
}
if (invocation === 'acp --help') {
  console.log('Cursor Agent ACP');
  process.exit(process.env.FAKE_CURSOR_NO_ACP ? 1 : 0);
}
if (invocation === 'status --format json') {
  console.log(process.env.FAKE_CURSOR_STATUS ?? '{"status":"authenticated","isAuthenticated":true}');
  process.exit(process.env.FAKE_CURSOR_STATUS_EXIT ? 1 : 0);
}
if (invocation !== '--force acp') process.exit(64);

const sessionId = 'cursor-fixture-session';
let model = 'default';
let effort = 'medium';
const effortOption = () => ({ id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select',
  currentValue: effort, options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] });
const configOptions = () => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
  options: ['default', 'fixture-model'].map(value => ({ value, name: value })) }, effortOption()];
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const result = (id, value = {}) => send({ id, result: value });
const error = (id, code, message) => send({ id, error: { code, message } });
const update = value => send({ method: 'session/update', params: { sessionId, update: value } });
const text = (value, kind = 'agent_message_chunk') => update({ sessionUpdate: kind, content: { type: 'text', text: value } });
const pending = new Map();
let reverse = 0;
let active;
function ask(method, params) {
  return new Promise(resolve => {
    const id = `cursor-request-${++reverse}`;
    pending.set(id, resolve);
    send({ id, method, params });
  });
}

async function prompt({ id, params }) {
  const instruction = params.prompt.find(block => block.type === 'text').text;
  active = id;
  text('working', 'agent_thought_chunk');
  text('hello ');
  if (instruction === 'exit') process.exit(7);
  if (instruction === 'tree' || instruction === 'detached-tree') {
    const detached = instruction === 'detached-tree';
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore', detached });
    log({ descendant: child.pid });
    if (!detached) return;
    child.unref();
  }
  if (instruction === 'wait') return;
  if (instruction === 'extensions') {
    const names = ['cursor/update_todos', 'cursor/task', 'cursor/generate_image', 'cursor/ask_question', 'cursor/create_plan'];
    const replies = await Promise.all(names.map(method => ask(method, { sessionId })));
    log({ refusals: replies.map(reply => reply.error?.code) });
    if (replies.some(reply => reply.error?.code !== -32601)) throw new Error('the client did not refuse the Cursor extensions');
  }
  if (instruction === 'terminal') {
    const terminal = await ask('terminal/create', { sessionId, command: process.execPath, args: ['-e', ''] });
    log({ terminal });
    if (terminal.result?.terminalId) await ask('terminal/release', { sessionId, terminalId: terminal.result.terminalId });
  }
  if (instruction === 'permission') {
    const reply = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 'shell', kind: 'execute' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
    log({ permission: reply.result });
    result(id, { stopReason: 'cancelled' });
    active = undefined;
    return;
  }
  update({ sessionUpdate: 'tool_call', toolCallId: 'shell', title: 'Read a fixture', kind: 'read', status: 'in_progress', rawInput: { path: 'fixture.txt' } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'shell', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'fixture' } }] });
  text('world');
  result(id, { stopReason: 'end_turn' });
  active = undefined;
}

const authRestricted = new Set(['session/new', 'session/load', 'cursor/list_available_models']);
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const frame = JSON.parse(line);
  log(frame);
  const { method, id, params } = frame;
  if (method === undefined) {
    pending.get(id)?.(frame);
    pending.delete(id);
    continue;
  }
  if (process.env.FAKE_CURSOR_LOGGED_OUT && authRestricted.has(method)) {
    error(id, -32000, 'Authentication required');
    continue;
  }
  switch (method) {
    case 'initialize': result(id, {
      protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: !process.env.FAKE_CURSOR_NO_IMAGES },
        ...(process.env.FAKE_CURSOR_SESSION_CLOSE ? { sessionCapabilities: { close: {} } } : {}) },
      authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }],
    }); break;
    case 'authenticate': throw new Error('SDK attempted to start Cursor login');
    case 'session/load':
      text('old reply');
      result(id, { configOptions: configOptions() });
      break;
    case 'session/new': result(id, { sessionId, configOptions: configOptions() }); break;
    case 'session/close':
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n', () => process.exit(0));
      break;
    case 'session/set_config_option':
      if (params.configId === 'model' && params.value === 'fixture-model') {
        model = process.env.FAKE_CURSOR_WRONG_MODEL ? 'default' : params.value;
      } else if (params.configId === 'reasoning_effort' && params.value === 'high') {
        effort = process.env.FAKE_CURSOR_WRONG_EFFORT ? 'medium' : params.value;
      } else { error(id, -32602, 'Invalid params'); break; }
      result(id, { configOptions: configOptions() });
      break;
    case 'cursor/list_available_models':
      result(id, { models: [{ value: 'default', name: 'Auto' }, { value: 'fixture-model', name: 'Fixture', configOptions: [effortOption()] }] });
      break;
    case 'session/prompt': void prompt(frame).catch(err => error(id, -32603, err.message)); break;
    case 'session/cancel':
      if (active !== undefined && !process.env.FAKE_CURSOR_IGNORE_CANCEL) {
        result(active, { stopReason: 'cancelled' });
        active = undefined;
      }
      break;
    default: error(id, -32601, 'Unsupported method');
  }
}
