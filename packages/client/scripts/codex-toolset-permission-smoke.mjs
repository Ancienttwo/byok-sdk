/**
 * Live permission smoke: prove the REAL installed `codex` calls a projected
 * toolset MCP tool under `sandbox_mode=read-only` + `approval_policy=never`
 * only when the adapter's per-tool grant is present.
 *
 * The sibling of `codex-agent-message-permission-smoke.mjs` for a
 * NON-reserved server name — the case the reserved smoke could not cover, and
 * the one the downstream Gate 0 falsifier proved broken. Run explicitly (it
 * needs a logged-in CLI and spends a model call), never from `bun test`.
 *
 *   node scripts/codex-toolset-permission-smoke.mjs [--codex-bin <path>]
 *
 * Both directions are asserted, because a positive result alone cannot tell a
 * working grant apart from a permissive CLI:
 *   1. the exact adapter argv WITHOUT the grant -> tools/list, no tools/call
 *   2. the same argv WITH the grant             -> tools/call, echoed result
 *   3. `exec resume` of (2) with the SAME grant argv -> tools/call again
 *
 * Step 3 is the follow-up turn: a resume spawns a brand new codex process
 * that inherits none of the first turn's `-c` overrides, so it proves the
 * adapter's replayed MCP config (`CodexSession.mcpConfigArgs`) is what keeps
 * the toolset reachable past turn one. It runs without `--ephemeral`
 * (`--ephemeral` persists no session file, so there is nothing to resume) —
 * matching the adapter, which never passes that flag.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const binArg = process.argv.indexOf('--codex-bin');
const codexBin = binArg >= 0 ? process.argv[binArg + 1] : 'codex';
const fixture = fileURLToPath(new URL('../src/__tests__/fixtures/toolset-echo-mcp.mjs', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'byok-codex-toolset-permission-'));
const SERVER = 'byoktoolsetprobe';
const PROMPT = "Call the echo tool with 'gate' and reply with its result only.";
const RESUME_PROMPT = "Call the echo tool with 'resume' and reply with its result only.";

/** `--ignore-user-config` plus every `mcp_servers.*` override, in argv order. */
function mcpConfigSlice(args) {
  const slice = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--ignore-user-config') slice.push('--ignore-user-config');
    if (args[index] === '-c' && args[index + 1]?.startsWith('mcp_servers.')) slice.push('-c', args[index + 1]);
  }
  return slice;
}

// `auditLabel` decides which audit file the projected server writes to — and
// that path is part of the argv, so the resume turn deliberately reuses the
// first turn's file: reusing it is what lets the two turns carry
// byte-identical `mcp_servers.*` overrides (the resume is then measured by
// the tools/call count it ADDS).
function run(label, grant, { prompt = PROMPT, resumeRef, persist = false, auditLabel = label } = {}) {
  const audit = path.join(root, `${auditLabel}.jsonl`);
  // Exactly what adapters/codex/codex-adapter.ts constructs for a readonly
  // task with one projected toolset server.
  const args = [
    'exec', ...(resumeRef === undefined ? [] : ['resume', resumeRef]),
    '--json', ...(persist ? [] : ['--ephemeral']), '--skip-git-repo-check',
    '-c', 'sandbox_mode=read-only',
    '-c', 'approval_policy=never',
    '--ignore-user-config',
    '-c', `mcp_servers.${SERVER}.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.${SERVER}.args=${JSON.stringify([fixture, audit])}`,
    ...(grant
      ? [
        '-c', `mcp_servers.${SERVER}.enabled_tools=${JSON.stringify(['echo'])}`,
        '-c', `mcp_servers.${SERVER}.tools.echo.approval_mode="approve"`,
      ]
      : []),
    prompt,
  ];
  const result = spawnSync(codexBin, args, { cwd: root, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.error, undefined, result.error?.message);
  const output = `${result.stdout}\n${result.stderr}`;
  const kinds = existsSync(audit)
    ? readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).kind)
    : [];
  let threadId;
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const frame = JSON.parse(line);
      if (frame.type === 'thread.started' && typeof frame.thread_id === 'string') threadId = frame.thread_id;
    } catch {
      // non-JSONL noise on stdout is not this smoke's concern
    }
  }
  return { status: result.status, output, kinds, threadId, args };
}

try {
  const ungranted = run('ungranted', false);
  assert.ok(ungranted.kinds.includes('tools/list'), 'ungranted run never reached the MCP server at all');
  assert.ok(!ungranted.kinds.includes('tools/call'), 'ungranted run reached tools/call — the CLI is not enforcing the approval policy this smoke exists to prove');
  assert.match(ungranted.output, /requires approval|approval policy is never/i);

  const granted = run('granted', true, { persist: true });
  assert.equal(granted.status, 0, granted.output);
  assert.ok(granted.kinds.includes('tools/call'), `granted run never reached tools/call: ${granted.output}`);
  assert.match(granted.output, /byok-echo:gate/);
  assert.doesNotMatch(granted.output, /requires approval|approval policy is never/i);
  assert.ok(typeof granted.threadId === 'string', `granted run reported no thread id to resume: ${granted.output}`);

  // The follow-up turn: a resume with the SAME MCP config argv the first turn
  // carried — what CodexSession replays — must reach tools/call again.
  const resumed = run('resumed', true, { persist: true, resumeRef: granted.threadId, prompt: RESUME_PROMPT, auditLabel: 'granted' });
  const callsBefore = granted.kinds.filter((kind) => kind === 'tools/call').length;
  const callsAfter = resumed.kinds.filter((kind) => kind === 'tools/call').length;
  assert.equal(resumed.status, 0, resumed.output);
  assert.ok(callsAfter > callsBefore, `resumed run added no tools/call (${callsBefore} -> ${callsAfter}): ${resumed.output}`);
  assert.match(resumed.output, /byok-echo:resume/);
  assert.doesNotMatch(resumed.output, /requires approval|approval policy is never/i);
  // Byte-identical MCP config on both turns; only the resume positional and
  // the prompt differ.
  assert.deepEqual(mcpConfigSlice(resumed.args), mcpConfigSlice(granted.args));

  process.stdout.write(`[codex-toolset-permission] ${codexBin} called the projected toolset tool only with its per-tool grant, on the first turn and on a resume, global approval still never\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
