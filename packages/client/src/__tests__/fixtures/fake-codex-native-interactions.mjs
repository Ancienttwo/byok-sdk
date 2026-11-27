#!/usr/bin/env node
// Synthetic Codex stdio only. No provider, credentials, MCP or command execution.
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli ' + (process.env.FAKE_NATIVE_VERSION ?? '0.169.0')); process.exit(0); }
if (args[0] === 'login') { console.log('Not logged in'); process.exit(1); }
if (args.includes('--help')) { console.log('app-server --listen stdio://'); process.exit(0); }
if (process.env.FAKE_NATIVE_ARGV) appendFileSync(process.env.FAKE_NATIVE_ARGV, `${JSON.stringify(args)}\n`);
const send = frame => console.log(JSON.stringify(frame));
const notify = (method, params) => send({ method, params });
const scenario = process.env.FAKE_NATIVE_SCENARIO ?? 'question';
const secretScenario = scenario.startsWith('secret-');
let session = 'native-thread'; let turn; let sequence = 0; const pending = new Map();
let firstSecretAnswers;
const key = id => JSON.stringify([typeof id, id]);
const complete = (status = 'completed') => { if (!turn) return; const id = turn; turn = undefined; notify('turn/completed', { threadId: session, turn: { id, status } }); };
function request(id, method, params) { pending.set(key(id), id); send({ id, method, params }); }
function run() {
  notify('turn/started', { threadId: session, turn: { id: turn } });
  const base = { threadId: session, turnId: turn, itemId: 'item-1' };
  const approval = { ...base, kind: 'command', startedAtMs: 1, environmentId: null, command: 'echo fixture', cwd: process.cwd() };
  const question = { ...base, isBlocking: true, autoResolutionMs: null, questions: [
    { id: 'color', header: 'Color', question: 'Pick a color', isOther: false, isSecret: false, options: [{ label: 'Blue', description: 'Blue option' }, { label: 'Red', description: 'Red option' }] },
    { id: 'note', header: 'Note', question: 'Any details?', isOther: true, isSecret: false, options: null },
  ] };
  // Default mode only sends native questions with the opt-in flag. Approval is independent.
  if (scenario !== 'approval' && !args.includes('features.default_mode_request_user_input=true')) { complete(); return; }
  if (secretScenario) question.questions.push(
    { id: 'pin', header: 'PIN', question: 'Enter your PIN', isOther: true, isSecret: true, options: null },
    { id: 'token', header: 'Token', question: 'Enter your token', isOther: true, isSecret: true, options: null },
    { id: 'choice', header: 'Choice', question: 'Pick a label', isOther: false, isSecret: true, options: [{ label: 'Shared-option-123', description: 'A selectable label' }] },
  );
  // Only `approval` sends a native permission request; the SDK must refuse it.
  if (scenario === 'approval') request('approval-'+sequence, 'item/commandExecution/requestApproval', approval);
  else if (scenario === 'numeric-string') { request(7, 'item/tool/requestUserInput', question); request('7', 'item/tool/requestUserInput', { ...question, itemId: 'item-2' }); }
  else if (scenario === 'unknown') request('unknown', 'item/tool/call', base);
  else if (scenario === 'malformed') request('malformed', 'item/tool/requestUserInput', { ...question, threadId: 'other-thread' });
  else request('question-'+sequence, 'item/tool/requestUserInput', question);
  if (scenario === 'cancel') setTimeout(() => { const id = [...pending.values()][0]; pending.clear(); notify('serverRequest/resolved', { threadId: session, requestId: id }); }, 10);
  if (scenario === 'exit') setTimeout(() => process.exit(1), 10);
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (process.env.FAKE_NATIVE_RECEIPT) appendFileSync(process.env.FAKE_NATIVE_RECEIPT, JSON.stringify(frame)+'\n');
  if (!frame.method) {
    if (!pending.delete(key(frame.id))) { console.error('duplicate or unknown native response'); process.exit(2); }
    if (secretScenario && frame.result) {
      const echo = (call_id, output) => notify('rawResponseItem/completed', {
        threadId: session, turnId: turn, item: { type: 'function_call_output', call_id, output },
      });
      if (scenario === 'secret-reused-item' && firstSecretAnswers === undefined) {
        firstSecretAnswers = frame.result.answers;
        request('second-question', 'item/tool/requestUserInput', { threadId: session, turnId: turn, itemId: 'item-1', questions: [
          { id: 'backup', header: '', question: 'Enter your backup PIN', isOther: true, isSecret: true, options: null },
        ] });
      } else {
        echo('another-item', 'ordinary output');
        const answers = firstSecretAnswers ?? frame.result.answers;
        const json = JSON.stringify({ answers: { ...answers, pin: { answers: [`user_note: ${answers.pin.answers[0]}`] } } });
        const output = {
          'secret-json': json,
          'secret-parts': [{ type: 'input_text', text: json }],
          'secret-malformed': json.slice(0, -1),
          'secret-nontext': [{ type: 'input_image', url: answers.pin.answers[0] }],
          'secret-wrong-shape': JSON.stringify({ answers: { pin: answers.pin.answers[0] } }),
          'secret-mismatched-id': JSON.stringify({ answers: { unexpected: answers.pin } }),
          'secret-reused-item': json,
        }[scenario];
        echo('item-1', output);
        if (firstSecretAnswers !== undefined) echo('item-1', JSON.stringify(frame.result));
        notify('item/completed', { threadId: session, turnId: turn, item: {
          type: 'agentMessage', id: 'later', text: `Later ${answers.token.answers[0]} and ${answers.choice.answers[0]}`,
        } });
      }
    }
    notify('serverRequest/resolved', { threadId: session, requestId: frame.id });
    if (!pending.size) complete();
    return;
  }
  const p = frame.params ?? {};
  if (frame.method === 'initialize') send({ id: frame.id, result: {} });
  else if (frame.method === 'thread/start' || frame.method === 'thread/resume') {
    session = scenario === 'wrong-resume' ? 'wrong-thread' : p.threadId ?? session;
    send({ id: frame.id, result: { thread: { id: session }, model: p.model ?? 'fixture-model', reasoningEffort: null, approvalPolicy: p.approvalPolicy } });
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
