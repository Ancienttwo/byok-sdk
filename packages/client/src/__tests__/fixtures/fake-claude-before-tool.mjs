#!/usr/bin/env node
// Synthetic SDK control-protocol fixture, not evidence of native Claude coverage.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
if (process.argv.includes('--version')) { process.stdout.write('2.1.302\n'); process.exit(0); }
if (!process.argv.includes('--dangerously-skip-permissions')) throw new Error('fixture requires unchanged bypass mode');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const pending = new Map();
let hooks;
let turn = 0;
const sessionId = 'claude-before-tool-fixture';
const lines = createInterface({ input: process.stdin });
lines.on('line', line => { void handle(JSON.parse(line)); });
async function handle(frame) {
  if (frame.type === 'control_response') { pending.get(frame.response.request_id)?.(frame.response.response); return; }
  if (frame.type === 'control_request' && frame.request.subtype === 'initialize') {
    hooks = frame.request.hooks;
    const mode = process.env.FAKE_HOOK_REGISTRATION;
    emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
      response: mode === 'missing' ? {} : { hooks_applied: mode !== 'false' } } });
    return;
  }
  if (frame.type !== 'user') return;
  turn++;
  emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-test' });
  const toolId = `write-${turn}`;
  const filePath = path.join(process.cwd(), `tool-${turn}.txt`);
  const input = { file_path: filePath, content: 'actual fixture write' };
  emit({ type: 'assistant', session_id: sessionId, message: { id: `message-${turn}`, role: 'assistant', model: 'claude-test', content: [{ type: 'tool_use', id: toolId, name: 'Write', input }] } });
  let decision;
  const callbackId = hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0];
  if (callbackId) {
    const requestId = `hook-${turn}`;
    const response = new Promise(resolve => pending.set(requestId, resolve));
    emit({ type: 'control_request', request_id: requestId, request: { subtype: 'hook_callback', callback_id: callbackId,
      input: { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: toolId, tool_input: input,
        cwd: process.cwd(), session_id: sessionId, ...(process.env.FAKE_HOOK_NATIVE_AGENT_ID ? { agent_id: process.env.FAKE_HOOK_NATIVE_AGENT_ID } : {}) } } });
    decision = (await response)?.hookSpecificOutput;
    pending.delete(requestId);
  }
  const denied = decision?.permissionDecision === 'deny';
  if (!denied) writeFileSync(filePath, input.content);
  emit({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId,
    content: denied ? decision.permissionDecisionReason : 'written', is_error: denied }] } });
  emit({ type: 'assistant', session_id: sessionId, message: { id: `final-${turn}`, role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: denied ? 'Blocked; finished.' : 'Written; finished.' }] } });
  emit({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, result: 'finished', usage: {} });
}
