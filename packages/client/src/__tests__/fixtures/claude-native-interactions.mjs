#!/usr/bin/env node
// Offline Claude control-protocol fixture. It performs no provider/tool calls.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.0-native-fixture'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const scenario = process.env.CLAUDE_NATIVE_SCENARIO ?? 'approval';
const transcript = process.env.CLAUDE_NATIVE_TRANSCRIPT;
const enabled = args.includes('--permission-prompt-tool') && args[args.indexOf('--permission-prompt-tool') + 1] === 'stdio';
const resumeIndex = args.indexOf('--resume');
const sessionId = scenario === 'wrong-resume' ? 'wrong-resumed-session' : resumeIndex < 0 ? 'claude-native-session' : args[resumeIndex + 1];
const log = frame => { if (transcript) appendFileSync(transcript, `${JSON.stringify(frame)}\n`); };
const emit = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
const result = () => emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 1 } });
let initialized = false;
let turn = 0;
log({ argv: args });

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const frame = JSON.parse(line);
  log(frame);
  if (frame.type === 'control_request') {
    if (frame.request.subtype === 'initialize') {
      if (!enabled || frame.request.hooks !== null) process.exit(12);
      initialized = true;
      if (scenario === 'init-exit') process.exit(13);
      emit({ type: 'control_response', response: { subtype: scenario === 'init-error' ? 'error' : 'success', request_id: frame.request_id, response: {} } });
      return;
    }
    if (frame.request.subtype === 'interrupt') {
      emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
      result();
      return;
    }
    process.exit(14);
  }
  if (frame.type === 'control_response') { result(); return; }
  if (frame.type !== 'user' || (enabled && !initialized)) process.exit(15);
  turn += 1;
  emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fixture-model' });
  if (!enabled) { result(); return; }
  const requestId = turn === 1 ? 'native-request-1' : `native-request-${turn}`;
  const questions = [
    { question: 'Which framework?', header: 'Framework', options: [{ label: 'React', description: 'Component UI' }, { label: 'Vue', description: 'Reactive UI' }], multiSelect: false },
    { question: 'Which checks?', header: 'Checks', options: [{ label: 'Unit', description: 'Fast checks' }, { label: 'Integration', description: 'Full flow' }], multiSelect: true },
    { question: '__proto__', header: 'Free text', options: [{ label: 'Default', description: 'Use default' }], multiSelect: false },
  ];
  if (scenario === 'duplicate-question') questions[1].question = questions[0].question;
  if (scenario === 'duplicate-option') questions[0].options[1].label = questions[0].options[0].label;
  const isQuestion = ['questions', 'duplicate-question', 'duplicate-option'].includes(scenario);
  const request = {
    type: 'control_request', request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: isQuestion ? 'AskUserQuestion' : 'Bash', input: isQuestion ? { questions } : { command: 'echo offline-fixture', nested: { exact: true } }, tool_use_id: `tool-use-${turn}`, title: 'Run the offline fixture command?' },
  };
  if (scenario === 'unknown') request.request.subtype = 'unimplemented_request';
  if (scenario === 'missing-id') delete request.request_id;
  emit(request);
  if (scenario === 'duplicate-id') emit(request);
  if (scenario === 'provider-cancel') {
    emit({ type: 'control_cancel_request', request_id: requestId });
    result();
  }
  if (scenario === 'turn-end') result();
  if (scenario === 'process-exit') setTimeout(() => process.exit(16), 30);
});
