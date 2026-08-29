import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const binArg = process.argv.indexOf('--codex-bin');
const codexBin = binArg >= 0 ? process.argv[binArg + 1] : 'codex';
const fixture = fileURLToPath(new URL('../src/__tests__/fixtures/native-agent-message-mcp.mjs', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'byok-codex-native-message-'));
const receipt = path.join(root, 'receipt.json');
const body = 'BYOK native permission canary';

try {
  const args = [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '-c', 'sandbox_mode=read-only',
    '-c', 'approval_policy=never',
    '-c', `mcp_servers.byokagentmessage.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.byokagentmessage.args=${JSON.stringify([fixture])}`,
    '-c', `mcp_servers.byokagentmessage.env.BYOK_NATIVE_MESSAGE_RECEIPT=${JSON.stringify(receipt)}`,
    '-c', 'mcp_servers.byokagentmessage.enabled_tools=["send_agent_message"]',
    '-c', 'mcp_servers.byokagentmessage.tools.send_agent_message.approval_mode="approve"',
    `Call mcp__byokagentmessage__send_agent_message exactly once with body ${JSON.stringify(body)}. After the tool succeeds, reply exactly DONE.`,
  ];
  const result = spawnSync(codexBin, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /requires approval|approval policy is never/i);
  assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), { body });
  process.stdout.write(`[codex-agent-message-permission] ${codexBin} approved only the reserved message tool\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
