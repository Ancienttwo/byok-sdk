#!/usr/bin/env node
// Fake `pi --mode rpc`: replays a representative, empirically grounded frame
// sequence (pi's bundled docs/rpc.md, cross-checked against live probes of
// @earendil-works/pi-coding-agent 0.74.2 and 0.80.7 with no API key
// configured) without spawning a real LLM call. Substituted for the real pi
// binary via PiAdapterOptions.resolveBin/spawnFn in tests.
//
// Env toggles:
//   FAKE_PI_NO_KEY=1        -> `prompt` responds success:false, mirroring
//                              pi's real "No API key found..." rejection.
//   FAKE_PI_VERSION=<text>  -> overrides the `--version` output.

import { createInterface } from 'node:readline';

if (process.argv.includes('--version')) {
  process.stdout.write(`${process.env.FAKE_PI_VERSION ?? '0.0.0-fake'}\n`);
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const sessionId = process.env.FAKE_PI_SESSION_ID ?? 'fake-session-1';

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command' });
    return;
  }

  switch (msg.type) {
    case 'get_state':
      send({
        type: 'response',
        command: 'get_state',
        success: true,
        id: msg.id,
        data: { model: { id: 'fake-model' }, thinkingLevel: 'off', isStreaming: false, sessionId },
      });
      break;

    case 'prompt': {
      if (process.env.FAKE_PI_NO_KEY === '1') {
        send({
          type: 'response',
          command: 'prompt',
          success: false,
          id: msg.id,
          error: 'No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key.',
        });
        break;
      }
      send({ type: 'response', command: 'prompt', success: true, id: msg.id });
      // Representative event sequence (shapes verbatim from pi's docs/rpc.md
      // and this task's live probes): a bash tool call, then a streamed
      // assistant text reply, then session settling.
      send({ type: 'agent_start' });
      send({ type: 'turn_start' });
      send({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: { command: 'echo hi' },
      });
      send({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'hi\n' }] },
        isError: false,
      });
      send({ type: 'message_start', message: { role: 'assistant' } });
      send({
        type: 'message_update',
        message: {},
        assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
      });
      send({
        type: 'message_update',
        message: {},
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello ' },
      });
      send({
        type: 'message_update',
        message: {},
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'world' },
      });
      send({
        type: 'message_update',
        message: {},
        assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hello world' },
      });
      send({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
      });
      send({ type: 'turn_end', message: {}, toolResults: [] });
      send({ type: 'agent_end', messages: [], willRetry: false });
      send({ type: 'agent_settled' });
      break;
    }

    case 'steer':
      send({ type: 'response', command: 'steer', success: true, id: msg.id });
      break;

    case 'abort':
      send({ type: 'response', command: 'abort', success: true, id: msg.id });
      send({ type: 'agent_end', messages: [], willRetry: false });
      send({ type: 'agent_settled' });
      break;

    case 'bash':
      send({
        type: 'response',
        command: 'bash',
        success: true,
        id: msg.id,
        data: { output: 'fake output\n', exitCode: 0, cancelled: false, truncated: false },
      });
      break;

    default:
      send({
        type: 'response',
        command: typeof msg.type === 'string' ? msg.type : 'unknown',
        success: false,
        id: msg.id,
        error: `Unknown command: ${msg.type}`,
      });
  }
});
