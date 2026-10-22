import { readFileSync } from 'node:fs';
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
  'build-test', 'agent-memory-export-linux', 'agent-memory-helper-linux', 'agent-memory-helper',
  'execution-recovery-native', 'adapter-lifecycle-smoke', 'dataplane',
  'windows-git-workspace', 'packageability-smoke', 'npm-release-pack',
  'release-pack-migrate', 'windows-service-smoke', 'ipc-smoke', 'credential-isolation-audit',
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
    /^examples\/host-execution-core\/src\/memory\.ts$/,
    /^examples\/host-execution-core\/src\/memory-restore\.ts$/,
    /^examples\/host-execution-core\/src\/memory-restore\.test\.ts$/,
    /^examples\/host-execution-core\/src\/memory-linux\.test\.ts$/,
    /^packages\/client\/src\/daemon\/agent-memory-(?:export|filesystem|fs-helper)\.ts$/,
    /^packages\/client\/src\/__tests__\/agent-memory-export[^/]*$/,
  ],
  'agent-memory-helper-linux': [
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
    /^examples\/basic\/goal-btw\.test-support\.ts$/,
    /^scripts\/ci\/run-windows-bot-tests\.mjs$/,
    /^packages\/keys\/src\/(?:windows-credential-custody[^/]*|(?:windows-credential-manager|device-sealing-key|sealed-provisioning|pi-provider-launcher-core|provider-profile|secret-store|sqlite-profile-store|command-runner)\.ts)$/,
  ],
  'windows-git-workspace': [
    /^packages\/client\/src\/daemon\/(?:git-workspace|git-workspace-store|session-workspace-store|auth-manager|daemon-lifecycle|daemon-owner|daemon-record)\.ts$/,
    /^packages\/client\/src\/(?:util\/(?:secure-dir|atomic-write)\.ts|diagnostics\/|bin\/commands\/)/,
    /^packages\/client\/src\/__tests__\/(?:git-workspace|bin-workspaces|secure-dir|diagnostics|support-bundle|daemon-auth|daemon-stop-shutdown-parity)[^/]*$/,
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
  'credential-isolation-audit': [
    /^packages\/client\/src\/adapters\//,
    /^packages\/client\/vendor\/oar\/[a-f0-9]{7,40}\/(?:runtimes|shared)\//,
    /^packages\/client\/scripts\/(?:credential-audit-core|credential-audit-positive-control|linux-credential-audit|adapter-task-smoke)\.mjs$/,
    /^packages\/keys\/src\//,
  ],
});
// #649: release script paths that the owner reviewed for 0.28.2. `tests` run
// the path (scripts/ci/run-targeted.mjs runs them); `install` marks tests that
// need installed packages, so the targeted job installs first; `families` are
// the jobs that run the path itself.
export const reviewedScripts = Object.freeze({
  'scripts/api-surface/check-version-authority.mjs': { tests: ['scripts/api-surface/check-version-authority.test.mjs'] },
  'scripts/api-surface/check-version-authority.test.mjs': { tests: ['scripts/api-surface/check-version-authority.test.mjs'] },
  'scripts/release/beta-release.test.mjs': { tests: ['scripts/release/beta-release.test.mjs'] },
  'scripts/release/pack-and-smoke.mjs': {
    tests: ['scripts/release/pack-and-smoke.test.mjs', 'scripts/release/agent-memory-helper-source.test.mjs'],
    install: true, families: ['agent-memory-helper', 'dataplane', 'npm-release-pack', 'release-pack-migrate'],
  },
  'scripts/release/pack-and-smoke.test.mjs': { tests: ['scripts/release/pack-and-smoke.test.mjs'], install: true },
  'scripts/release/publish.mjs': {
    tests: [
      'scripts/release/publish.test.mjs', 'scripts/release/publish-recovery.test.mjs', 'scripts/release/beta-release.test.mjs',
      'scripts/release/install-matrix.test.mjs', 'scripts/release/registry-contract.test.mjs', 'scripts/release/agent-memory-helper-source.test.mjs',
    ],
    install: true,
  },
  'scripts/release/registry-readback.mjs': { tests: ['scripts/release/beta-release.test.mjs'] },
});
const rootDocs = new Set(['README.md', 'CHANGELOG.md', 'AGENTS.md', 'CLAUDE.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md']);
const rootCi = new Set(['.github/workflows/ci.yml', '.github/workflows/release.yml']);
// Reviewed release scripts and the families whose jobs run them. The npm
// release pack job runs pack-and-smoke.mjs, which runs the package graph check.
export const reviewedReleaseScripts = Object.freeze({
  'scripts/release/check-package-graph.mjs': Object.freeze(['npm-release-pack']),
});
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
      for (const id of ['npm-release-pack', 'agent-memory-helper', 'agent-memory-helper-linux']) families.add(id);
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
    // These root-level fixtures are executed by the relocated native SEA smoke.
    if (path === 'examples/packaging/native-assets-fixture.ts' || path === 'examples/packaging/native-assets-smoke.mjs') {
      dirs.add('examples/packaging'); families.add('packageability-smoke'); continue;
    }
    // SQLite ESM/CJS and relocated SEA probes share the packaging smoke owner.
    if (path === 'examples/packaging/sqlite-fixture.ts' || path === 'examples/packaging/sqlite-smoke.mjs') {
      dirs.add('examples/packaging'); families.add('packageability-smoke'); continue;
    }
    if (path === 'examples/basic/goal-btw.test-support.ts') {
      // Shared runtime fixture is imported directly across these example suites.
      for (const dir of ['examples/basic', 'examples/host-execution-core', 'examples/bot-collaboration']) dirs.add(dir);
      continue;
    }
    if (path === 'examples/basic/clarification.test.ts' || path === 'examples/basic/goal-btw.test.ts' || path === 'examples/basic/goal-btw-close.test.ts') {
      dirs.add('examples/basic'); continue;
    }
    if (path === 'api-surface/entries.json') {
      for (const dir of changedApiOwners(context)) {
        if (!workspaceGraph[dir]) requireMapping(path);
        dirs.add(dir);
      }
      continue;
    }
    if (path === 'packages/client/scripts/check-hermes-session-entry.mjs' || path === 'packages/client/scripts/check-adapters-entry.mjs'
      || path === 'packages/client/tsup.config.ts') {
      dirs.add('packages/client'); families.add('npm-release-pack'); continue;
    }
    // #636: the keys pi-catalog subpath entry, and the generator that keys
    // source imports and the client drift test re-runs.
    if (path === 'packages/keys/tsup.config.ts') { dirs.add('packages/keys'); families.add('npm-release-pack'); continue; }
    if (path === 'scripts/keys/generate-pi-model-catalog.ts') { dirs.add('packages/keys'); dirs.add('packages/client'); continue; }
    if (path === 'packages/client/scripts/packed-agent-memory-helper-smoke.mjs'
      || path === 'scripts/release/agent-memory-helper-source.test.mjs') {
      dirs.add('packages/client'); families.add('npm-release-pack'); continue;
    }
    if (/^scripts\/release\/registry-(?:contract\.test\.mjs|expectations\.json)$/.test(path)) { scripts = true; continue; }
    if (Object.hasOwn(reviewedScripts, path)) {
      scripts = true;
      for (const id of reviewedScripts[path].families ?? []) families.add(id);
      continue;
    }
    if (Object.hasOwn(reviewedReleaseScripts, path)) {
      for (const id of reviewedReleaseScripts[path]) families.add(id);
      continue;
    }
    // #652 trims these reviewed files in the pinned OAR snapshot.
    if (/^packages\/client\/vendor\/oar\/60ad09b\/(?:runtimes\/codex\/(?:app-server-client|rpc-control|session)|shared\/(?:acp\/session|session-kernel))\.ts$/.test(path)) {
      dirs.add('packages/client'); continue;
    }
    if (/^packages\/client\/vendor\/oar\/[a-f0-9]{7,40}\/(?:PROVENANCE\.md|source-manifest\.json|runtimes\/grok\/session\.ts)$/.test(path)) {
      dirs.add('packages/client'); continue;
    }
    if (path === 'examples/host-execution-core/VALIDATION.md'
      || path === 'examples/bot-collaboration/VALIDATION.md'
      || path === 'examples/host-execution-core/PLAN-612.md') continue;

    if (path === 'scripts/ci/run-windows-bot-tests.mjs') {
      families.add('adapter-lifecycle-smoke'); continue;
    }
    if (rootDocs.has(path) || /^(docs|tasks|deploy\/runbooks)\/.+\.md$/.test(path)) continue;
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
  if (dirs.has('packages/cloud-dataplane') || dirs.has('packages/conformance')) families.add('dataplane');
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
