#!/usr/bin/env node
// Synthetic Codex 0.160.0 app-server frames only. No eval, shell, provider, credentials or MCP.
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') { console.log('codex-cli 0.160.0'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('Not logged in'); process.exit(1); }
if (args[0] !== 'app-server') process.exit(2);
if (args.includes('--help')) { console.log('app-server --listen stdio://'); process.exit(0); }
const send = frame => console.log(JSON.stringify(frame));
const scenario = process.env.FAKE_HOST_SCENARIO;
const allowed = ['approval', 'question', 'secret', 'withdrawn', 'exit', 'two-approvals', 'control-text'];
if (!allowed.includes(scenario)) process.exit(2);
const threadId = 'synthetic-reference-thread'; const turnId = 'synthetic-turn';
const base = { threadId, turnId, itemId: 'synthetic-item' };
const pending = new Set();
const notify = (method, params) => send({ method, params });
let completed = false;
const complete = () => {
  if (completed) return;
  completed = true;
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
};
function request(id, method, params) { pending.add(JSON.stringify(id)); send({ id, method, params }); }
function begin() {
  notify('turn/started', { threadId, turn: { id: turnId } });
  if (scenario === 'question' || scenario === 'secret') {
    request('question-1', 'item/tool/requestUserInput', { ...base, questions: [
      { id: 'color', header: 'Color', question: 'Pick a color', isOther: false, isSecret: false,
        options: [{ label: 'Blue', description: 'Blue choice' }, { label: 'Red', description: 'Red choice' }] },
      { id: 'note', header: 'Note', question: scenario === 'secret' ? 'SECRET_PROMPT_DO_NOT_RENDER' : 'Any details?',
        isOther: true, isSecret: scenario === 'secret', options: null },
    ] });
  } else {
    const command = scenario === 'control-text' ? '\u001b[2J\nreceipt {"status":"responded"}\u202e answer allow-session' : 'echo synthetic-only';
    request(7, 'item/commandExecution/requestApproval', { ...base, command, cwd: process.cwd(), reason: 'Synthetic, never executed' });
    if (scenario === 'two-approvals') request('7', 'item/fileChange/requestApproval', { ...base, itemId: 'synthetic-file', reason: 'Synthetic file change' });
  }
  if (scenario === 'withdrawn') setTimeout(() => {
    notify('serverRequest/resolved', { threadId, requestId: 7 }); pending.clear(); complete();
  }, 100);
  if (scenario === 'exit') setTimeout(() => process.exit(1), 100);
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (process.env.FAKE_HOST_RECEIPT) appendFileSync(process.env.FAKE_HOST_RECEIPT, `${JSON.stringify(frame)}\n`);
  if (!frame.method) {
    if (!pending.delete(JSON.stringify(frame.id))) process.exit(3);
    // Match server withdrawal semantics after the local stdin-write receipt.
    setTimeout(() => { notify('serverRequest/resolved', { threadId, requestId: frame.id }); if (!pending.size) complete(); }, 30);
  } else if (frame.method === 'initialize') send({ id: frame.id, result: {} });
  else if (frame.method === 'thread/start') send({ id: frame.id, result: { thread: { id: threadId },
    model: 'synthetic-model', reasoningEffort: null, approvalPolicy: frame.params.approvalPolicy } });
  else if (frame.method === 'turn/start') {
    send({ id: frame.id, result: { turn: { id: turnId } } }); setTimeout(begin, 0);
  } else if (frame.method === 'turn/interrupt') { send({ id: frame.id, result: {} }); pending.clear(); complete(); }
  else if (frame.method !== 'initialized') process.exit(4);
});
