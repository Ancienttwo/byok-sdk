/**
 * Live permission smoke: prove the REAL installed `claude` calls a projected
 * toolset MCP tool under `policy.mode = readonly` + `allowTools: []` only when
 * the adapter's `--allowedTools` grant is present.
 *
 * Same shape and gating as `codex-agent-message-permission-smoke.mjs`: a real
 * CLI, a one-tool stdio fixture, everything under `mkdtemp`, run explicitly
 * (it needs a logged-in CLI and spends a model call), never from `bun test`.
 *
 *   node scripts/claude-toolset-permission-smoke.mjs [--claude-bin <path>]
 *
 * Both directions are asserted in one script, because a positive result alone
 * cannot tell a working grant apart from a permissive CLI:
 *   1. the exact adapter argv WITHOUT the grant -> tools/list, no tools/call
 *   2. the same argv WITH the grant             -> tools/call, echoed result
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const binArg = process.argv.indexOf('--claude-bin');
const claudeBin = binArg >= 0 ? process.argv[binArg + 1] : 'claude';
const fixture = fileURLToPath(new URL('../src/__tests__/fixtures/toolset-echo-mcp.mjs', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'byok-claude-toolset-permission-'));
const SERVER = 'byoktoolsetprobe';
const PROMPT = "Call the echo tool with 'gate' and reply with its result only.";

function run(label, grant) {
  const audit = path.join(root, `${label}.jsonl`);
  const configPath = path.join(root, `${label}-mcp-config.json`);
  writeFileSync(configPath, JSON.stringify({
    mcpServers: { [SERVER]: { command: process.execPath, args: [fixture, audit] } },
  }));
  // Exactly what adapters/claude/claude-adapter.ts constructs for a readonly
  // task with one projected toolset server.
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'default', '--tools', '',
    ...(grant ? ['--allowedTools', `mcp__${SERVER}__echo`] : []),
    '--mcp-config', configPath, '--strict-mcp-config',
  ];
  const stdin = `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: PROMPT }] },
  })}\n`;
  const result = spawnSync(claudeBin, args, { cwd: root, input: stdin, encoding: 'utf8', timeout: 180_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const kinds = existsSync(audit)
    ? readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).kind)
    : [];
  return { stdout: result.stdout, kinds };
}

try {
  const ungranted = run('ungranted', false);
  assert.ok(ungranted.kinds.includes('tools/list'), 'ungranted run never reached the MCP server at all');
  assert.ok(!ungranted.kinds.includes('tools/call'), 'ungranted run reached tools/call — the CLI is not enforcing the grant this smoke exists to prove');
  assert.match(ungranted.stdout, /permission_denied|hasn't granted|haven't granted/i);

  const granted = run('granted', true);
  assert.ok(granted.kinds.includes('tools/call'), `granted run never reached tools/call: ${granted.stdout}`);
  assert.match(granted.stdout, /byok-echo:gate/);
  assert.doesNotMatch(granted.stdout, /permission_denied/);
  // The grant must not have re-enabled a single built-in: `--tools ""` still
  // rules the capability surface.
  const init = granted.stdout.split('\n').map((line) => { try { return JSON.parse(line); } catch { return undefined; } })
    .find((frame) => frame?.type === 'system' && Array.isArray(frame.tools));
  assert.ok(init, 'no system/init frame with a tools array');
  assert.deepEqual(init.tools, [`mcp__${SERVER}__echo`], `built-in tools leaked into the grant: ${JSON.stringify(init.tools)}`);

  process.stdout.write(`[claude-toolset-permission] ${claudeBin} called the projected toolset tool only with --allowedTools, built-ins still empty\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
