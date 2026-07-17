#!/usr/bin/env node
// Fake `claude -p --input-format stream-json --output-format stream-json`:
// replays representative, empirically-grounded stream-json frame sequences
// (captured live against the real installed claude 2.1.212 binary during
// the M2-a task — see packages/client/src/adapters/claude/*.ts's own doc
// comments for the concrete raw shapes this mirrors) without spawning a
// real model call. Substituted for the real claude binary via
// ClaudeAdapterOptions.resolveBin/spawnFn in tests (see BYOK_CLAUDE_BIN in
// resolve-bin.ts for the out-of-process substitution seam).
//
// Argv validation (mirrors fake-pi.mjs's hardened style exactly, same
// motivating lesson: a nonexistent-flag regression must fail a test, not
// slip through because the fixture never looked at argv): real claude
// rejects an unrecognized flag with `error: unknown option '--xxx'` on
// stderr and exit code 1 (confirmed live against the installed binary).
// ALLOWED_FLAGS below is scoped to exactly what
// packages/client/src/adapters/claude/*.ts can ever construct — see
// claude-adapter.ts's own `start()` — not claude's full `--help` surface.
//
// Two SEPARATE real invocations this fixture also emulates (both used only
// by ClaudeAdapter.detect(), never by start()/Session — see
// claude-adapter.ts):
//   `claude --version`             -> stdout version string, exit 0.
//   `claude auth status --json`    -> stdout JSON `{loggedIn, ...}`, exit 0.
//
// Env toggles (the `-p` stream-json flow):
//   FAKE_CLAUDE_VERSION=<text>          -> overrides `--version` output.
//   FAKE_CLAUDE_AUTH_STATUS=<json>      -> overrides `auth status --json` output.
//   FAKE_CLAUDE_AUTH_STATUS_FAIL=1      -> `auth status --json` exits 1 with no stdout.
//   FAKE_CLAUDE_VERSION_HANG=1          -> `claude --version` never responds
//                                          at all (no stdout, no exit) —
//                                          cross-model review finding (Fix
//                                          4): proves claude-adapter.ts's
//                                          own DETECT_TIMEOUT_MS actually
//                                          bounds detect() instead of
//                                          hanging it forever.
//   FAKE_CLAUDE_AUTH_HANG=1             -> `claude auth status --json` never
//                                          responds at all — same Fix 4
//                                          rationale as FAKE_CLAUDE_VERSION_HANG.
//   FAKE_CLAUDE_SESSION_ID=<id>         -> this run's session id (default
//                                          'fake-claude-session-1'), reported
//                                          on every turn's `system/init` frame
//                                          exactly as real claude does
//                                          (confirmed: a NEW init frame per
//                                          turn on one persistent process,
//                                          same session_id each time).
//                                          A `--resume <id>` argument that
//                                          does not match this value fails
//                                          exactly like real claude's own
//                                          unresolvable-resume case (see
//                                          below).
//   FAKE_CLAUDE_REPORTED_SESSION_ID=<id> -> overrides ONLY the session_id
//                                          actually reported in system/init
//                                          (and every other frame's own
//                                          session_id field) this run, kept
//                                          independent of FAKE_CLAUDE_SESSION_ID
//                                          (which still gates the --resume
//                                          target validation below).
//                                          Simulates claude silently
//                                          resuming/reporting a DIFFERENT
//                                          session than the one actually
//                                          requested, for exercising
//                                          claude-adapter.ts's own resume-
//                                          identity fail-closed check.
//   FAKE_CLAUDE_CRASH_WITH_STDERR=<msg> -> write <msg> to stderr and exit 1
//                                          immediately, before reading any
//                                          stdin — simulates a bad-flag-class
//                                          instant-exit failure, independent
//                                          of the real argv validation below.
//   FAKE_CLAUDE_DENY=1                  -> the tool_use this turn gets
//                                          synthesized as an auto-DENIED
//                                          tool_result (is_error:true, the
//                                          real verbatim "Claude requested
//                                          permissions to write to ..."
//                                          message) instead of succeeding —
//                                          the run still completes normally
//                                          afterward (is_error:false on the
//                                          final `result`), exactly mirroring
//                                          claude's real headless
//                                          auto-deny-and-continue behavior
//                                          (never a hang, never a paused
//                                          `needs_approval`-style frame).
//   FAKE_CLAUDE_ARTIFACT_PATH=<path>    -> the tool_use this turn is a
//                                          `Write` to this path (resolved
//                                          against cwd if relative) instead
//                                          of the default `Bash` echo, and
//                                          the file is actually written to
//                                          disk with FAKE_CLAUDE_ARTIFACT_CONTENT
//                                          (default 'artifact-body'). Lets a
//                                          test exercise both an in-workspace
//                                          path (artifact AgentEvent
//                                          expected) and an outside-workspace
//                                          path (none expected — see
//                                          events.ts's `tryBuildArtifactEvent`).
//   FAKE_CLAUDE_ARTIFACT_CONTENT=<text> -> content written for the above.
//   FAKE_CLAUDE_HANG_AFTER_TOOL=1       -> after the tool_use/tool_result
//                                          pair, stop — never send the final
//                                          assistant text / `result` frame on
//                                          this turn. Leaves the process
//                                          genuinely running so an
//                                          interrupt()+close() test has
//                                          something real to interrupt (the
//                                          real daemon's cancel path doesn't
//                                          wait on drained events either —
//                                          see pi's identical fixture
//                                          toggle/reasoning).
//   FAKE_CLAUDE_UNKNOWN_TOP_LEVEL=1     -> before the normal turn, emit one
//                                          extra frame with a top-level
//                                          `type` this adapter has never
//                                          been told to expect.
//   FAKE_CLAUDE_UNKNOWN_SYSTEM_SUBTYPE=1-> emit one extra `system` frame
//                                          whose `subtype` is not in
//                                          `ROUTINE_CLAUDE_SYSTEM_SUBTYPES`.
//   FAKE_CLAUDE_UNKNOWN_ASSISTANT_BLOCK=1 -> the assistant's final message
//                                          includes one extra content block
//                                          of an unrecognized `type`.
//   FAKE_CLAUDE_RESULT_MALFORMED=1      -> cross-model re-review (P1
//                                          regression): the turn's `result`
//                                          frame is sent with `is_error`
//                                          OMITTED entirely (a malformed/
//                                          future wire shape) instead of the
//                                          normal `is_error:false`/`true` —
//                                          and, exactly like the real
//                                          binary's own confirmed persistent-
//                                          process behavior, this script
//                                          does NOT exit afterward (no
//                                          `process.exit()` here, same as
//                                          the normal success path below).
//                                          Proves the fix lives in the
//                                          per-turn event-stream layer
//                                          (claude-adapter.ts), not in
//                                          "wait for the process to exit" —
//                                          the process staying alive is the
//                                          whole point of this toggle.

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);

// Fix 4 (cross-model review, probe timeout): checked FIRST, before any other
// argv handling below, and deliberately never calls process.exit() — the
// whole point is to keep the process running so the CALLER's own timeout
// (claude-adapter.ts's DETECT_TIMEOUT_MS) is what has to end it, exactly
// like a real hung CLI would. The rest of this script lives inside
// runProbeOrTurnFlow() below, invoked only in the `else` branch, since a
// bare top-level `return` isn't valid outside a function (this is an ES
// module) — falling through into the flag validation further down would
// otherwise treat `--version`/`--json` as an unrecognized option and exit
// immediately, defeating the hang simulation.
const isVersionInvocation = argv.includes('--version');
const isAuthStatusInvocation = argv[0] === 'auth' && argv[1] === 'status';
if (
  (process.env.FAKE_CLAUDE_VERSION_HANG === '1' && isVersionInvocation) ||
  (process.env.FAKE_CLAUDE_AUTH_HANG === '1' && isAuthStatusInvocation)
) {
  setInterval(() => {}, 60000); // keep the process alive until killed (SIGTERM) — see FAKE_CLAUDE_VERSION_HANG/FAKE_CLAUDE_AUTH_HANG above
} else {
  runProbeOrTurnFlow();
}

function runProbeOrTurnFlow() {
  if (argv.length === 2 && argv[0] === 'auth' && argv[1] === 'status') {
    // real invocation is `auth status --json` (3 args) — guard against a
    // future accidental argv-shape drift the same way the strict validator
    // below guards the -p flow. Handled together with the --json variant
    // just below since both are read-only, no-stdin invocations.
    process.stderr.write("error: unknown option '--json' is missing\n");
    process.exit(1);
  }

  if (argv[0] === 'auth' && argv[1] === 'status' && argv[2] === '--json') {
    if (process.env.FAKE_CLAUDE_AUTH_STATUS_FAIL === '1') {
      process.stderr.write('error: not logged in\n');
      process.exit(1);
    }
    const body =
      process.env.FAKE_CLAUDE_AUTH_STATUS ??
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'fake@example.com',
        orgId: 'org-fake',
        orgName: "fake's Organization",
        subscriptionType: 'max',
      });
    process.stdout.write(`${body}\n`);
    process.exit(0);
  }

  if (argv.includes('--version')) {
    process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? '2.0.0-fake'}\n`);
    process.exit(0);
  }

  if (process.env.FAKE_CLAUDE_CRASH_WITH_STDERR) {
    process.stderr.write(`${process.env.FAKE_CLAUDE_CRASH_WITH_STDERR}\n`);
    process.exit(1);
  }

  // Exactly the flags packages/client/src/adapters/claude/claude-adapter.ts
  // can ever construct today — see the module doc comment above.
  const FLAG_TAKES_VALUE = {
    '-p': false,
    '--input-format': true,
    '--output-format': true,
    '--verbose': false,
    '--resume': true,
    '--permission-mode': true,
    '--tools': true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--') && arg !== '-p') continue;
    if (!(arg in FLAG_TAKES_VALUE)) {
      process.stderr.write(`error: unknown option '${arg}'\n`);
      process.exit(1);
    }
    if (FLAG_TAKES_VALUE[arg]) i += 1; // skip this flag's value token
  }

  const sessionId = process.env.FAKE_CLAUDE_SESSION_ID ?? 'fake-claude-session-1';

  const resumeIdx = argv.indexOf('--resume');
  if (resumeIdx !== -1) {
    const requested = argv[resumeIdx + 1];
    if (requested !== sessionId) {
      // Verbatim format+behavior, empirically confirmed against real claude
      // 2.1.212 given an unresolvable --resume target: a clean, parseable
      // `result` frame on stdout AND the same message on stderr, exit 1 —
      // never a hang, never a fabricated fresh session.
      const errMsg = `No conversation found with session ID: ${requested}`;
      process.stdout.write(
        `${JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          duration_ms: 0,
          duration_api_ms: 0,
          is_error: true,
          num_turns: 0,
          stop_reason: null,
          session_id: requested,
          total_cost_usd: 0,
          usage: {},
          permission_denials: [],
          errors: [errMsg],
        })}\n`,
      );
      process.stderr.write(`${errMsg}\n`);
      process.exit(1);
    }
  }

  // The id actually reported in system/init and every other frame's own
  // session_id field this run — independent of `sessionId` above (which
  // only gates the --resume-target validation just above). See
  // FAKE_CLAUDE_REPORTED_SESSION_ID's own doc comment for why this exists.
  const reportedSessionId = process.env.FAKE_CLAUDE_REPORTED_SESSION_ID ?? sessionId;

  function send(obj) {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  const rl = createInterface({ input: process.stdin, terminal: false });
  let turn = 0;

  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type !== 'user') return; // only real input shape this fixture accepts, per --input-format stream-json
    const text = msg.message?.content?.[0]?.text ?? '';
    runTurn(text);
  });

  function runTurn(incomingText) {
    turn += 1;

    send({
      type: 'system',
      subtype: 'init',
      cwd: process.cwd(),
      session_id: reportedSessionId,
      tools: ['Bash', 'Edit', 'Read', 'Write'],
      permissionMode: 'default',
    });

    if (process.env.FAKE_CLAUDE_UNKNOWN_TOP_LEVEL === '1' && turn === 1) {
      send({ type: 'totally_novel_top_level_frame', session_id: reportedSessionId });
    }
    if (process.env.FAKE_CLAUDE_UNKNOWN_SYSTEM_SUBTYPE === '1' && turn === 1) {
      send({ type: 'system', subtype: 'totally_novel_subtype', session_id: reportedSessionId });
    }

    const toolUseId = `toolu_fake_${turn}`;
    const artifactPath = process.env.FAKE_CLAUDE_ARTIFACT_PATH;

    if (artifactPath) {
      const resolved = path.resolve(process.cwd(), artifactPath);
      send({
        type: 'assistant',
        message: { model: 'fake-model', id: `msg_${turn}`, role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Write', input: { file_path: resolved, content: process.env.FAKE_CLAUDE_ARTIFACT_CONTENT ?? 'artifact-body' } }] },
        session_id: reportedSessionId,
      });

      if (process.env.FAKE_CLAUDE_DENY === '1') {
        send({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `Claude requested permissions to write to ${resolved}, but you haven't granted it yet.`, is_error: true }] },
          tool_use_result: `Error: Claude requested permissions to write to ${resolved}, but you haven't granted it yet.`,
          session_id: reportedSessionId,
        });
      } else {
        mkdirSync(path.dirname(resolved), { recursive: true });
        writeFileSync(resolved, process.env.FAKE_CLAUDE_ARTIFACT_CONTENT ?? 'artifact-body');
        send({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `File created successfully at: ${resolved}` }] },
          tool_use_result: { type: 'create', filePath: resolved, content: process.env.FAKE_CLAUDE_ARTIFACT_CONTENT ?? 'artifact-body', structuredPatch: [], originalFile: null, userModified: false },
          session_id: reportedSessionId,
        });
      }
    } else {
      send({
        type: 'assistant',
        message: { model: 'fake-model', id: `msg_${turn}`, role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'echo hi' } }] },
        session_id: reportedSessionId,
      });

      if (process.env.FAKE_CLAUDE_DENY === '1') {
        send({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Claude requested permissions to use Bash, but you haven\'t granted it yet.', is_error: true }] },
          tool_use_result: 'Error: Claude requested permissions to use Bash, but you haven\'t granted it yet.',
          session_id: reportedSessionId,
        });
      } else {
        send({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'hi\n' }] },
          tool_use_result: { stdout: 'hi\n', stderr: '', interrupted: false, isImage: false },
          session_id: reportedSessionId,
        });
      }
    }

    if (process.env.FAKE_CLAUDE_HANG_AFTER_TOOL === '1') {
      return; // stay "running" indefinitely — see the toggle's doc comment above
    }

    const finalText = `reply-${turn}:${incomingText}`;
    const content = [
      { type: 'thinking', thinking: `thinking about turn ${turn}`, signature: 'fake-sig' },
      { type: 'text', text: finalText },
    ];
    if (process.env.FAKE_CLAUDE_UNKNOWN_ASSISTANT_BLOCK === '1' && turn === 1) {
      content.push({ type: 'totally_novel_block_type', payload: 'x' });
    }
    send({ type: 'assistant', message: { model: 'fake-model', id: `msg_${turn}b`, role: 'assistant', content }, session_id: reportedSessionId });

    send({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, session_id: reportedSessionId });

    if (process.env.FAKE_CLAUDE_RESULT_MALFORMED === '1') {
      // See FAKE_CLAUDE_RESULT_MALFORMED's own doc comment above: `is_error`
      // is deliberately omitted (not `false`, not `true`) and this script
      // does NOT exit — the persistent process stays alive exactly as it
      // does after a normal turn, since nothing below this branch ever runs.
      send({
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: 10,
        duration_api_ms: 8,
        num_turns: turn,
        stop_reason: null,
        session_id: reportedSessionId,
        total_cost_usd: 0,
        usage: {},
        result: finalText,
        permission_denials: [],
      });
      return;
    }

    send({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 10,
      duration_api_ms: 8,
      num_turns: turn,
      stop_reason: 'end_turn',
      session_id: reportedSessionId,
      total_cost_usd: 0.001,
      // Real shape (field names + nesting) confirmed via a live `claude -p
      // --output-format stream-json` probe against the installed claude
      // 2.1.212 binary — see events.ts's `extractClaudeUsageEvent` doc
      // comment. Values here are fixed/small rather than the live probe's
      // real (much larger) numbers, matching this fixture's existing
      // convention of deterministic placeholder data (e.g. total_cost_usd
      // above is also a fixed placeholder, not a real cost).
      usage: {
        input_tokens: 15,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 20,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      },
      result: finalText,
      permission_denials:
        process.env.FAKE_CLAUDE_DENY === '1'
          ? [{ tool_name: artifactPath ? 'Write' : 'Bash', tool_use_id: toolUseId, tool_input: {} }]
          : [],
    });
  }

  process.on('SIGTERM', () => process.exit(143));
}
