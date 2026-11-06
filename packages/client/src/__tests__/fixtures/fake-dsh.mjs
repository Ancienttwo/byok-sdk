#!/usr/bin/env node
// Fake DeepSeek Harness CLI for offline adapter tests. It calls no model and
// reads no credential. It stands in for dsh with the OAR bridge plugin loaded:
// the same JSON lines, with native payloads as probed on dsh 0.2.1-rc.5
// (docs/researches/2026-11-06-oar-0.91.0-dsh-bridge.md).
//
// argv: `--version` prints FAKE_DSH_VERSION (default 0.2.2-rc.1).
// `--profile acp --help` writes $DSH_HOME/profiles/acp and exits 0
// (FAKE_DSH_NO_ACP=1: exits 2). `--profile acp --patch <sdk> --patch <bridge>`
// serves the bridge. The prompt text selects the scenario (see `prompt` below).
// FAKE_DSH_LOG receives one JSON line per observed fact.
// FAKE_DSH_ROUTE overrides the model route the first request reports.
// FAKE_DSH_NO_STEER=1: `open` reports no native steer.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const log = (fact) => { if (process.env.FAKE_DSH_LOG) appendFileSync(process.env.FAKE_DSH_LOG, `${JSON.stringify(fact)}\n`); };
const home = process.env.DSH_HOME;

if (args[0] === '--version') {
  process.stdout.write(`${process.env.FAKE_DSH_VERSION ?? '0.2.2-rc.1'}\n`);
  process.exit(0);
}
if (args[0] !== '--profile' || args[1] !== 'acp') { process.stderr.write(`unexpected argv ${JSON.stringify(args)}\n`); process.exit(64); }
if (args[2] === '--help') {
  if (process.env.FAKE_DSH_NO_ACP === '1') process.exit(2);
  mkdirSync(path.join(home, 'profiles', 'acp'), { recursive: true });
  log({ kind: 'help', cwd: process.cwd() });
  process.exit(0);
}
if (args[2] !== '--patch' || args[4] !== '--patch' || args.length !== 6) { process.stderr.write(`unexpected argv ${JSON.stringify(args)}\n`); process.exit(64); }

const patch = JSON.parse(readFileSync(args[3], 'utf8'));
const overlay = JSON.parse(readFileSync(args[5], 'utf8'));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(DSH_|FAKE_|TEST_|TMPDIR$)/.test(name)));
log({ kind: 'start', argv: args, cwd: process.cwd(), env, patch, overlay, pid: process.pid });

const sessions = path.join(home, 'fake-sessions');
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const event = (sessionId, type, data = {}) => write({ type: 'native', channel: 'session/event', sessionId, event: { type, data } });
const assistant = (sessionId, content, usage) => event(sessionId, 'assistant/message', { message: { role: 'assistant', content }, usage });
const toolCall = (sessionId, callId, name, args) => {
  assistant(sessionId, [{ type: 'tool-call', id: callId, name, arguments: args }], { inputTokens: 90, outputTokens: 5, totalTokens: 95 });
  event(sessionId, 'tool/call', { callId, name, arguments: args });
};
let route;
let hanging;

function prompt(sessionId, text) {
  event(sessionId, 'turn/start');
  const end = (reason) => event(sessionId, 'turn/end', { reason });
  if (text === 'fail') return end({ kind: 'error', error: { code: 'AUTH', status: 401, message: 'invalid api key' } });
  if (text === 'rate-limit') return end({ kind: 'error', error: { code: 'RATE_LIMIT', status: 429, message: 'rate limit exceeded' } });
  if (text === 'exit') process.exit(3);
  if (text === 'hang') { hanging = sessionId; return; }
  const [provider, ...model] = (process.env.FAKE_DSH_ROUTE ?? route).split('/');
  event(sessionId, 'request/header', { header: { config: { provider, model: model.join('/') } } });
  event(sessionId, 'request/context', { contextWindow: 1000 });
  if (text === 'long-input') {
    toolCall(sessionId, 'call_long', 'bash', JSON.stringify({ command: `echo ${'a'.repeat(12000)}; git push origin main`, description: 'long' }));
    return end({ kind: 'completed' });
  }
  if (text === 'spontaneous') {
    assistant(sessionId, [{ type: 'text', text: 'started a subagent' }], { inputTokens: 90, outputTokens: 5, totalTokens: 95 });
    end({ kind: 'completed' });
    // The turn dsh opens by itself when a background child finishes.
    event(sessionId, 'turn/start');
    assistant(sessionId, [{ type: 'text', text: 'stray reply' }], { inputTokens: 90, outputTokens: 5, totalTokens: 95 });
    return end({ kind: 'completed' });
  }
  if (text === 'bad-input') {
    toolCall(sessionId, 'call_bad', 'bash', 'not json');
    return end({ kind: 'completed' });
  }
  assistant(sessionId, [{ type: 'text', text: `first message: ${text}` }, { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }], { inputTokens: 90, outputTokens: 5, totalTokens: 95 });
  event(sessionId, 'tool/call', { callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}' });
  event(sessionId, 'tool/result', { message: { toolCallId: 'call_1', isError: false, content: [{ type: 'text', text: 'a.txt\n' }] } });
  assistant(sessionId, [{ type: 'text', text: 'final answer' }], { inputTokens: 100, outputTokens: 7, cacheReadTokens: 20, totalTokens: 127 });
  end({ kind: 'completed' });
}

const commands = {
  open(request) {
    route = `${request.agentOptions.provider}/${request.agentOptions.model}`;
    mkdirSync(sessions, { recursive: true });
    writeFileSync(path.join(sessions, request.sessionId), request.cwd);
    return { sessionId: request.sessionId, methods: { followup: true, steer: process.env.FAKE_DSH_NO_STEER !== '1', cancel: true }, inboxMethods: { remove: true } };
  },
  peek(request) {
    const file = path.join(sessions, request.sessionId);
    if (!existsSync(file)) throw Object.assign(new Error(`no session ${request.sessionId}`), { name: 'SessionPersistenceNotFoundError' });
    return { header: { cwd: readFileSync(file, 'utf8') }, route: { provider: 'saved', model: 'route' } };
  },
  resume(request) {
    route = `${request.agentOptions.provider}/${request.agentOptions.model}`;
    return { sessionId: request.sessionId, methods: { followup: true, steer: true, cancel: true }, inboxMethods: { remove: true } };
  },
  prompt(request) {
    setImmediate(() => prompt(request.sessionId, request.text));
    return { messageId: 'message-1' };
  },
  steer(request) {
    if (hanging === undefined) throw Object.assign(new Error('no active turn'), { code: 'no_active_turn' });
    return { messageId: `steer-${request.text}` };
  },
  cancel() {
    if (hanging === undefined) throw Object.assign(new Error('no active turn'), { code: 'no_active_turn' });
    setImmediate(() => { event(hanging, 'turn/end', { reason: { kind: 'aborted' } }); hanging = undefined; });
    return {};
  },
  dispose() { return {}; },
};

write({ type: 'ready', protocol: 1, services: {} });
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, ...request } = JSON.parse(line);
  log({ kind: 'request', method, request });
  try { write({ type: 'response', id, result: commands[method](request) }); }
  catch (error) { write({ type: 'response', id, error: { name: error.name, message: error.message }, code: error.code }); }
});
