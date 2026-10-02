#!/usr/bin/env node
// TaskRunner-only lifecycle fixture. Native protocol frames use the same
// contracts as fake-claude/fake-codex/fake-pi; no provider or credential calls.
// A filesystem gate holds native startup; the receipt proves a real 3-level
// process tree. Each interrupted turn sends its final usage AFTER the ACK.
import { existsSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawnProcessTreeDescendant } from './process-tree-receipt.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('codex-cli 0.159.2'); process.exit(0); }
if (argv.includes('--help')) { console.log('app-server --listen stdio://'); process.exit(0); }
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
if (argv[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
const runtime = argv.includes('app-server') ? 'codex' : argv.includes('--mode') ? 'pi' : 'claude';
const scenario = process.env.T1_SCENARIO ?? 'stream';
const trace = label => appendFileSync(process.env.T1_TRACE, `${label}\n`);
const timing = (event, detail) => {
  if (process.env.T1_TIMING_TRACE) appendFileSync(process.env.T1_TIMING_TRACE,
    `${JSON.stringify({ ns: process.hrtime.bigint().toString(), wallMs: Date.now(), event, detail })}\n`);
};
const send = frame => {
  const detail = { id: frame.id, method: frame.method, type: frame.type, command: frame.command,
    params: frame.params, usage: frame.usage };
  timing('frame.write', detail);
  return process.stdout.write(`${JSON.stringify(frame)}\n`, () => timing('frame.flushed', detail));
};
const notify = (method, params) => send({ method, params });
const sessionId = 't1-session';
const turnId = 't1-turn';
await spawnProcessTreeDescendant({ receiptFile: process.env.T1_TREE, rootPid: process.pid });
trace('spawn');
const gate = async () => {
  if (scenario !== 'startup') return;
  trace('startup');
  while (!existsSync(process.env.T1_GATE)) await new Promise(resolve => setTimeout(resolve, 5));
};

function usage(input = 123, output = 17) {
  if (runtime === 'codex') {
    notify('thread/tokenUsage/updated', { threadId: sessionId,
      tokenUsage: { last: { inputTokens: input, outputTokens: output, totalTokens: input + output,
        cachedInputTokens: 0, reasoningOutputTokens: 0 },
        total: { inputTokens: input, outputTokens: output, cachedInputTokens: 0, reasoningOutputTokens: 0 }, modelContextWindow: 10000 } });
  } else if (runtime === 'pi') {
    send({ type: 'message_end', message: { role: 'assistant', content: [],
      usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output }, stopReason: 'stop' } });
  }
}
function terminal(interrupted) {
  if (runtime === 'codex') {
    notify('turn/completed', { threadId: sessionId, turn: { id: turnId,
      status: interrupted ? 'interrupted' : 'completed' } });
  } else if (runtime === 'pi') {
    send({ type: 'agent_end', messages: [], willRetry: false });
    send({ type: 'agent_settled' });
  } else {
    send({ type: 'result', subtype: interrupted ? 'error_during_execution' : 'success',
      terminal_reason: interrupted ? (scenario === 'tool' ? 'aborted_tools' : 'aborted_streaming') : undefined, is_error: interrupted,
      session_id: sessionId, usage: { input_tokens: interrupted ? 456 : 123,
        output_tokens: interrupted ? 29 : 17, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      result: 'fixture result' });
  }
  trace('terminal');
}
async function interruptedResult() {
  if (scenario === 'ack-only') return;
  if (scenario === 'gated-result') {
    trace('result_waiting');
    timing('result.waiting');
    while (!existsSync(process.env.T1_RESULT_GATE)) await new Promise(resolve => setTimeout(resolve, 5));
    timing('result.released');
  }
  const settle = () => { usage(456, 29); terminal(true); };
  if (scenario === 'delayed-result') setTimeout(settle, 5);
  else settle();
}
function run() {
  if (runtime === 'codex') notify('turn/started', { threadId: sessionId, turn: { id: turnId } });
  if (runtime === 'pi') send({ type: 'agent_start' });
  usage();
  if (scenario === 'tool') {
    if (runtime === 'codex') notify('item/started', { threadId: sessionId, turnId,
      item: { id: 'tool-1', type: 'commandExecution', command: 'echo fixture', status: 'inProgress' } });
    else if (runtime === 'pi') send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'echo fixture' } });
    else send({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo fixture' } } ] } });
  } else {
    if (runtime === 'codex') notify('item/completed', { threadId: sessionId, turnId,
      item: { id: 'message-1', type: 'agentMessage', text: 'streaming' } });
    else if (runtime === 'pi') send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'streaming' } });
    else send({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'streaming' }] } });
  }
  trace(scenario === 'tool' ? 'tool' : 'stream');
  if (scenario === 'complete' || scenario === 'native-abort') terminal(scenario === 'native-abort');
  if (scenario === 'exit') {
    const timer = setInterval(() => { if (existsSync(process.env.T1_GATE)) { clearInterval(timer); process.exit(1); } }, 5);
  }
}
async function receive(msg) {
  if (msg.method === 'turn/interrupt' || msg.type === 'abort' || msg.request?.subtype === 'interrupt') timing('interrupt.receive', { id: msg.id });
  if (runtime === 'codex') {
    if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'task-runner-fixture' } });
    if (msg.method === 'thread/start') { await gate(); send({ id: msg.id, result: { thread: { id: sessionId }, model: 'fixture-model' } }); }
    if (msg.method === 'turn/start') { send({ id: msg.id, result: { turn: { id: turnId } } }); setTimeout(run, 5); }
    if (msg.method === 'turn/interrupt') {
      trace('interrupt');
      if (scenario === 'no-ack') return;
      send({ id: msg.id, result: {} });
      await interruptedResult();
    }
  } else if (runtime === 'pi') {
    const respond = data => send({ type: 'response', command: msg.type, id: msg.id, success: true, data });
    if (msg.type === 'get_state') { await gate(); respond({ sessionId, model: { id: 'fixture-model' }, isStreaming: false }); }
    if (msg.type === 'get_session_stats') respond({ contextUsage: { tokens: 123, contextWindow: 10000 } });
    if (msg.type === 'prompt') { respond(); run(); }
    if (msg.type === 'abort') {
      trace('interrupt');
      if (scenario === 'no-ack') return;
      respond(); await interruptedResult();
    }
  } else {
    if (msg.type === 'user') { await gate(); send({ type: 'system', subtype: 'init', session_id: sessionId, tools: ['Bash'] }); run(); }
    if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
      trace('interrupt');
      if (scenario === 'no-ack') return;
      send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } } });
      await interruptedResult();
    }
  }
}
createInterface({ input: process.stdin }).on('line', line => {
  void receive(JSON.parse(line)).catch(error => { console.error(error); process.exit(1); });
});
