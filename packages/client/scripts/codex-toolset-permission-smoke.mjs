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

function run(label, grant) {
  const audit = path.join(root, `${label}.jsonl`);
  // Exactly what adapters/codex/codex-adapter.ts constructs for a readonly
  // task with one projected toolset server.
  const args = [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check',
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
    PROMPT,
  ];
  const result = spawnSync(codexBin, args, { cwd: root, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.error, undefined, result.error?.message);
  const output = `${result.stdout}\n${result.stderr}`;
  const kinds = existsSync(audit)
    ? readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).kind)
    : [];
  return { status: result.status, output, kinds };
}

try {
  const ungranted = run('ungranted', false);
  assert.ok(ungranted.kinds.includes('tools/list'), 'ungranted run never reached the MCP server at all');
  assert.ok(!ungranted.kinds.includes('tools/call'), 'ungranted run reached tools/call — the CLI is not enforcing the approval policy this smoke exists to prove');
  assert.match(ungranted.output, /requires approval|approval policy is never/i);

  const granted = run('granted', true);
  assert.equal(granted.status, 0, granted.output);
  assert.ok(granted.kinds.includes('tools/call'), `granted run never reached tools/call: ${granted.output}`);
  assert.match(granted.output, /byok-echo:gate/);
  assert.doesNotMatch(granted.output, /requires approval|approval policy is never/i);

  process.stdout.write(`[codex-toolset-permission] ${codexBin} called the projected toolset tool only with its per-tool grant, global approval still never\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
