#!/usr/bin/env node
// Fake `codex`: replays representative, empirically grounded JSONL frame
// sequences (raw captures driven against the real installed `codex-cli
// 0.144.5` in a scratch directory while building the codex adapter) without
// spawning a real model call. Substituted for the real `codex` binary via
// `CodexAdapterOptions.resolveBin`/`spawnFn` in tests (and `BYOK_CODEX_BIN`
// for the CLI bin), exactly like `fake-pi.mjs` does for pi.
//
// Argv validation (hardened from day one, mirroring fake-pi.mjs's
// 2026-07-16 hardening — added there only *after* two real, ship-blocking
// nonexistent-flag bugs slipped past an unvalidated fixture): the real
// `codex exec` rejects any flag it doesn't recognize with `error: unexpected
// argument '--xxx' found` and exit code 2 — empirically confirmed live,
// including for `-a`/`--ask-for-approval` (documented in `codex exec
// --help` itself, yet rejected outright) and `-s`/`--sandbox` (works on a
// fresh `exec`, but rejected outright on `exec resume`). The accepted flag
// set below is deliberately scoped to exactly what
// packages/client/src/adapters/codex/*.ts can ever construct (`--json`,
// `--skip-git-repo-check` — required unconditionally; real codex refuses to
// run at all outside a Git repository otherwise, confirmed live against this
// adapter's own e2e run in a plain scratch directory — and `-c key=value`,
// never `-s`/`-a`) — anything else fails exactly like real codex would, so a
// future flag regression fails a test instead of silently passing. `-c`
// values are additionally restricted to the two keys this
// adapter ever sets (`sandbox_mode`, `approval_policy`) — stricter than real
// codex, which silently accepts (and ignores) an unrecognized `-c` key with
// no error unless `--strict-config` is passed (empirically confirmed, and
// itself a documented finding — see permission-mapping.ts) — specifically
// so a typo'd config key in this adapter's own code fails a test loudly
// instead of silently no-op-ing the way it would against the real binary.
//
// Env toggles:
//   FAKE_CODEX_VERSION=<text>          -> overrides `--version` stdout.
//   FAKE_CODEX_LOGGED_IN=0             -> `login status` reports "Not logged
//                                        in" on stderr, exit 1, instead of
//                                        the default "Logged in using
//                                        ChatGPT" (stderr, exit 0 — codex's
//                                        real login status message is on
//                                        stderr, not stdout, confirmed live).
//   FAKE_CODEX_THREAD_ID=<id>          -> this run's "real" thread id,
//                                        reported via `thread.started`
//                                        (default 'fake-thread-1'). A
//                                        `resume <id>` positional is
//                                        validated against this exactly like
//                                        real codex validates a resume
//                                        target against its own rollout
//                                        store: a mismatch exits 1 with
//                                        codex's real "no rollout found for
//                                        thread id ..." message (empirically
//                                        confirmed).
//   FAKE_CODEX_NO_THREAD_STARTED=1     -> first line is `turn.started`
//                                        instead of `thread.started` —
//                                        simulates codex failing to yield an
//                                        authoritative thread id, which must
//                                        fail closed (never a fabricated
//                                        sessionRef), mirroring pi's finding
//                                        F8.
//   FAKE_CODEX_CRASH_WITH_STDERR=<msg> -> write <msg> to stderr and exit 1
//                                        immediately, no JSONL at all —
//                                        simulates a bad-flag/instant-exit
//                                        shape for testing
//                                        process-runner.ts's stderr-ring-
//                                        buffer surfacing.
//   FAKE_CODEX_TURN_FAILS=1            -> emit a top-level `error` +
//                                        `turn.failed` instead of
//                                        `turn.completed`, exit 1 — real
//                                        shape confirmed live via an
//                                        invalid-model-name run.
//   FAKE_CODEX_FAIL_MESSAGE=<text>     -> overrides the turn.failed message.
//   FAKE_CODEX_ARTIFACT_NAME=<relpath> -> before the final assistant
//                                        message, write a file at this path
//                                        (relative to cwd == the task
//                                        workspace dir) and emit a
//                                        `file_change` item naming it via
//                                        its ABSOLUTE path (matching real
//                                        codex, which never reports a
//                                        relative path — see events.ts's
//                                        `extractArtifactEvents`).
//   FAKE_CODEX_ARTIFACT_CONTENT=<text> -> overrides the written file content.
//   FAKE_CODEX_UNMAPPED_TYPE=1         -> emit one never-seen item type and
//                                        one never-seen top-level type
//                                        alongside the normal sequence, for
//                                        unmapped-frame accounting tests.
//   FAKE_CODEX_HANG=1                  -> after thread.started/turn.started,
//                                        stay running indefinitely (never
//                                        emit turn.completed/turn.failed) —
//                                        for interrupt()/close() tests. Node
//                                        default SIGTERM handling (no custom
//                                        listener here) matches the real
//                                        binary's own empirically-confirmed
//                                        SIGTERM-terminates-it behavior.

import { writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (argv[0] === '--version') {
  process.stdout.write(`${process.env.FAKE_CODEX_VERSION ?? 'codex-cli 0.0.0-fake'}\n`);
  process.exit(0);
}

if (argv[0] === 'login' && argv[1] === 'status') {
  if (process.env.FAKE_CODEX_LOGGED_IN === '0') {
    process.stderr.write('Not logged in\n');
    process.exit(1);
  }
  // Real codex prints this on STDERR, not stdout — confirmed live.
  process.stderr.write('Logged in using ChatGPT\n');
  process.exit(0);
}

if (argv[0] !== 'exec') {
  process.stderr.write(`fake-codex: unsupported invocation: ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

let rest = argv.slice(1);
let resumeThreadId;
if (rest[0] === 'resume') {
  resumeThreadId = rest[1];
  rest = rest.slice(2);
}

const ALLOWED_CONFIG_KEYS = new Set(['sandbox_mode', 'approval_policy']);
let prompt;
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (arg === '--json' || arg === '--skip-git-repo-check') continue;
  if (arg === '-c') {
    const value = rest[++i];
    const eq = typeof value === 'string' ? value.indexOf('=') : -1;
    const key = eq !== -1 ? value.slice(0, eq) : value;
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      process.stderr.write(`error: unknown configuration field \`${key}\` in -c/--config override\n`);
      process.exit(2);
    }
    continue;
  }
  if (arg.startsWith('-')) {
    process.stderr.write(`error: unexpected argument '${arg}' found\n`);
    process.exit(2);
  }
  prompt = arg; // the final bare positional is the prompt
}

if (typeof prompt !== 'string') {
  process.stderr.write('error: no prompt provided\n');
  process.exit(2);
}

const threadId = process.env.FAKE_CODEX_THREAD_ID ?? 'fake-thread-1';

if (resumeThreadId !== undefined && resumeThreadId !== threadId) {
  process.stderr.write(`Error: thread/resume: thread/resume failed: no rollout found for thread id ${resumeThreadId} (code -32600)\n`);
  process.exit(1);
}

if (process.env.FAKE_CODEX_CRASH_WITH_STDERR) {
  process.stderr.write(`${process.env.FAKE_CODEX_CRASH_WITH_STDERR}\n`);
  process.exit(1);
}

if (process.env.FAKE_CODEX_NO_THREAD_STARTED === '1') {
  send({ type: 'turn.started' });
  process.exit(1);
}

send({ type: 'thread.started', thread_id: threadId });
send({ type: 'turn.started' });

// Empirically, this benign informational notice (unrelated to task success)
// appeared as item_0 on EVERY real capture made while building this
// adapter — replayed here so tests exercise the real shape, not an
// idealized one. See events.ts's doc comment on why this is forwarded
// honestly rather than specially filtered.
send({
  type: 'item.completed',
  item: { id: 'item_0', type: 'error', message: 'Exceeded skills context budget of 2%. All skill descriptions were removed and 54 additional skills were not included in the model-visible skills list.' },
});

if (process.env.FAKE_CODEX_UNMAPPED_TYPE === '1') {
  send({ type: 'item.completed', item: { id: 'item_unknown', type: 'reasoning', text: 'thinking...' } });
  send({ type: 'some.unknown.toplevel.type', foo: 'bar' });
}

if (process.env.FAKE_CODEX_HANG === '1') {
  setInterval(() => {}, 60000); // keep the process alive until killed (SIGTERM) — see FAKE_CODEX_HANG above
} else if (process.env.FAKE_CODEX_TURN_FAILS === '1') {
  const message = process.env.FAKE_CODEX_FAIL_MESSAGE ?? 'fake turn failure';
  send({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'attempting...' } });
  send({ type: 'error', message });
  send({ type: 'turn.failed', error: { message } });
  process.exit(1);
} else {
  send({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Running the command now.' } });
  send({
    type: 'item.started',
    item: { id: 'item_2', type: 'command_execution', command: '/bin/sh -c "echo hi"', aggregated_output: '', exit_code: null, status: 'in_progress' },
  });
  send({
    type: 'item.completed',
    item: { id: 'item_2', type: 'command_execution', command: '/bin/sh -c "echo hi"', aggregated_output: 'hi\n', exit_code: 0, status: 'completed' },
  });

  const artifactName = process.env.FAKE_CODEX_ARTIFACT_NAME;
  if (artifactName) {
    const absPath = path.join(process.cwd(), artifactName);
    writeFileSync(absPath, process.env.FAKE_CODEX_ARTIFACT_CONTENT ?? 'fake codex artifact content\n');
    send({ type: 'item.started', item: { id: 'item_3', type: 'file_change', changes: [{ path: absPath, kind: 'add' }], status: 'in_progress' } });
    send({ type: 'item.completed', item: { id: 'item_3', type: 'file_change', changes: [{ path: absPath, kind: 'add' }], status: 'completed' } });
  }

  send({ type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: process.env.FAKE_CODEX_FINAL_TEXT ?? 'Done.' } });
  send({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 } });
}
