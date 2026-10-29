import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyReviewedContent, changedApiOwners } from './reviewed-content.mjs';

// Reviewed workspace graph; the contract test detects manifest drift.
export const workspaceGraph = {
  "examples/basic": {
    "name": "@byok-sdk/example-basic",
    "dependencies": [
      "@byok-sdk/client",
      "@byok-sdk/protocol",
      "@byok-sdk/server"
    ]
  },
  "examples/bot-collaboration": {
    "name": "@byok-sdk/example-bot-collaboration",
    "dependencies": [
      "@byok-sdk/client",
      "@byok-sdk/cloud",
      "@byok-sdk/core",
      "@byok-sdk/example-host-execution-core",
      "@byok-sdk/protocol",
      "@byok-sdk/server"
    ]
  },
  "examples/byok-mcp-server": {
    "name": "@byok-sdk/example-byok-mcp-server",
    "dependencies": [
      "@byok-sdk/client",
      "@byok-sdk/core",
      "@byok-sdk/example-host-execution-core",
      "@byok-sdk/protocol",
      "@byok-sdk/server",
      "@byok-sdk/testkit"
    ]
  },
  "examples/codex-interaction-host": {
    "name": "@byok-sdk/example-codex-interaction-host",
    "dependencies": [
      "@byok-sdk/client"
    ]
  },
  "examples/host-execution-core": {
    "name": "@byok-sdk/example-host-execution-core",
    "dependencies": [
      "@byok-sdk/client",
      "@byok-sdk/cloud",
      "@byok-sdk/core",
      "@byok-sdk/protocol",
      "@byok-sdk/server"
    ]
  },
  "examples/hosted-bot-collaboration": {
    "name": "@byok-sdk/example-hosted-bot-collaboration",
    "dependencies": [
      "@byok-sdk/client",
      "@byok-sdk/cloud",
      "@byok-sdk/cloud-dataplane",
      "@byok-sdk/core",
      "@byok-sdk/example-bot-collaboration",
      "@byok-sdk/example-host-execution-core",
      "@byok-sdk/server"
    ]
  },
  "examples/hosted-bot-collaboration-worker": {
    "name": "@byok-sdk/example-hosted-bot-collaboration-worker",
    "dependencies": [
      "@byok-sdk/client",
      "@byok-sdk/cloud",
      "@byok-sdk/cloud-dataplane",
      "@byok-sdk/example-bot-collaboration",
      "@byok-sdk/example-host-execution-core",
      "@byok-sdk/example-hosted-bot-collaboration",
      "@byok-sdk/server"
    ]
  },
  "examples/live-activity-host": {
    "name": "@byok-sdk/example-live-activity-host",
    "dependencies": [
      "@byok-sdk/cloud",
      "@byok-sdk/ui-runtime"
    ]
  },
  "examples/packaging": {
    "name": "@byok-sdk/example-packaging",
    "dependencies": [
      "@byok-sdk/client",
      "@byok-sdk/keys",
      "@byok-sdk/server"
    ]
  },
  "examples/salesko-connector-broker": {
    "name": "@byok-sdk/example-salesko-connector-broker",
    "dependencies": [
      "@byok-sdk/keys"
    ]
  },
  "packages/client": {
    "name": "@byok-sdk/client",
    "dependencies": [
      "@byok-sdk/core",
      "@byok-sdk/protocol",
      "@byok-sdk/server"
    ]
  },
  "packages/cloud": {
    "name": "@byok-sdk/cloud",
    "dependencies": [
      "@byok-sdk/core",
      "@byok-sdk/protocol"
    ]
  },
  "packages/cloud-dataplane": {
    "name": "@byok-sdk/cloud-dataplane",
    "dependencies": [
      "@byok-sdk/cloud",
      "@byok-sdk/conformance",
      "@byok-sdk/core",
      "@byok-sdk/protocol"
    ]
  },
  "packages/cloud-do": {
    "name": "@byok-sdk/cloud-do",
    "dependencies": [
      "@byok-sdk/client",
      "@byok-sdk/keys"
    ]
  },
  "packages/conformance": {
    "name": "@byok-sdk/conformance",
    "dependencies": [
      "@byok-sdk/cloud",
      "@byok-sdk/core",
      "@byok-sdk/protocol",
      "@byok-sdk/testkit"
    ]
  },
  "packages/core": {
    "name": "@byok-sdk/core",
    "dependencies": []
  },
  "packages/keys": {
    "name": "@byok-sdk/keys",
    "dependencies": [
      "@byok-sdk/core"
    ]
  },
  "packages/protocol": {
    "name": "@byok-sdk/protocol",
    "dependencies": []
  },
  "packages/server": {
    "name": "@byok-sdk/server",
    "dependencies": [
      "@byok-sdk/cloud",
      "@byok-sdk/conformance",
      "@byok-sdk/core",
      "@byok-sdk/protocol"
    ]
  },
  "packages/testkit": {
    "name": "@byok-sdk/testkit",
    "dependencies": [
      "@byok-sdk/core",
      "@byok-sdk/protocol"
    ]
  },
  "packages/ui-runtime": {
    "name": "@byok-sdk/ui-runtime",
    "dependencies": [
      "@byok-sdk/cloud",
      "@byok-sdk/protocol"
    ]
  }
};

export const knownFamilies = Object.freeze([
  'build-test', 'agent-memory-export-linux', 'agent-memory-helper-non-darwin', 'agent-memory-helper',
  'execution-recovery-native', 'adapter-lifecycle-smoke', 'dataplane',
  'windows-client', 'packageability-smoke', 'npm-release-pack',
  'release-pack-migrate', 'windows-service-smoke', 'ipc-smoke', 'credential-isolation-audit',
  'hermes-real-windows', 'runtime-contract',
]);
// A routine PR selects a platform family only when it changes a path that the
// family owns: its tests, smoke scripts and the source they qualify. Package
// membership alone never selects a platform family; the Linux targeted job
// runs the complete owning and dependent workspace suites, and explicit
// release validation runs every family. The contract test checks that each
// test file and script a family job runs is owned by that family.
export const familyOwners = Object.freeze({
  'agent-memory-export-linux': [
    /^examples\/host-execution-core\/src\/fixtures\/memory-restore-crash\.ts$/,
    // #1106: the K4 memory source now lives in the server execution core.
    /^packages\/server\/src\/execution-core\/memory(?:-restore)?\.ts$/,
    /^examples\/host-execution-core\/src\/memory-restore\.test\.ts$/,
    /^examples\/host-execution-core\/src\/memory-linux\.test\.ts$/,
    /^packages\/client\/src\/daemon\/agent-memory-(?:export|filesystem|fs-helper)\.ts$/,
    /^packages\/client\/src\/__tests__\/agent-memory-export[^/]*$/,
  ],
  'agent-memory-helper-non-darwin': [
    /^packages\/client\/native\/agent-memory-fs\//,
    /^packages\/client\/scripts\/[a-z-]*agent-memory-helper[a-z-]*\.mjs$/,
    /^scripts\/release\/agent-memory-helper-source\.test\.mjs$/,
  ],
  'agent-memory-helper': [
    /^packages\/client\/native\/agent-memory-fs\//,
    /^packages\/client\/scripts\/[a-z-]*agent-memory[a-z-]*\.mjs$/,
    /^scripts\/release\/agent-memory-helper-source\.test\.mjs$/,
    /^packages\/client\/src\/(?:agent-memory\/|agent-home|daemon\/(?:agent-memory|prepared-agent-memory|resolve-agent-memory))/,
    /^packages\/client\/src\/__tests__\/(?:agent-memory|agent-home-directory-barrier|daemon-conn-hello-capabilities)[^/]*$/,
    // #605 W5: the power-cut harness modules live in their own directory.
    /^packages\/client\/src\/__tests__\/agent-memory-powercut\//,
  ],
  'execution-recovery-native': [
    /^packages\/client\/src\/daemon\/journal\//,
    /^packages\/client\/src\/__tests__\/(?:execution-recovery|journal-sqlite)[^/]*$/,
    /^packages\/client\/vendor\/oar\/[a-f0-9]{7,40}\/(?:runtimes|shared)\//,
  ],
  'adapter-lifecycle-smoke': [
    /^packages\/client\/src\/(?:adapters|runtime)\//,
    /^packages\/client\/vendor\/oar\/[a-f0-9]{7,40}\/(?:runtimes|shared)\//,
    /^packages\/client\/scripts\/adapter-task-smoke\.mjs$/,
    /^examples\/(?:host-execution-core|bot-collaboration)\//,
    // #1106: the K4 source the K4 Windows qualification runs against.
    /^packages\/server\/src\/execution-core\//,
    /^examples\/basic\/goal-btw\.test-support\.ts$/,
    /^scripts\/ci\/run-windows-bot-tests\.mjs$/,
    /^packages\/keys\/src\/(?:windows-credential-custody[^/]*|(?:windows-credential-manager|device-sealing-key|sealed-provisioning|pi-provider-launcher-core|provider-profile|provider-profile-binding|secret-store|secret-value|sqlite-profile-store|command-runner)\.ts)$/,
  ],
  'windows-client': [
    /^packages\/client\/src\/daemon\/(?:auth-manager|daemon-lifecycle|daemon-owner|daemon-record)\.ts$/,
    /^packages\/client\/src\/(?:util\/(?:secure-dir|atomic-write|fold-name-aliases)\.ts|diagnostics\/|bin\/commands\/)/,
    /^packages\/client\/src\/__tests__\/(?:secure-dir|diagnostics|support-bundle|daemon-auth|daemon-stop-shutdown-parity)[^/]*$/,
    // #738: the Agent-home file write crash test, its child process and the code it qualifies.
    /^packages\/client\/src\/(?:agent-home\.ts|__tests__\/(?:fixtures\/)?agent-home-write-file[^/]*)$/,
    // #712: the Hermes suites this job runs on Windows, their fakes and the code they qualify.
    /^packages\/client\/src\/adapters\/hermes\//,
    /^packages\/client\/src\/__tests__\/(?:hermes-(?:adapter|custody|gateway-control|home)\.test\.ts|fixtures\/fake-hermes(?:\.mjs|-command\.ts))$/,
    /^packages\/keys\/src\/(?:hermes-provider-launcher\.ts|__tests__\/hermes-provider-launcher\.test\.ts)$/,
  ],
  // #608: the real Hermes run on Windows, its fake model endpoint and the code it qualifies.
  'hermes-real-windows': [
    /^packages\/client\/src\/adapters\/hermes\//,
    /^packages\/client\/src\/__tests__\/(?:hermes-real\.test\.ts|fixtures\/hermes-fake-model\.ts)$/,
    /^packages\/keys\/src\/hermes-provider-launcher\.ts$/,
  ],
  'packageability-smoke': [
    /^examples\/packaging\//,
    /^templates\/packaging\//,
    /^packages\/client\/native\/agent-memory-fs\//,
    /^packages\/client\/src\/(?:sdk-native-assets|sdk-reserved-helper-host)/,
    /^packages\/client\/scripts\/single-file-sdk-helper-smoke\.mjs$/,
    /^packages\/server\/src\/(?:__tests__\/)?loopback[^/]*$/,
    /^examples\/byok-mcp-server\/src\/loopback[^/]*$/,
  ],
  'windows-service-smoke': [
    /^templates\/service\/winsw\//,
    /^packages\/client\/src\/(?:lifecycle\/|util\/secure-dir\.ts$)/,
  ],
  'ipc-smoke': [
    /^packages\/client\/src\/daemon\/(?:control-protocol|control-server|device-credential-provider|device-credential-store)\.ts$/,
    /^packages\/client\/src\/(?:bin\/control-client|util\/atomic-write)\.ts$/,
    /^packages\/client\/src\/__tests__\/device-credential-store[^/]*$/,
    /^packages\/client\/scripts\/(?:ipc-smoke|control-socket-check)\.mjs$/,
  ],
  // #1103: the runtime contract suite against each qualified runtime CLI, the
  // adapter and runtime code it qualifies, and its installer.
  'runtime-contract': [
    /^packages\/client\/src\/(?:adapters|runtime|mcp)\//,
    /^packages\/client\/src\/(?:tool-authorization[a-z-]*|runtime-detection|types)\.ts$/,
    /^packages\/client\/src\/bin\/pi-[a-z-]+\.ts$/,
    /^packages\/client\/vendor\/oar\/[a-f0-9]{7,40}\/(?:runtimes|shared)\//,
    /^packages\/client\/src\/__tests__\/runtime-contract\//,
    /^scripts\/ci\/runtime-contract-install(?:\.test)?\.mjs$/,
  ],
  'credential-isolation-audit': [
    /^packages\/client\/src\/adapters\//,
    /^packages\/client\/vendor\/oar\/[a-f0-9]{7,40}\/(?:runtimes|shared)\//,
    /^packages\/client\/scripts\/(?:credential-audit-core|credential-audit-positive-control|linux-credential-audit|adapter-task-smoke)\.mjs$/,
    /^packages\/keys\/src\//,
  ],
});
// #649 and #702: release script paths that the owner reviewed for 0.28.2.
// `tests` run the path (scripts/ci/run-targeted.mjs runs them); `install` marks
// tests that need installed packages, so the targeted job installs first;
// `families` are the family jobs that the path selects.
export const reviewedScripts = Object.freeze({
  'scripts/architecture/dependency-graph.mjs': { tests: ['scripts/architecture/dependency-graph.test.mjs'], install: true },
  'scripts/architecture/dependency-graph.test.mjs': { tests: ['scripts/architecture/dependency-graph.test.mjs'], install: true },
  'scripts/architecture/dependency-baseline.json': { tests: ['scripts/architecture/dependency-graph.test.mjs'], install: true },
  'scripts/docs/device-setup.mjs': { tests: ['scripts/docs/device-setup.test.mjs'] },
  'scripts/docs/device-setup.test.mjs': { tests: ['scripts/docs/device-setup.test.mjs'] },
  'scripts/api-surface/check-version-authority.mjs': { tests: ['scripts/api-surface/check-version-authority.test.mjs'] },
  'scripts/api-surface/check-version-authority.test.mjs': { tests: ['scripts/api-surface/check-version-authority.test.mjs'] },
  'scripts/release/beta-release.test.mjs': { tests: ['scripts/release/beta-release.test.mjs'] },
  // pack-and-smoke.mjs runs this manifest-only check in each of its 4 family
  // jobs; #702 selects npm-release-pack alone. With the install, the targeted
  // job also runs it directly (check:release-graph).
  'scripts/release/check-package-graph.mjs': {
    tests: ['scripts/release/pack-and-smoke.test.mjs', 'scripts/release/beta-release.test.mjs'],
    install: true, families: ['npm-release-pack'],
  },
  'scripts/release/pack-and-smoke.mjs': {
    tests: ['scripts/release/pack-and-smoke.test.mjs', 'scripts/release/agent-memory-helper-source.test.mjs'],
    install: true, families: ['agent-memory-helper', 'dataplane', 'npm-release-pack', 'release-pack-migrate'],
  },
  // pack-and-smoke.mjs copies this smoke next to the installed tarballs and
  // runs it in every family job; #925 selects npm-release-pack alone.
  'scripts/release/execution-submit-smoke.mjs': { tests: [], families: ['npm-release-pack'] },
  // pack-and-smoke.mjs copies this smoke next to the installed tarballs and runs
  // it against the packed client's Pi launcher and todo assets.
  'scripts/release/pi-launcher-smoke.mjs': { tests: [], families: ['npm-release-pack'] },
  'scripts/release/pack-and-smoke.test.mjs': { tests: ['scripts/release/pack-and-smoke.test.mjs'], install: true },
  'scripts/release/publish.mjs': {
    tests: [
      'scripts/release/publish.test.mjs', 'scripts/release/publish-recovery.test.mjs', 'scripts/release/beta-release.test.mjs',
      'scripts/release/install-matrix.test.mjs', 'scripts/release/registry-contract.test.mjs', 'scripts/release/agent-memory-helper-source.test.mjs',
    ],
    install: true,
  },
  'scripts/release/registry-readback.mjs': { tests: ['scripts/release/beta-release.test.mjs'] },
  // #1102: the upgrade-manifest gate. Every targeted run also runs the gate itself.
  'scripts/release/check-upgrade-manifest.mjs': { tests: ['scripts/release/check-upgrade-manifest.test.mjs'] },
  'scripts/release/check-upgrade-manifest.test.mjs': { tests: ['scripts/release/check-upgrade-manifest.test.mjs'] },
  'scripts/release/upgrade-manifest/dts-surface.mjs': { tests: ['scripts/release/check-upgrade-manifest.test.mjs'] },
  'scripts/release/upgrade-manifest/manifest.mjs': { tests: ['scripts/release/check-upgrade-manifest.test.mjs'] },
  'scripts/release/upgrade-manifest/snapshot.mjs': { tests: ['scripts/release/check-upgrade-manifest.test.mjs'] },
});
// An OAR or rpiv-todo re-vendor adds one snapshot directory and deletes the
// previous one. A snapshot path is reviewed only when that snapshot's
// source-manifest.json lists it (or is that manifest or its PROVENANCE.md):
// read from the checkout, or from the exact comparison base for a deleted
// snapshot. Any other path under those vendor roots still refuses.
function vendorSnapshotListed(path, pattern, packageName, { base, cwd = process.cwd() } = {}) {
  const match = pattern.exec(path);
  if (!match) return false;
  const manifestPath = `${match[1]}/source-manifest.json`;
  let text;
  if (existsSync(resolve(cwd, manifestPath))) text = readFileSync(resolve(cwd, manifestPath), 'utf8');
  else if (/^[a-f0-9]{40}$/.test(base ?? '') && !/^0+$/.test(base)) {
    try {
      text = execFileSync('git', ['show', `${base}:${manifestPath}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return false; }
  } else return false;
  const manifest = JSON.parse(text);
  return manifest.format === 'byok.vendor-source' && manifest.package === packageName && Array.isArray(manifest.files)
    && (manifest.files.some(row => row.path === match[2]) || match[2] === 'source-manifest.json' || match[2] === 'PROVENANCE.md');
}
function oarSnapshotListed(path, context) {
  return vendorSnapshotListed(path, /^(packages\/client\/vendor\/oar\/[a-f0-9]{7,40})\/(.+)$/, '@botiverse/oar', context);
}
function todoSnapshotListed(path, context) {
  return vendorSnapshotListed(path, /^(packages\/client\/vendor\/rpiv-todo\/\d+\.\d+\.\d+)\/(.+)$/, '@juicesharp/rpiv-todo', context);
}
// #1030: the workspaces whose vitest.config.ts uses scripts/vitest/tmp-root.mjs.
export const vitestTmpRootConsumers = Object.freeze([
  'examples/basic', 'examples/bot-collaboration', 'examples/byok-mcp-server', 'examples/codex-interaction-host',
  'examples/host-execution-core', 'examples/hosted-bot-collaboration', 'examples/hosted-bot-collaboration-worker',
  'packages/client', 'packages/cloud-dataplane', 'packages/cloud-do', 'packages/keys', 'packages/server',
]);
// Reviewed M build inputs: exact paths retain workspace consumers and packed-artifact checks.
const reviewedBuildConfigOwners = Object.freeze({
  'packages/client/tsup.sealed.config.ts': 'packages/client',
  'packages/cloud-dataplane/tsup.config.ts': 'packages/cloud-dataplane',
  'packages/cloud-do/tsup.config.ts': 'packages/cloud-do',
  'packages/cloud/tsup.config.ts': 'packages/cloud',
  'packages/protocol/tsup.config.ts': 'packages/protocol',
  'packages/server/tsup.config.ts': 'packages/server',
  'packages/testkit/tsup.config.ts': 'packages/testkit',
  'packages/ui-runtime/tsup.config.ts': 'packages/ui-runtime',
});
const rootDocs = new Set(['README.md', 'CHANGELOG.md', 'AGENTS.md', 'CLAUDE.md', 'packages/AGENTS.md', 'packages/CLAUDE.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md']);
// #605 W5: w5-runner-probe.yml is workflow_dispatch only and reads no repo
// file, so like release.yml it selects only the CI script checks.
// #1103: runtime-contract-nightly.yml runs on a schedule against the latest CLIs; it never gates a PR.
const rootCi = new Set(['.github/workflows/ci.yml', '.github/workflows/release.yml', '.github/workflows/w5-runner-probe.yml',
  '.github/workflows/runtime-contract-nightly.yml']);
const sorted = values => [...values].sort();
// An unmapped path is a selector gap. Fix it with a reviewed mapping; a
// feature PR never falls back to the complete release matrix.
function requireMapping(path) {
  throw new Error(`Reviewed CI mapping required: unmapped or broad-impact path ${JSON.stringify(path)}; add it to scripts/ci/select-impact.mjs`);
}

/** Deleted paths remain inputs. Never silently convert unknown impact to a full run. */
export function selectImpact(paths, context = {}) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('Changed paths must be a nonempty JSON array; reviewed CI mapping required');
  const files = new Set();
  const dirs = new Set();
  const leafDirs = new Set();
  const families = new Set();
  let scripts = false;
  for (const path of paths) {
    if (typeof path !== 'string' || !path || /[\\\x00-\x1f\x7f]/.test(path)
      || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) requireMapping(path);
    files.add(path);
    let owned = false;
    if (!path.endsWith('.md')) {
      for (const [id, owners] of Object.entries(familyOwners)) {
        if (owners.some(owner => owner.test(path))) { families.add(id); owned = true; }
      }
    }
    if (path === '.gitattributes') {
      verifyReviewedContent(path, context);
      dirs.add('packages/client');
      for (const id of ['npm-release-pack', 'agent-memory-helper', 'agent-memory-helper-non-darwin']) families.add(id);
      continue;
    }
    // #702: the Node pin is the runtime of every platform job, so a reviewed
    // exact version selects every routine family. The complete test suite
    // stays release-validation only.
    if (path === '.node-version') {
      verifyReviewedContent(path, context);
      for (const id of knownFamilies) if (id !== 'build-test') families.add(id);
      continue;
    }
    if (path === 'packages/protocol/src/__tests__/golden/v3.releases.json') { leafDirs.add('packages/protocol'); continue; }
    if (path === 'package.json' || path === 'bun.lock' || /^packages\/[^/]+\/package\.json$/.test(path)) {
      // A reviewed dependency move also runs the suites of the workspaces that declare it.
      for (const dir of verifyReviewedContent(path, context)) dirs.add(dir);
      if (path === 'package.json') { scripts = true; continue; }
      if (path === 'bun.lock') { families.add('npm-release-pack'); continue; }
      const dir = path.slice(0, -'/package.json'.length);
      if (!workspaceGraph[dir]) requireMapping(path);
      families.add('npm-release-pack'); continue;
    }
    if (path === 'examples/bot-collaboration/package.json') {
      verifyReviewedContent(path, context);
      dirs.add('examples/bot-collaboration'); continue;
    }
    // #884: the private K4 manifest, checked by its reviewed shape. Its suite and the suites of its dependents run.
    if (path === 'examples/host-execution-core/package.json') {
      verifyReviewedContent(path, context);
      dirs.add('examples/host-execution-core'); continue;
    }
    // #793 D2: the private hosted example manifest, checked by its reviewed shape.
    if (path === 'examples/hosted-bot-collaboration/package.json') {
      verifyReviewedContent(path, context);
      dirs.add('examples/hosted-bot-collaboration'); continue;
    }
    // #794 D3: the private Worker composition of H, checked by the same reviewed shape.
    if (path === 'examples/hosted-bot-collaboration-worker/package.json') {
      verifyReviewedContent(path, context);
      dirs.add('examples/hosted-bot-collaboration-worker'); continue;
    }
    // These root-level fixtures are executed by the relocated native SEA smoke.
    if (path === 'examples/packaging/native-assets-fixture.ts' || path === 'examples/packaging/native-assets-smoke.mjs') {
      dirs.add('examples/packaging'); families.add('packageability-smoke'); continue;
    }
    // SQLite ESM/CJS and relocated SEA probes share the packaging smoke owner.
    if (path === 'examples/packaging/sqlite-fixture.ts' || path === 'examples/packaging/sqlite-smoke.mjs') {
      dirs.add('examples/packaging'); families.add('packageability-smoke'); continue;
    }
    // Both packaging recipes compile this launcher; the packageability smoke runs it.
    if (path === 'examples/packaging/launcher.ts') {
      dirs.add('examples/packaging'); families.add('packageability-smoke'); continue;
    }
    if (path === 'examples/basic/goal-btw.test-support.ts') {
      // Shared runtime fixture is imported directly across these example suites.
      for (const dir of ['examples/basic', 'examples/host-execution-core', 'examples/bot-collaboration']) dirs.add(dir);
      continue;
    }
    if (path === 'examples/basic/clarification.ts' || path === 'examples/basic/clarification.test.ts'
      || path === 'examples/basic/goal-btw.ts' || path === 'examples/basic/goal-btw.test.ts' || path === 'examples/basic/goal-btw-close.test.ts'
      || path === 'examples/basic/quickstart-smoke.test.ts' || path === 'examples/basic/server.ts'
      || path === 'examples/basic/task-events-route.ts' || path === 'examples/basic/task-events-route.test.ts') {
      dirs.add('examples/basic'); continue;
    }
    // The example page; page-runtimes.test.ts checks its DOM.
    if (path === 'examples/basic/public/index.html') { dirs.add('examples/basic'); continue; }
    // The usage notes of the clarification and goal/btw examples.
    if (path === 'examples/basic/clarification-usage.md' || path === 'examples/basic/goal-btw-usage.md') { dirs.add('examples/basic'); continue; }
    // #1061: Codex reference Host fixture (questions-only after native permission fold).
    if (path === 'examples/codex-interaction-host/fixtures/fake-codex.mjs') {
      dirs.add('examples/codex-interaction-host'); continue;
    }
    // The Salesko recovery integration fixture runs the client daemon; no CI job runs scripts/integration.
    if (path === 'scripts/integration/fixtures/salesko-recurring-daemon.ts' || path === 'scripts/integration/salesko-recurring.test.ts') {
      dirs.add('packages/client'); continue;
    }
    // Shared by client fixtures and their dependent examples, plus the built
    // adapter and packaging smokes that import this backend directly.
    if (path === 'scripts/testing/device-credentials.mjs') {
      dirs.add('packages/client');
      families.add('adapter-lifecycle-smoke'); families.add('packageability-smoke');
      continue;
    }
    if (path === 'api-surface/entries.json') {
      for (const dir of changedApiOwners(context)) {
        if (!workspaceGraph[dir]) requireMapping(path);
        dirs.add(dir);
      }
      continue;
    }
    if (Object.hasOwn(reviewedBuildConfigOwners, path)) {
      dirs.add(reviewedBuildConfigOwners[path]); families.add('npm-release-pack'); continue;
    }
    // Client build inputs: the entry checks, the main build config, the sealed
    // host build check and the retired vendored-subagents build plugin.
    if (path === 'packages/client/scripts/check-hermes-session-entry.mjs' || path === 'packages/client/scripts/check-adapters-entry.mjs'
      || path === 'packages/client/tsup.config.ts' || path === 'packages/client/scripts/build-sealed-host.mjs'
      || path === 'packages/client/scripts/subagents-build.ts') {
      dirs.add('packages/client'); families.add('npm-release-pack'); continue;
    }
    // #636: the keys pi-catalog subpath entry, and the generator that keys
    // source imports and the client drift test re-runs.
    if (path === 'packages/keys/tsup.config.ts') { dirs.add('packages/keys'); families.add('npm-release-pack'); continue; }
    // #654: the core sealed-payload subpath entry.
    if (path === 'packages/core/tsup.config.ts') { dirs.add('packages/core'); families.add('npm-release-pack'); continue; }
    if (path === 'scripts/keys/generate-pi-model-catalog.ts') { dirs.add('packages/keys'); dirs.add('packages/client'); continue; }
    // The generated Pi defaults: keys source, and the client drift test re-renders them.
    if (path === 'packages/keys/src/pi-runtime-defaults.generated.ts') { dirs.add('packages/keys'); dirs.add('packages/client'); continue; }
    // pack-and-smoke.mjs runs it against the packed client.
    if (path === 'packages/client/scripts/packed-cli-mcp-smoke.mjs' || path === 'packages/client/scripts/fixtures/packed-cli-mcp-codex.mjs') {
      dirs.add('packages/client'); families.add('npm-release-pack'); continue;
    }
    if (path === 'packages/client/scripts/packed-agent-memory-helper-smoke.mjs'
      || path === 'scripts/release/agent-memory-helper-source.test.mjs') {
      dirs.add('packages/client'); families.add('npm-release-pack'); continue;
    }
    if (/^scripts\/release\/registry-(?:contract\.test\.mjs|expectations\.json)$/.test(path)) { scripts = true; continue; }
    // #1102: the released baseline snapshot, and the manifest the client
    // tarball ships. The targeted job's gate step reads both.
    if (path === 'scripts/release/upgrade-manifest/baseline.json') { scripts = true; continue; }
    if (path === 'packages/client/upgrade-manifest.json') { scripts = true; families.add('npm-release-pack'); continue; }
    // #1102: the store precheck fixtures, their index and generator. The server,
    // keys and client suites check every fixture against its `expected` verdicts.
    if (/^scripts\/release\/fixtures\/stores\/(?:generate\.mjs|index\.json|(?:\d+\.\d+\.\d+|main)\/[a-z0-9/-]+\.(?:db|sqlite))$/.test(path)) {
      dirs.add('packages/server'); dirs.add('packages/keys'); dirs.add('packages/client'); continue;
    }
    // #1094: the generated DaemonConfig schema. The client drift test regenerates
    // it, the upgrade-manifest gate reads its config:<field> items, and the tarball ships it.
    if (path === 'packages/client/daemon-config.schema.json') {
      dirs.add('packages/client'); scripts = true; families.add('npm-release-pack'); continue;
    }
    if (Object.hasOwn(reviewedScripts, path)) {
      scripts = true;
      for (const id of reviewedScripts[path].families ?? []) families.add(id);
      continue;
    }
    // #652 trims these reviewed files in the pinned OAR snapshot.
    if (/^packages\/client\/vendor\/oar\/51b83c9\/(?:runtimes\/codex\/(?:app-server-client|rpc-control|session)|shared\/(?:acp\/session|session-kernel))\.ts$/.test(path)) {
      dirs.add('packages/client'); continue;
    }
    if (/^packages\/client\/vendor\/oar\/[a-f0-9]{7,40}\/(?:PROVENANCE\.md|source-manifest\.json|runtimes\/grok\/session\.ts)$/.test(path)) {
      dirs.add('packages/client'); continue;
    }
    if (oarSnapshotListed(path, context)) { dirs.add('packages/client'); continue; }
    // The private todo build bundles the vendored rpiv-todo snapshot and packs its locale assets.
    if (todoSnapshotListed(path, context)) { dirs.add('packages/client'); families.add('npm-release-pack'); continue; }
    // The client build copies vendor notices and OAR provenance into dist.
    if (path === 'packages/client/scripts/build-todo-assets.mjs' || path === 'packages/client/vendor/THIRD-PARTY.md' || path === 'packages/client/vendor/third-party-manifest.json') {
      dirs.add('packages/client'); families.add('npm-release-pack'); continue;
    }
    // The OAR bridge contract: run-targeted runs check-oar-bridge.test.mjs
    // (it typechecks oar-bridge-types.ts) against the installed client.
    if (/^scripts\/api-surface\/(?:check-oar-bridge\.test\.mjs|oar-bridge-types\.ts|tsconfig\.oar-bridge\.json)$/.test(path)) {
      dirs.add('packages/client'); continue;
    }
    // Opt-in Codex probes select their client runtime owner; CI does not invoke the probes.
    if (path === 'packages/client/scripts/codex-app-server-real.mjs'
      || path === 'packages/client/scripts/codex-reserved-mcp-loopback.mjs') { dirs.add('packages/client'); continue; }
    // #701: the retired vendored pi-subagents 0.60.0 snapshot. The client now
    // depends on the installed package; only this snapshot's deletion remains.
    if (/^packages\/client\/vendor\/pi-subagents\/0\.60\.0\/(?:index\.ts|LICENSE|package\.json|PROVENANCE\.md|source-manifest\.json|src\/.+\.ts)$/.test(path)) {
      dirs.add('packages/client'); continue;
    }
    if (path === 'examples/host-execution-core/VALIDATION.md'
      || path === 'examples/bot-collaboration/VALIDATION.md'
      || path === 'examples/host-execution-core/PLAN-612.md'
      || path === 'templates/service/README.md'
      || /^examples\/byok-mcp-server\/docs\/[a-z0-9-]+\.md$/.test(path)) continue;

    if (path === 'scripts/ci/run-windows-bot-tests.mjs') {
      families.add('adapter-lifecycle-smoke'); continue;
    }
    // #654: the dataplane job runs hosted-plaintext-inventory.test.ts, which
    // checks the inventory table in this doc against real Postgres and S3.
    if (path === 'docs/device-setup.md') { dirs.add('packages/client'); continue; }
    if (path === 'docs/security.md') { families.add('dataplane'); continue; }
    // #654 E2c: `deploy/sql` is the only authored copy of the Postgres
    // migrations. cloud-dataplane builds it into `dist/sql`, its suites migrate
    // from it, and the packed tarball must carry it and migrate a database.
    if (/^deploy\/sql\/\d{4}_[a-z0-9_]+\.sql$/.test(path)) {
      dirs.add('packages/cloud-dataplane');
      families.add('dataplane'); families.add('release-pack-migrate');
      continue;
    }
    // The cloud-dataplane invariant suites run this file after migrating.
    if (path === 'tests/sql/control_plane_invariants.sql') { dirs.add('packages/cloud-dataplane'); continue; }
    if (path === '.gitignore' || rootDocs.has(path) || /^(docs|tasks|deploy\/runbooks)\/.+\.md$/.test(path)) continue;
    // W7: a ci.yml change can change any family job, so it selects every
    // routine family. The client suite also runs: two of its tests read this
    // workflow. The complete test suite stays release-validation only.
    if (path === '.github/workflows/ci.yml') {
      scripts = true; dirs.add('packages/client');
      for (const id of knownFamilies) if (id !== 'build-test') families.add(id);
      continue;
    }
    // W7: agent-memory-windows.yml is removed. Its checks run in the
    // agent-memory-helper jobs of ci.yml, so the path selects those families.
    if (path === '.github/workflows/agent-memory-windows.yml') {
      families.add('agent-memory-helper'); families.add('agent-memory-helper-non-darwin'); continue;
    }
    // #1030: the shared vitest globalSetup. A change reruns every consumer's
    // suite and each family with a windows-latest vitest leg, the only legs that
    // run its win32 branch. run-targeted.mjs runs its own test for either path.
    if (path === 'scripts/vitest/tmp-root.mjs') {
      for (const dir of vitestTmpRootConsumers) dirs.add(dir);
      for (const id of ['adapter-lifecycle-smoke', 'agent-memory-helper', 'hermes-real-windows', 'ipc-smoke', 'npm-release-pack',
        'packageability-smoke', 'windows-client']) families.add(id);
      continue;
    }
    if (path === 'scripts/vitest/tmp-root.test.mjs') { scripts = true; continue; }
    if (rootCi.has(path) || /^scripts\/ci\/[a-z0-9-]+(?:\.test)?\.mjs$/.test(path)) { scripts = true; continue; }
    const golden = /^api-surface\/([a-z-]+)\.d\.ts$/.exec(path);
    if (golden) {
      const dir = `packages/${golden[1]}`;
      if (!workspaceGraph[dir]) requireMapping(path);
      dirs.add(dir); continue;
    }
    const template = /^templates\/(packaging\/(sea|bun)|service\/(winsw|launchd|systemd))\//.exec(path);
    if (template) {
      if (path.endsWith('/README.md')) continue;
      if (!/\.(?:mjs|js|sh|xml|plist|service)$/.test(path)) requireMapping(path);
      dirs.add('packages/client');
      families.add('packageability-smoke'); families.add('npm-release-pack');
      if (template[3] === 'winsw') families.add('windows-service-smoke');
      continue;
    }
    const match = /^(packages|examples)\/([^/]+)\/(.+)$/.exec(path);
    if (!match) requireMapping(path);
    const dir = `${match[1]}/${match[2]}`;
    const relative = match[3];
    if (!workspaceGraph[dir]) requireMapping(path);
    if (/^(?:README|AGENTS|CLAUDE)\.md$/.test(relative)) continue;
    if (/^(?:tsconfig(?:\.[a-z-]+)?\.json|vitest\.config\.[cm]?ts)$/.test(relative)) { dirs.add(dir); continue; }
    if (dir === 'packages/client' && /^native\/agent-memory-fs\/.+\.(?:go|mod|sum)$/.test(relative)) {
      dirs.add(dir); families.add('npm-release-pack'); continue;
    }
    if (dir === 'packages/client' && /^scripts\/(?:(?:build|check|verify|copy)-agent-memory-helper[^/]*|agent-memory-helper-source)\.[cm]?[jt]s$/.test(relative)) {
      dirs.add(dir); families.add('npm-release-pack'); continue;
    }
    // A workspace smoke script is accepted only when a platform family owns it.
    if (owned && /^scripts\/[a-z0-9-]+\.mjs$/.test(relative)) {
      dirs.add(dir);
      if (dir === 'examples/packaging') families.add('npm-release-pack');
      continue;
    }
    if (!/^(?:src|test|tests|migrations)\//.test(relative)
      || !/\.(?:[cm]?[jt]sx?|json|ndjson|sql|sh|go|txt|md)$/.test(relative)) requireMapping(path);
    dirs.add(dir);
    if (dir === 'examples/packaging') { families.add('packageability-smoke'); families.add('npm-release-pack'); }
    if (/\.sql$/.test(relative) || /(?:migrat(?:e|ion)|schema)/i.test(relative)) {
      families.add('dataplane'); families.add('release-pack-migrate');
    }
  }
  // Related-file discovery cannot reliably follow dependencies imported from dist.
  // Select complete owning and transitive dependent workspace suites instead.
  let changed = true;
  while (changed) {
    changed = false;
    const impacted = new Set([...dirs].map(dir => workspaceGraph[dir].name));
    for (const [dir, info] of Object.entries(workspaceGraph)) {
      if (!dirs.has(dir) && info.dependencies.some(name => impacted.has(name))) {
        dirs.add(dir); changed = true;
      }
    }
  }
  for (const dir of leafDirs) dirs.add(dir);
  // #793 O5: the hosted example also runs in the dataplane job, the only job with a real Postgres.
  // #794 D3: so does its Worker composition, which needs that Postgres and wrangler.
  if (dirs.has('packages/cloud-dataplane') || dirs.has('packages/conformance') || dirs.has('examples/hosted-bot-collaboration')
    || dirs.has('examples/hosted-bot-collaboration-worker')) families.add('dataplane');
  return { dirs: sorted(dirs), files: sorted(files), families: sorted(families),
    reason: dirs.size || families.size ? 'impacted' : scripts ? 'root-ci-scripts' : 'docs-only' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: select-impact.mjs [changed-paths.json] (otherwise JSON stdin)');
    console.log(JSON.stringify(selectImpact(JSON.parse(readFileSync(process.argv[2] ?? 0, 'utf8')), { base: process.env.CI_BASE })));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
