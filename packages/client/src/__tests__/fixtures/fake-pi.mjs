#!/usr/bin/env node
// Fake `pi --mode rpc`: replays a representative, empirically grounded frame
// sequence (pi's bundled docs/rpc.md, cross-checked against live probes of
// @earendil-works/pi-coding-agent 0.74.2 and 0.80.7 against real GLM/z.ai
// traffic) without spawning a real LLM call. Substituted for the real pi
// binary via PiAdapterOptions.resolveBin/spawnFn in tests.
//
// Argv validation (2026-07-16 hardening): real pi rejects any flag it
// doesn't recognize with `Error: Unknown option: --xxx` on stderr and exit
// code 1 — confirmed live against the installed 0.74.2 binary, both for a
// typo'd flag and, tellingly, for two flags THIS adapter used to pass
// unconditionally (`--session-id`, and `--exclude-tools` for a non-empty
// `denyTools`) that simply don't exist on the real CLI. Neither bug was
// ever caught by this repo's own test suite because this fixture never
// looked at argv beyond `--version`. ALLOWED_FLAGS below is deliberately
// scoped to exactly what packages/client/src/adapters/pi/*.ts can ever
// construct (not pi's full flag surface) — anything else fails exactly like
// real pi would, so a future flag regression fails a test instead of
// silently passing.
//
// Env toggles:
//   FAKE_PI_NO_KEY=1              -> `prompt` responds success:false, mirroring
//                                    pi's real "No API key found..." rejection.
//   FAKE_PI_VERSION=<text>        -> overrides the `--version` output.
//   FAKE_PI_SESSION_ID=<id>       -> this run's "real" pi session id, reported
//                                    via get_state.data.sessionId (default
//                                    'fake-session-1'). A `--session <id>`
//                                    arg is validated against this exactly
//                                    like real pi validates a resume target
//                                    against its own session store: a
//                                    mismatch exits 1 with pi's real
//                                    "No session found matching '<id>'"
//                                    message (empirically confirmed).
//   FAKE_PI_CRASH_WITH_STDERR=<msg> -> write <msg> to stderr and exit 1
//                                    immediately, before reading any stdin —
//                                    simulates finding #1's "bad flag ->
//                                    instant exit" shape for testing
//                                    rpc-client.ts's stderr-ring-buffer
//                                    surfacing, independent of any specific
//                                    argv-validation failure.
//   FAKE_PI_EXTENSION_UI_REQUEST=<method> -> before the final assistant
//                                    text, emit an `extension_ui_request`
//                                    with this `method` (e.g. "confirm") and
//                                    BLOCK (exactly like real pi per its own
//                                    docs/rpc.md) until a matching
//                                    `extension_ui_response` arrives on
//                                    stdin. The final assistant text then
//                                    echoes the received response
//                                    (`ui-response:<json>`) so a test can
//                                    assert rpc-client.ts answered it
//                                    correctly without a separate
//                                    side-channel.
//   FAKE_PI_ARTIFACT_NAME=<path>  -> before the normal reply, write a file of
//                                    FAKE_PI_ARTIFACT_SIZE bytes (default
//                                    70000, i.e. >64KB) at this path (relative
//                                    to cwd == the task workspace dir) and
//                                    emit an `artifact` RPC message naming it.
//                                    `events.ts` maps `artifact` 1:1 to a
//                                    byok `AgentEvent` (M1-4 blob-path e2e —
//                                    real pi has no native equivalent; see the
//                                    doc comment on that mapping case).
//   FAKE_PI_ARTIFACT_SIZE=<bytes>        -> overrides the artifact file size.
//   FAKE_PI_ARTIFACT_CONTENT_TYPE=<mime> -> overrides the reported contentType
//                                           (default application/octet-stream).
//   FAKE_PI_HANG_AFTER_TOOL=1     -> after the bash tool_use/tool_result (and
//                                    the artifact block, if any), stop —
//                                    never send turn_end/agent_end on its
//                                    own. Without this, the whole canned
//                                    sequence sends synchronously fast enough
//                                    that a task.cancel racing it can lose
//                                    every time (the task reaches Complete
//                                    before the cancel arrives). Leaves the
//                                    task genuinely `Running` so an M1-4 e2e
//                                    cancel test has something real to cancel;
//                                    the daemon's own `handleCancel` doesn't
//                                    wait on this process's events at all —
//                                    it reports task.cancelled and kills this
//                                    process directly (SIGTERM), so no reply
//                                    to `abort` is required for the cancel
//                                    path to complete correctly.

import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  process.stdout.write(`${process.env.FAKE_PI_VERSION ?? '0.0.0-fake'}\n`);
  process.exit(0);
}

if (process.env.FAKE_PI_CRASH_WITH_STDERR) {
  process.stderr.write(`${process.env.FAKE_PI_CRASH_WITH_STDERR}\n`);
  process.exit(1);
}

// Exactly the flags packages/client/src/adapters/pi/*.ts can ever construct
// today — see the module doc comment above for why this is intentionally
// narrow rather than mirroring pi's entire `--help` surface.
const FLAG_TAKES_VALUE = {
  '--mode': true,
  '--session': true,
  '--tools': true,
  '--no-tools': false,
};

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith('--')) continue;
  if (!(arg in FLAG_TAKES_VALUE)) {
    process.stderr.write(`Error: Unknown option: ${arg}\n`);
    process.exit(1);
  }
  if (FLAG_TAKES_VALUE[arg]) i += 1; // skip this flag's value token
}

const sessionId = process.env.FAKE_PI_SESSION_ID ?? 'fake-session-1';

const sessionIdx = argv.indexOf('--session');
if (sessionIdx !== -1) {
  const requested = argv[sessionIdx + 1];
  if (requested !== sessionId) {
    // Verbatim format, empirically confirmed against real pi 0.74.2 given
    // an unknown/unminted session id in a fresh cwd.
    process.stderr.write(`No session found matching '${requested}'\n`);
    process.exit(1);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/** id -> resolve function, for extension_ui_request/response correlation (see FAKE_PI_EXTENSION_UI_REQUEST above). */
const pendingExtensionUiResolvers = new Map();

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command' });
    return;
  }

  if (msg.type === 'extension_ui_response') {
    const resolver = pendingExtensionUiResolvers.get(msg.id);
    if (resolver) {
      pendingExtensionUiResolvers.delete(msg.id);
      resolver(msg);
    }
    return;
  }

  handleCommand(msg);
});

async function handleCommand(msg) {
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
      // assistant text reply, then the real settle event.
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
      const artifactName = process.env.FAKE_PI_ARTIFACT_NAME;
      if (artifactName) {
        const size = Number(process.env.FAKE_PI_ARTIFACT_SIZE ?? 70000);
        const contentType = process.env.FAKE_PI_ARTIFACT_CONTENT_TYPE ?? 'application/octet-stream';
        writeFileSync(artifactName, Buffer.alloc(size, 'A'));
        send({
          type: 'tool_execution_start',
          toolCallId: 'call_artifact',
          toolName: 'write',
          args: { path: artifactName, content: `<${size} bytes written by fake-pi>` },
        });
        send({
          type: 'tool_execution_end',
          toolCallId: 'call_artifact',
          toolName: 'write',
          result: { content: [{ type: 'text', text: `Successfully wrote ${size} bytes to ${artifactName}` }] },
          isError: false,
        });
        send({ type: 'artifact', name: artifactName, contentType });
      }
      if (process.env.FAKE_PI_HANG_AFTER_TOOL === '1') {
        break; // stay Running indefinitely — see FAKE_PI_HANG_AFTER_TOOL above
      }

      let finalTextPart1 = 'Hello ';
      let finalTextPart2 = 'world';
      const extUiMethod = process.env.FAKE_PI_EXTENSION_UI_REQUEST;
      if (extUiMethod) {
        const requestId = 'ext-ui-1';
        const responsePromise = new Promise((resolve) => pendingExtensionUiResolvers.set(requestId, resolve));
        send({
          type: 'extension_ui_request',
          id: requestId,
          method: extUiMethod,
          title: 'Fake extension dialog',
          ...(extUiMethod === 'confirm' ? { message: 'Proceed?' } : {}),
          ...(extUiMethod === 'select' ? { options: ['Allow', 'Block'] } : {}),
        });
        // Blocks exactly like real pi would per docs/rpc.md's "Extension UI
        // Protocol" — proves the adapter answers this instead of hanging.
        const uiResponse = await responsePromise;
        finalTextPart1 = `ui-response:${JSON.stringify(uiResponse)}`;
        finalTextPart2 = '';
      }

      send({ type: 'message_start', message: { role: 'assistant' } });
      send({
        type: 'message_update',
        message: {},
        assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
      });
      send({
        type: 'message_update',
        message: {},
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: finalTextPart1 },
      });
      if (finalTextPart2) {
        send({
          type: 'message_update',
          message: {},
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: finalTextPart2 },
        });
      }
      send({
        type: 'message_update',
        message: {},
        assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: finalTextPart1 + finalTextPart2 },
      });
      send({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: finalTextPart1 + finalTextPart2 }] },
      });
      send({ type: 'turn_end', message: {}, toolResults: [] });
      send({ type: 'agent_end', messages: [] });
      break;
    }

    case 'steer':
      send({ type: 'response', command: 'steer', success: true, id: msg.id });
      break;

    case 'abort':
      send({ type: 'response', command: 'abort', success: true, id: msg.id });
      send({ type: 'agent_end', messages: [] });
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
}
