#!/usr/bin/env node
// A scripted stand-in for the SDK's prepared host, substituted at the adapter's
// own `spawnFn` seam.
//
// It exists for the 0.86 response-timing change and nothing else. On that line
// the single `prompt_prepared` response is written at the byte-gate verdict, so
// a run that reaches the gate has ALREADY emitted the session events for the
// leading system and user messages — six frames that now precede the response
// the SDK adapter is still awaiting. This script writes exactly that ordering,
// plus one frame the adapter actually maps to an `AgentEvent`, so a test can
// prove nothing queued before the response is lost, reordered or delivered
// twice once `PiSession` starts reading.
//
// `BYOK_PREPARED_TIMING_REFUSE` makes it answer the same command with a typed
// refusal instead, which is how the new `prepared_body_drift` code's
// pass-through is observed without forging the fork's own envelope digest.

const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

/**
 * The six frames a 0.86 prepared run has already emitted by the time its byte
 * gate returns a verdict, in the order the fork's own test pins them.
 */
const PRE_RESPONSE_EVENTS = [
  { type: 'agent_start' },
  { type: 'turn_start' },
  { type: 'message_start', role: 'system' },
  { type: 'message_end', role: 'system' },
  { type: 'message_start', role: 'user' },
  { type: 'message_end', role: 'user' },
];

/** One frame the adapter maps, so "delivered" is observable and not merely "queued". */
const MAPPED_PRE_RESPONSE_EVENT = {
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: 'queued before the response' },
};

const refuse = process.env.BYOK_PREPARED_TIMING_REFUSE === '1';
const sessionId = 'prepared-timing-session';

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\n');
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      continue;
    }
    if (command.type === 'prompt_prepared') {
      if (refuse) {
        // Admission or byte-gate refusals carry the fork's own code. Nothing
        // here maps it; the point is that the SDK reports it verbatim.
        write({
          type: 'response',
          success: false,
          id: command.id,
          code: 'prepared_body_drift',
          error: 'the live request differs from the prepared body',
        });
        continue;
      }
      for (const event of PRE_RESPONSE_EVENTS) write(event);
      write(MAPPED_PRE_RESPONSE_EVENT);
      write({
        type: 'response',
        success: true,
        id: command.id,
        data: { sessionId, preparedDigest: command.expected?.digest },
      });
      continue;
    }
    if (command.type === 'get_state') {
      write({ type: 'response', success: true, id: command.id, data: { sessionId } });
      continue;
    }
    write({ type: 'response', success: true, id: command.id, data: {} });
  }
});
