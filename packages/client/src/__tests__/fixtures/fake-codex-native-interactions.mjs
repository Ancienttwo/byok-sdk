#!/usr/bin/env node
// Synthetic Codex 0.160.0 stdio only. No provider, credentials, MCP or command execution.
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.160.0'); process.exit(0); }
if (args[0] === 'login') { console.log('Not logged in'); process.exit(1); }
if (args.includes('--help')) { console.log('app-server --listen stdio://'); process.exit(0); }
const send = frame => console.log(JSON.stringify(frame));
const notify = (method, params) => send({ method, params });
const scenario = process.env.FAKE_NATIVE_SCENARIO ?? 'approval';
let session = 'native-thread'; let turn; let sequence = 0; const pending = new Map();
const key = id => JSON.stringify([typeof id, id]);
const complete = (status = 'completed') => { if (!turn) return; const id = turn; turn = undefined; notify('turn/completed', { threadId: session, turn: { id, status } }); };
function request(id, method, params) { pending.set(key(id), id); send({ id, method, params }); }
function run() {
  notify('turn/started', { threadId: session, turn: { id: turn } });
  const base = { threadId: session, turnId: turn, itemId: 'item-1' };
  const approval = { ...base, kind: 'command', startedAtMs: 1, environmentId: null, command: 'echo fixture', cwd: process.cwd() };
  if (scenario === 'question') request('question-'+sequence, 'item/tool/requestUserInput', { ...base, isBlocking: true, autoResolutionMs: null, questions: [
    { id: 'color', header: 'Color', question: 'Pick a color', isOther: false, isSecret: false, options: [{ label: 'Blue', description: 'Blue option' }, { label: 'Red', description: 'Red option' }] },
    { id: 'note', header: 'Note', question: 'Any details?', isOther: true, isSecret: false, options: null },
  ] });
  else if (scenario === 'numeric-string') { request(7, 'item/commandExecution/requestApproval', approval); request('7', 'item/fileChange/requestApproval', { ...base, startedAtMs: 1, reason: 'fixture change' }); }
  else if (scenario === 'unknown') request('unknown', 'item/tool/call', base);
  else if (scenario === 'malformed') request('malformed', 'item/commandExecution/requestApproval', { ...approval, threadId: 'other-thread' });
  else request('approval-'+sequence, 'item/commandExecution/requestApproval', approval);
  if (scenario === 'cancel') setTimeout(() => { const id = [...pending.values()][0]; pending.clear(); notify('serverRequest/resolved', { threadId: session, requestId: id }); complete(); }, 10);
  if (scenario === 'exit') setTimeout(() => process.exit(1), 10);
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (process.env.FAKE_NATIVE_RECEIPT) appendFileSync(process.env.FAKE_NATIVE_RECEIPT, JSON.stringify(frame)+'\n');
  if (!frame.method) {
    if (!pending.delete(key(frame.id))) { console.error('duplicate or unknown native response'); process.exit(2); }
    notify('serverRequest/resolved', { threadId: session, requestId: frame.id });
    if (!pending.size) complete();
    return;
  }
  const p = frame.params ?? {};
  if (frame.method === 'initialize') send({ id: frame.id, result: {} });
  else if (frame.method === 'thread/start' || frame.method === 'thread/resume') {
    session = scenario === 'wrong-resume' ? 'wrong-thread' : p.threadId ?? session;
    send({ id: frame.id, result: { thread: { id: session }, model: p.model ?? 'fixture-model', reasoningEffort: null, approvalPolicy: scenario === 'bad-policy' ? 'never' : p.approvalPolicy } });
    if (scenario === 'wrong-resume') { turn = 'wrong-turn'; run(); }
  } else if (frame.method === 'turn/start') {
    if (scenario === 'refused-followup' && sequence > 0) {
      send({ id: frame.id, error: { code: -32000, message: 'fixture prompt refused' } });
      setTimeout(() => { turn = 'unsolicited-turn'; run(); }, 0); return;
    }
    turn = 'turn-'+(++sequence); send({ id: frame.id, result: { turn: { id: turn } } }); setTimeout(run, 0);
  } else if (frame.method === 'turn/interrupt') { send({ id: frame.id, result: {} }); pending.clear(); complete('interrupted'); }
  else if (frame.method === 'turn/steer') { console.error('native responses must not steer'); process.exit(2); }
  else if (frame.id !== undefined) send({ id: frame.id, result: {} });
});
