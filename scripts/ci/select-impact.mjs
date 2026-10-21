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
      "@byok-sdk/client"
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
const clientFamilies = [
  'agent-memory-export-linux',
  'agent-memory-helper-linux', 'agent-memory-helper', 'execution-recovery-native',
  'adapter-lifecycle-smoke', 'windows-git-workspace', 'packageability-smoke',
  'windows-service-smoke', 'ipc-smoke', 'credential-isolation-audit',
];
const rootDocs = new Set(['README.md', 'CHANGELOG.md', 'AGENTS.md', 'CLAUDE.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md']);
const rootCi = new Set(['.github/workflows/ci.yml', '.github/workflows/release.yml']);
const sorted = values => [...values].sort();
function requireRelease(path) {
  throw new Error(`Reviewed release validation required: unmapped or broad-impact path ${JSON.stringify(path)}`);
}

/** Deleted paths remain inputs. Never silently convert unknown impact to a full run. */
export function selectImpact(paths, context = {}) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('Changed paths must be a nonempty JSON array; reviewed release validation required');
  const files = new Set();
  const dirs = new Set();
  const leafDirs = new Set();
  const families = new Set();
  let scripts = false;
  for (const path of paths) {
    if (typeof path !== 'string' || !path || /[\\\x00-\x1f\x7f]/.test(path)
      || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) requireRelease(path);
    files.add(path);
    if (path === '.gitattributes') {
      verifyReviewedContent(path, context);
      dirs.add('packages/client'); families.add('npm-release-pack'); continue;
    }
    if (path === 'packages/protocol/src/__tests__/golden/v3.releases.json') { leafDirs.add('packages/protocol'); continue; }
    if (path === 'package.json' || path === 'bun.lock' || /^packages\/[^/]+\/package\.json$/.test(path)) {
      verifyReviewedContent(path, context);
      if (path === 'package.json') { scripts = true; continue; }
      if (path === 'bun.lock') { families.add('npm-release-pack'); continue; }
      const dir = path.slice(0, -'/package.json'.length);
      if (!workspaceGraph[dir]) requireRelease(path);
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
    if (path === 'examples/basic/goal-btw.test-support.ts') {
      // Shared runtime fixture is imported directly across these example suites.
      for (const dir of ['examples/basic', 'examples/host-execution-core', 'examples/bot-collaboration']) dirs.add(dir);
      continue;
    }
    if (path === 'examples/basic/clarification.test.ts' || path === 'examples/basic/goal-btw.test.ts') {
      dirs.add('examples/basic'); continue;
    }
    if (path === 'api-surface/entries.json') {
      for (const dir of changedApiOwners(context)) {
        if (!workspaceGraph[dir]) requireRelease(path);
        dirs.add(dir);
      }
      continue;
    }
    if (path === 'packages/client/scripts/check-hermes-session-entry.mjs' || path === 'packages/client/tsup.config.ts') {
      dirs.add('packages/client'); families.add('npm-release-pack'); continue;
    }
    if (path === 'packages/client/scripts/packed-agent-memory-helper-smoke.mjs'
      || path === 'scripts/release/agent-memory-helper-source.test.mjs') {
      dirs.add('packages/client'); families.add('npm-release-pack'); continue;
    }
    if (/^scripts\/release\/registry-(?:contract\.test\.mjs|expectations\.json)$/.test(path)) { scripts = true; continue; }
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
      if (!workspaceGraph[dir]) requireRelease(path);
      dirs.add(dir); continue;
    }
    const template = /^templates\/(packaging\/(sea|bun)|service\/(winsw|launchd|systemd))\//.exec(path);
    if (template) {
      if (path.endsWith('/README.md')) continue;
      if (!/\.(?:mjs|js|sh|xml|plist|service)$/.test(path)) requireRelease(path);
      dirs.add('packages/client');
      families.add('packageability-smoke'); families.add('npm-release-pack');
      if (template[3] === 'winsw') families.add('windows-service-smoke');
      continue;
    }
    const match = /^(packages|examples)\/([^/]+)\/(.+)$/.exec(path);
    if (!match) requireRelease(path);
    const dir = `${match[1]}/${match[2]}`;
    const relative = match[3];
    if (!workspaceGraph[dir]) requireRelease(path);
    if (/^(?:README|AGENTS|CLAUDE)\.md$/.test(relative)) continue;
    if (/^(?:tsconfig(?:\.[a-z-]+)?\.json|vitest\.config\.[cm]?ts)$/.test(relative)) { dirs.add(dir); continue; }
    if (dir === 'packages/client' && /^native\/agent-memory-fs\/.+\.(?:go|mod|sum)$/.test(relative)) {
      dirs.add(dir); families.add('npm-release-pack'); continue;
    }
    if (dir === 'packages/client' && /^scripts\/(?:build|check|verify|copy)-agent-memory-helper[^/]*\.[cm]?[jt]s$/.test(relative)) {
      dirs.add(dir); families.add('npm-release-pack'); continue;
    }
    if (!/^(?:src|test|tests|migrations)\//.test(relative)
      || !/\.(?:[cm]?[jt]sx?|json|ndjson|sql|sh|go|txt|md)$/.test(relative)) requireRelease(path);
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
  if (dirs.has('packages/client')) for (const id of clientFamilies) families.add(id);
  if (dirs.has('packages/keys')) for (const id of ['adapter-lifecycle-smoke', 'ipc-smoke', 'credential-isolation-audit']) families.add(id);
  if (dirs.has('packages/cloud-dataplane') || dirs.has('packages/conformance')) families.add('dataplane');
  if (dirs.has('examples/host-execution-core') || dirs.has('examples/bot-collaboration')) families.add('adapter-lifecycle-smoke');
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
