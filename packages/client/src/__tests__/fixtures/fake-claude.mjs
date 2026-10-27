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
//   FAKE_CLAUDE_INTERRUPT_TERMINAL_REASON=<reason>
//                                       -> the `terminal_reason` on the
//                                          error_during_execution result sent
//                                          after an interrupt ACK. Default
//                                          `aborted_streaming` (generation
//                                          phase); `aborted_tools` is what the
//                                          real binary reports when the
//                                          interrupt lands in the tool phase.
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
//   FAKE_CLAUDE_SPLIT_CLOSING_TEXT=1    -> send the final message as one
//                                          frame per content block, as real
//                                          claude does, with its text split
//                                          across two text blocks of the
//                                          same message id.
//   FAKE_CLAUDE_REPEAT_CLOSING_TEXT=1   -> after the final message, send a
//                                          second assistant message (new id)
//                                          with the same text and no tool
//                                          between, as reported downstream
//                                          in #501. `result.result` carries
//                                          the text once.
//   FAKE_CLAUDE_ROOT_FRAMES=1           -> every assistant frame carries
//                                          `parent_tool_use_id: null`, as
//                                          claude 2.1.302 marks the root
//                                          agent's frames.
//   FAKE_CLAUDE_EXTRA_ASSISTANT=<json array> -> before the final message,
//                                          one content-free assistant frame
//                                          per entry, with its `model` and
//                                          `parent_tool_use_id` (a subagent
//                                          frame when that is a string).
//   FAKE_CLAUDE_PARTIAL_MESSAGES=1      -> with `--include-partial-messages`
//                                          in argv, its frames, in the order captured
//                                          from claude 2.1.302: one
//                                          `message_start` per message id,
//                                          then per content block its
//                                          `content_block_start`, its deltas
//                                          (two text halves, a thinking and
//                                          a signature delta, or the tool
//                                          input JSON), a one-block
//                                          `assistant` frame, and
//                                          `content_block_stop`.
//   FAKE_CLAUDE_REPLY_GATE=<dir>        -> with partial messages, each text
//                                          block waits for `<dir>/release`
//                                          after its deltas and before its
//                                          `assistant` frame.
//   FAKE_CLAUDE_MCP_STATUS=<json>       -> the `mcp_status` control response
//                                          body, instead of listing each
//                                          `--mcp-config` server's tools.
//   FAKE_CLAUDE_MCP_STATUS_NO_ACK=1     -> never answer `mcp_status`.
//   FAKE_CLAUDE_MCP_STATUS_RECEIPT=<path> -> append each `mcp_status` request.
//   FAKE_CLAUDE_FAILURES=<json array>   -> entry N fails turn N+1 the way an
//                                          API error does: an optional
//                                          `rate_limit_event` with
//                                          `rateLimit` as its info, an
//                                          assistant frame with `error`, then
//                                          an `is_error` result with
//                                          `api_error_status: status`.
//                                          `{ "exit": true }` exits instead.
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
//   FAKE_CLAUDE_PERSIST_SESSIONS=1      -> stands in for Claude's session
//                                          transcript: each turn appends its
//                                          instruction to
//                                          `$CLAUDE_CONFIG_DIR/projects/<cwd
//                                          with every non-alphanumeric
//                                          character as '-'>/<session>.jsonl`,
//                                          unless argv has
//                                          `--no-session-persistence`. It
//                                          requires CLAUDE_CONFIG_DIR, so a
//                                          test never writes the real
//                                          `~/.claude`.

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { spawnProcessTreeDescendant } from './process-tree-receipt.mjs';

const argv = process.argv.slice(2);

// Three levels (root -> descendant -> grandchild); the descendant writes the
// pid receipt. Awaited so the receipt is complete before the first frame — see
// ./process-tree-receipt.mjs.
if (process.env.FAKE_CLAUDE_PROCESS_TREE_FILE && argv.includes('-p')) {
  await spawnProcessTreeDescendant({
    receiptFile: process.env.FAKE_CLAUDE_PROCESS_TREE_FILE,
    rootPid: process.pid,
  });
}

// Real claude auto-denies an MCP tool call under --permission-mode default
// AND under acceptEdits; --dangerously-skip-permissions allows it. The check
// below mirrors that, so an adapter regression that drops the YOLO flag fails
// a test here instead of silently passing against a permissive fixture.
function isMcpToolGranted() {
  return argv.includes('--dangerously-skip-permissions');
}

function configuredMcpServers() {
  const configIndex = argv.indexOf('--mcp-config');
  if (configIndex === -1 || !argv[configIndex + 1]) {
    throw new Error('fake claude was asked to call MCP without --mcp-config');
  }
  return JSON.parse(readFileSync(argv[configIndex + 1], 'utf8')).mcpServers ?? {};
}

async function callConfiguredMcpTool(serverName, toolName, toolArguments) {
  if (!isMcpToolGranted()) {
    throw new Error(`Claude requested permissions to use mcp__${serverName}__${toolName}, but you haven't granted it yet.`);
  }
  return withConfiguredMcpServer(serverName, async (listed, request) => {
    if (!listed?.tools?.some((tool) => tool.name === toolName)) {
      throw new Error(`MCP server ${serverName} did not list tool ${toolName}`);
    }
    return request('tools/call', { name: toolName, arguments: toolArguments });
  });
}

// Real claude answers the `mcp_status` control request with every configured
// server and the tools its own `tools/list` returned, under the CONFIGURED
// server name and the server's ORIGINAL tool names (confirmed live against
// claude 2.1.302: server `market.feed`, tool `get.quote`).
async function mcpStatus() {
  const servers = [];
  for (const [name, { command, args = [] }] of Object.entries(configuredMcpServers())) {
    const config = { type: 'stdio', command, args };
    try {
      const listed = await withConfiguredMcpServer(name, async (tools) => tools);
      servers.push({ name, status: 'connected', config, scope: 'dynamic', source: 'dynamic', tools: (listed?.tools ?? []).map((tool) => ({ name: tool.name, annotations: {} })) });
    } catch (error) {
      servers.push({ name, status: 'failed', config, scope: 'dynamic', source: 'dynamic', error: String(error) });
    }
  }
  return { mcpServers: servers };
}

async function withConfiguredMcpServer(serverName, use) {
  const server = configuredMcpServers()[serverName];
  if (!server || typeof server.command !== 'string') {
    throw new Error(`fake claude could not find MCP server ${serverName}`);
  }

  const child = spawn(server.command, Array.isArray(server.args) ? server.args : [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(server.env ?? {}) },
  });
  const pending = new Map();
  const childLines = createInterface({ input: child.stdout, terminal: false });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  childLines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message ?? 'MCP request failed'));
    else waiter.resolve(message.result);
  });
  child.on('exit', (code) => {
    if (code === 0 || pending.size === 0) return;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP server exited ${code}: ${stderr}`));
    }
    pending.clear();
  });

  let requestId = 0;
  function request(method, params = {}) {
    requestId += 1;
    const id = requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 3000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  try {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'fake-claude', version: '1.0.0' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    return await use(await request('tools/list'), request);
  } finally {
    childLines.close();
    child.kill('SIGTERM');
  }
}

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
  // A regression here (a flag rename/removal on the adapter side with no
  // matching update here, or a removed permission flag coming back) must
  // fail a test via "unknown option", exactly like every other flag in this
  // map. `--permission-mode` and `--permission-prompt-tool` are only the
  // native-interactions opt-in path.
  const FLAG_TAKES_VALUE = {
    '-p': false,
    '--input-format': true,
    '--output-format': true,
    '--verbose': false,
    '--include-partial-messages': false,
    '--model': true,
    '--resume': true,
    '--dangerously-skip-permissions': false,
    '--permission-mode': true,
    '--permission-prompt-tool': true,
    '--mcp-config': true,
    '--strict-mcp-config': false,
    '--settings': true,
    '--no-session-persistence': false,
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

  let streamedMessage;
  async function sendAssistant(rawFrame) {
    const frame = process.env.FAKE_CLAUDE_ROOT_FRAMES === '1' ? { ...rawFrame, parent_tool_use_id: null } : rawFrame;
    // Real claude streams these frames only under the flag; a dropped flag must fail a test.
    if (process.env.FAKE_CLAUDE_PARTIAL_MESSAGES !== '1' || !argv.includes('--include-partial-messages')) return send(frame);
    const message = frame.message;
    const stream = (event) => send({ type: 'stream_event', event, session_id: reportedSessionId, parent_tool_use_id: null, api_message_id: message.id });
    if (streamedMessage?.id !== message.id) {
      streamedMessage = { id: message.id, index: 0 };
      stream({ type: 'message_start', message: { ...message, content: [] } });
    }
    for (const block of message.content) {
      const index = streamedMessage.index++;
      const deltas = block.type === 'text'
        ? [block.text.slice(0, Math.ceil(block.text.length / 2)), block.text.slice(Math.ceil(block.text.length / 2))].map((text) => ({ type: 'text_delta', text }))
        : block.type === 'thinking'
          ? [{ type: 'thinking_delta', thinking: block.thinking }, { type: 'signature_delta', signature: block.signature }]
          : block.type === 'tool_use' ? [{ type: 'input_json_delta', partial_json: JSON.stringify(block.input) }] : [];
      const empty = block.type === 'text' ? { type: 'text', text: '' } : block.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { ...block, ...(block.type === 'tool_use' ? { input: {} } : {}) };
      stream({ type: 'content_block_start', index, content_block: empty });
      for (const delta of deltas) stream({ type: 'content_block_delta', index, delta });
      const gate = process.env.FAKE_CLAUDE_REPLY_GATE;
      while (gate && block.type === 'text' && !existsSync(path.join(gate, 'release'))) await new Promise((resolve) => setTimeout(resolve, 10));
      send({ ...frame, message: { ...message, content: [block] } });
      stream({ type: 'content_block_stop', index });
    }
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
    if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
      if (process.env.FAKE_CLAUDE_CONTROL_RECEIPT) writeFileSync(process.env.FAKE_CLAUDE_CONTROL_RECEIPT, JSON.stringify(msg));
      if (process.env.FAKE_CLAUDE_INTERRUPT_NO_ACK === '1') return;
      send({ type:'control_response',response:{subtype:'success',request_id:msg.request_id,response:{still_queued:[]}} });
      const result = process.env.FAKE_CLAUDE_INTERRUPT_LATE_SUCCESS === '1'
        ? {type:'result',subtype:'success',is_error:false,session_id:reportedSessionId,usage:{},result:'late completion'}
        : {type:'result',subtype:'error_during_execution',terminal_reason:process.env.FAKE_CLAUDE_INTERRUPT_TERMINAL_REASON ?? 'aborted_streaming',is_error:true,session_id:reportedSessionId,usage:{}};
      setTimeout(()=>send(result), Number(process.env.FAKE_CLAUDE_INTERRUPT_RESULT_DELAY_MS ?? '0'));
      return;
    }
    if (msg.type === 'control_request' && msg.request?.subtype === 'mcp_status') {
      if (process.env.FAKE_CLAUDE_MCP_STATUS_RECEIPT) appendFileSync(process.env.FAKE_CLAUDE_MCP_STATUS_RECEIPT, `${JSON.stringify(msg)}\n`);
      if (process.env.FAKE_CLAUDE_MCP_STATUS_NO_ACK === '1') return;
      void (process.env.FAKE_CLAUDE_MCP_STATUS ? Promise.resolve(JSON.parse(process.env.FAKE_CLAUDE_MCP_STATUS)) : mcpStatus()).then(
        (response) => send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } }),
        (error) => send({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: String(error) } }),
      );
      return;
    }
    if (msg.type !== 'user') return; // only real input shape this fixture accepts, per --input-format stream-json
    const text = msg.message?.content?.[0]?.text ?? '';
    void runTurn(text).catch((error) => {
      process.stderr.write(`fake claude MCP flow failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  });

  async function runTurn(incomingText) {
    turn += 1;
    if (process.env.FAKE_CLAUDE_PERSIST_SESSIONS === '1' && !argv.includes('--no-session-persistence')) {
      const configDir = process.env.CLAUDE_CONFIG_DIR;
      if (!configDir) {
        process.stderr.write('FAKE_CLAUDE_PERSIST_SESSIONS requires CLAUDE_CONFIG_DIR\n');
        process.exit(1);
      }
      const projectDir = path.join(configDir, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
      mkdirSync(projectDir, { recursive: true });
      appendFileSync(path.join(projectDir, `${reportedSessionId}.jsonl`), `${JSON.stringify({ type: 'user', text: incomingText })}\n`);
    }

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
    let mcpResultText;

    // The daemon prepends Agent guidance to the task instruction; the
    // instruction is the prompt's last paragraph.
    if (incomingText.split('\n\n').at(-1) === 'salesko:find-leads') {
      const toolInput = { company: 'Acme', limit: 2 };
      await sendAssistant({
        type: 'assistant',
        message: { model: 'fake-model', id: `msg_${turn}`, role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'mcp__salesko__find_leads', input: toolInput }] },
        session_id: reportedSessionId,
      });
      const mcpResult = await callConfiguredMcpTool('salesko', 'find_leads', toolInput);
      mcpResultText = mcpResult?.content?.[0]?.text ?? JSON.stringify(mcpResult);
      send({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: mcpResultText, is_error: false }] },
        tool_use_result: mcpResult,
        session_id: reportedSessionId,
      });
    } else if (artifactPath) {
      const resolved = path.resolve(process.cwd(), artifactPath);
      await sendAssistant({
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
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `File created successfully at: ${resolved}`, is_error: false }] },
          tool_use_result: { type: 'create', filePath: resolved, content: process.env.FAKE_CLAUDE_ARTIFACT_CONTENT ?? 'artifact-body', structuredPatch: [], originalFile: null, userModified: false },
          session_id: reportedSessionId,
        });
      }
    } else {
      await sendAssistant({
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
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'hi\n', is_error: false }] },
          tool_use_result: { stdout: 'hi\n', stderr: '', interrupted: false, isImage: false },
          session_id: reportedSessionId,
        });
      }
    }

    if (process.env.FAKE_CLAUDE_HANG_AFTER_TOOL === '1') {
      return; // stay "running" indefinitely — see the toggle's doc comment above
    }

    const failure = JSON.parse(process.env.FAKE_CLAUDE_FAILURES ?? '[]')[turn - 1];
    if (failure) {
      if (failure.exit === true) process.exit(1);
      if (failure.rateLimit !== undefined) send({ type: 'rate_limit_event', rate_limit_info: failure.rateLimit, session_id: reportedSessionId });
      const text = failure.text ?? 'API Error: fixture failure';
      send({
        type: 'assistant',
        message: { model: '<synthetic>', id: `msg_${turn}e`, role: 'assistant', content: [{ type: 'text', text }] },
        ...(failure.error === undefined ? {} : { error: failure.error }),
        session_id: reportedSessionId,
      });
      send({
        type: 'result', subtype: 'success', is_error: true, duration_ms: 10, duration_api_ms: 8, num_turns: turn,
        session_id: reportedSessionId, total_cost_usd: 0, usage: {}, result: text, api_error_status: failure.status ?? null, permission_denials: [],
      });
      return;
    }

    for (const [index, extra] of JSON.parse(process.env.FAKE_CLAUDE_EXTRA_ASSISTANT ?? '[]').entries()) {
      send({ type: 'assistant', message: { model: extra.model, id: `msg_${turn}x${index}`, role: 'assistant', content: [] }, parent_tool_use_id: extra.parent_tool_use_id, session_id: reportedSessionId });
    }

    const finalText = `reply-${turn}:${mcpResultText ?? incomingText}`;
    const content = [
      { type: 'thinking', thinking: `thinking about turn ${turn}`, signature: 'fake-sig' },
      { type: 'text', text: finalText },
    ];
    if (process.env.FAKE_CLAUDE_UNKNOWN_ASSISTANT_BLOCK === '1' && turn === 1) {
      content.push({ type: 'totally_novel_block_type', payload: 'x' });
    }
    if (process.env.FAKE_CLAUDE_SPLIT_CLOSING_TEXT === '1') {
      const half = Math.ceil(finalText.length / 2);
      const blocks = [content[0], { type: 'text', text: finalText.slice(0, half) }, { type: 'text', text: finalText.slice(half) }];
      for (const block of blocks) {
        send({ type: 'system', subtype: 'thinking_tokens', session_id: reportedSessionId });
        await sendAssistant({ type: 'assistant', message: { model: 'fake-model', id: `msg_${turn}b`, role: 'assistant', content: [block] }, session_id: reportedSessionId });
      }
    } else {
      await sendAssistant({ type: 'assistant', message: { model: 'fake-model', id: `msg_${turn}b`, role: 'assistant', content }, session_id: reportedSessionId });
    }
    if (process.env.FAKE_CLAUDE_REPEAT_CLOSING_TEXT === '1') {
      await sendAssistant({ type: 'assistant', message: { model: 'fake-model', id: `msg_${turn}c`, role: 'assistant', content: [{ type: 'text', text: finalText }] }, session_id: reportedSessionId });
    }

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
