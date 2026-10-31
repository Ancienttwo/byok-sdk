import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { knownFamilies, selectImpact } from './select-impact.mjs';
import { planCi } from './plan-ci.mjs';

test('service upgrade inputs select the required three-platform smoke in routine and full modes', () => {
  for (const path of ['examples/service-upgrade/upgrade-smoke.mjs', 'examples/service-upgrade/app-installer.ts',
    'examples/service-upgrade/app-installer.test.ts', 'packages/client/src/lifecycle/service-installation.ts',
    'packages/client/src/bin/byok-agent.ts', 'packages/client/src/daemon/control-client.ts',
    'packages/client/src/bin/commands/service.ts', 'packages/client/src/bin/commands/upgrade.ts',
    'packages/client/src/daemon/daemon-owner.ts', 'packages/client/src/daemon/owned-process-ledger.ts',
    'packages/client/src/diagnostics/store-compatibility.ts', 'packages/client/src/adapters/packaging.ts',
    'templates/service/systemd/smoke-test.mjs', 'templates/service/launchd/install.sh', 'templates/service/winsw/smoke-test.mjs']) {
    assert.ok(selectImpact([path]).families.includes('service-upgrade-smoke'), path);
  }
  assert.ok(!selectImpact(['packages/core/src/unrelated.ts']).families.includes('service-upgrade-smoke'));
  const sha = 'a'.repeat(40);
  for (const event of ['schedule', 'workflow_dispatch']) {
    assert.ok(planCi({ event, ref: 'refs/heads/main', sha, approvedSha: sha }).families.includes('service-upgrade-smoke'));
  }
  assert.ok(knownFamilies.includes('service-upgrade-smoke'));
});

test('upgrade lane provisions native credentials and managers without skip paths', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const block = workflow.split('\n  service-upgrade-smoke:\n')[1].split('\n  linux-systemd-smoke:\n')[0];
  assert.match(block, /os: \[macos-latest, ubuntu-latest, windows-latest\]/);
  assert.match(block, /bun ci[\s\S]*bun run build[\s\S]*node examples\/service-upgrade\/upgrade-smoke\.mjs/);
  assert.match(block, /loginctl enable-linger/);
  assert.match(block, /systemctl start "user@\$\{uid\}\.service"/);
  assert.match(block, /is-system-running --wait/);
  assert.match(block, /User manager unavailable: \$state.*exit 1/);
  assert.match(block, /DBUS_SESSION_BUS_ADDRESS="unix:path=\$\{XDG_RUNTIME_DIR\}\/bus"/);
  assert.match(block, /secret-tool store[\s\S]*secret-tool lookup[\s\S]*secret-tool clear/);
  assert.doesNotMatch(block, /dbus-run-session|continue-on-error|\|\| true/);
  assert.match(block, /Get-FileHash -Algorithm SHA256/);
  assert.match(block, /WINSW_BIN=\$out/);
  assert.match(block, /LongPathsEnabled -Value 1/);
  assert.match(workflow.split('\n  ci-required:')[1] ?? workflow.slice(workflow.indexOf('needs: ["select"')), /"service-upgrade-smoke"/);
});
