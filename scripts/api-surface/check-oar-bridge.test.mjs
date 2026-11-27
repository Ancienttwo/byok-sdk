// Keep this check at root, outside package source and declaration build roots.
// It compares the private JS/declaration bridge with vendor and SDK source types.
// The SDK projection imports built protocol types, so run after `bun run build`.
// On re-vendor, update the 223703d pins together in these files:
// packages/client/src/runtime/codex-session-runtime.js,
// packages/client/src/runtime/oar-process-tree.js,
// packages/client/src/runtime/acp-session-runtime.js,
// packages/client/src/runtime/dsh-session-runtime.js,
// packages/client/src/runtime/claude-session-runtime.js,
// packages/client/src/runtime/oar-failure-runtime.js,
// packages/client/src/runtime/oar-suggested-versions.js,
// packages/client/src/runtime/compare-runtime-semver.js, this test, and
// scripts/api-surface/oar-bridge-types.ts.
// The bridge is outside the API golden. New type exports need explicit checks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);

test('OAR JS bridge re-exports the checked vendored codexSession and SessionNotFoundError', () => {
  const source = readFileSync(path.join(repoRoot, 'packages/client/src/runtime/codex-session-runtime.js'), 'utf8');
  const { body } = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  assert.equal(body.length, 8, 'OAR JS bridge must have exactly eight checked re-exports');
  const reexports = body.map((statement) => {
    assert.equal(statement.type, 'ExportNamedDeclaration');
    return [
      statement.source?.value,
      statement.specifiers.map(({ local, exported }) => [local.name, exported.name]),
    ];
  });
  assert.deepEqual(reexports, [
    ['../../vendor/oar/223703d/runtimes/codex/app-server-client.js', [['startAppServerClient', 'startAppServerClient']]],
    ['../../vendor/oar/223703d/runtimes/codex/session.js', [['codexSession', 'codexSession']]],
    ['../../vendor/oar/223703d/contracts/session-not-found-error.js', [['SessionNotFoundError', 'SessionNotFoundError']]],
    ['../../vendor/oar/223703d/contracts/session-unavailable-error.js', [['SessionUnavailableError', 'SessionUnavailableError']]],
    ['../../vendor/oar/223703d/contracts/runtime-failure-error.js', [['RuntimeFailureError', 'RuntimeFailureError']]],
    ['../../vendor/oar/223703d/contracts/errors.js', [['UnsupportedOptionError', 'UnsupportedOptionError']]],
    ['../../vendor/oar/223703d/contracts/model-confirmation-error.js', [['ModelConfirmationError', 'ModelConfirmationError']]],
    ['../../vendor/oar/223703d/runtimes/codex/session.js', [['codexSessionCapabilities', 'codexSessionCapabilities']]],
  ]);
});

test('the OAR SemVer bridge loads in strip-only Node', () => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    "import { compareRuntimeSemver } from './packages/client/src/runtime/compare-runtime-semver.js'; " +
    "if (!(compareRuntimeSemver('0.2.1-rc.5', '0.2.1') < 0)) process.exitCode = 1;",
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('OAR suggested-versions bridge re-exports the checked vendored API', () => {
  const source = readFileSync(path.join(repoRoot, 'packages/client/src/runtime/oar-suggested-versions.js'), 'utf8');
  const { body } = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  assert.deepEqual(body.map(statement => {
    assert.equal(statement.type, 'ExportNamedDeclaration');
    return [statement.source?.value, statement.specifiers.map(({ local, exported }) => [local.name, exported.name])];
  }), [
    ['../../vendor/oar/223703d/suggested-versions.js', [
      ['SUGGESTED_VERSIONS_URL', 'SUGGESTED_RUNTIME_VERSIONS_URL'],
      ['suggestedVersions', 'suggestedRuntimeVersions'],
      ['parseSuggestedVersions', 'parseSuggestedRuntimeVersions'],
      ['checkSuggestedVersion', 'checkSuggestedVersion'],
    ]],
  ]);
});

test('OAR process-tree JS bridge re-exports the checked vendored functions', () => {
  const source = readFileSync(path.join(repoRoot, 'packages/client/src/runtime/oar-process-tree.js'), 'utf8');
  const { body } = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  assert.deepEqual(body.map(statement => {
    assert.equal(statement.type, 'ExportNamedDeclaration');
    return [statement.source?.value, statement.specifiers.map(({ local, exported }) => [local.name, exported.name])];
  }), [
    ['../../vendor/oar/223703d/shared/executable/process-tree.js', [
      ['descendantsOf', 'descendantsOf'], ['killEntries', 'killEntries'], ['observeProcessTable', 'observeProcessTable'],
      ['parseProcessPs', 'parseProcessPs'], ['readProcessTable', 'readProcessTable'],
    ]],
    ['../../vendor/oar/223703d/shared/executable/pipe-close.js', [['PIPE_CLOSE_MS', 'PIPE_CLOSE_MS'], ['closePipesAfterExit', 'closePipesAfterExit']]],
    ['../../vendor/oar/223703d/shared/executable/query.js', [['withQueryDeadline', 'withQueryDeadline']]],
  ]);
});

test('ACP JS bridge re-exports the checked vendored and BYOK values', () => {
  const source = readFileSync(path.join(repoRoot, 'packages/client/src/runtime/acp-session-runtime.js'), 'utf8');
  const { body } = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const reexports = body.map((statement) => {
    assert.equal(statement.type, 'ExportNamedDeclaration');
    return [
      statement.source?.value,
      statement.specifiers.map(({ local, exported }) => [local.name, exported.name]),
    ];
  });
  assert.deepEqual(reexports, [
    ['../../vendor/oar/223703d/shared/acp/errors.js', [['AcpError', 'AcpError']]],
    ['../../vendor/oar/223703d/contracts/session-not-found-error.js', [['SessionNotFoundError', 'SessionNotFoundError']]],
    ['../../vendor/oar/223703d/contracts/runtime-failure-error.js', [['RuntimeFailureError', 'RuntimeFailureError']]],
    ['../../vendor/oar/223703d/contracts/errors.js', [['UnsupportedOptionError', 'UnsupportedOptionError']]],
    ['../../vendor/oar/223703d/contracts/model-confirmation-error.js', [['ModelConfirmationError', 'ModelConfirmationError']]],
    ['../../vendor/oar/223703d/runtimes/grok/session.js', [['grokSession', 'grokSession']]],
    ['../../vendor/oar/223703d/runtimes/antigravity/session.js', [['antigravitySession', 'antigravitySession']]],
    ['../../vendor/oar/223703d/runtimes/opencode/session.js', [['opencodeSession', 'opencodeSession']]],
    ['./cursor-acp-profile.js', [['cursorSession', 'cursorSession']]],
    ['./cursor-list-models.js', [['cursorListModels', 'cursorListModels']]],
    ['../../vendor/oar/223703d/contracts/session-unavailable-error.js', [['SessionUnavailableError', 'SessionUnavailableError']]],
    ['../../vendor/oar/223703d/runtimes/grok/list-models.js', [['grokListModels', 'grokListModels']]],
    ['../../vendor/oar/223703d/runtimes/grok/account-usage.js', [['grokAccountUsage', 'grokAccountUsage']]],
    ['../../vendor/oar/223703d/runtimes/antigravity/list-models.js', [['antigravityListModels', 'antigravityListModels']]],
    ['../../vendor/oar/223703d/runtimes/antigravity/session.js', [['antigravitySessionCapabilities', 'antigravitySessionCapabilities']]],
    ['../../vendor/oar/223703d/runtimes/grok/session.js', [['grokSessionCapabilities', 'grokSessionCapabilities']]],
    ['../../vendor/oar/223703d/runtimes/opencode/version.js', [['opencodeSessionCapabilities', 'opencodeSessionCapabilities']]],
  ]);
});

test('OAR dsh JS bridge re-exports the checked vendored values', () => {
  const source = readFileSync(path.join(repoRoot, 'packages/client/src/runtime/dsh-session-runtime.js'), 'utf8');
  const { body } = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const reexports = body.map((statement) => {
    assert.equal(statement.type, 'ExportNamedDeclaration');
    return [
      statement.source?.value,
      statement.specifiers.map(({ local, exported }) => [local.name, exported.name]),
    ];
  });
  assert.deepEqual(reexports, [
    ['../../vendor/oar/223703d/runtimes/dsh/mcp.js', [['dshMcpConfigs', 'dshMcpConfigs']]],
    ['../../vendor/oar/223703d/runtimes/dsh/session.js', [['dshSession', 'dshSession']]],
    ['../../vendor/oar/223703d/contracts/session-not-found-error.js', [['SessionNotFoundError', 'SessionNotFoundError']]],
    ['../../vendor/oar/223703d/contracts/runtime-failure-error.js', [['RuntimeFailureError', 'RuntimeFailureError']]],
    ['../../vendor/oar/223703d/contracts/errors.js', [['UnsupportedOptionError', 'UnsupportedOptionError']]],
    ['../../vendor/oar/223703d/contracts/model-confirmation-error.js', [['ModelConfirmationError', 'ModelConfirmationError']]],
    ['../../vendor/oar/223703d/contracts/session-unavailable-error.js', [['SessionUnavailableError', 'SessionUnavailableError']]],
    ['../../vendor/oar/223703d/runtimes/dsh/session.js', [['dshSessionCapabilities', 'dshSessionCapabilities']]],
  ]);
});

test('OAR failure JS bridge re-exports the checked vendored failure tables', () => {
  const source = readFileSync(path.join(repoRoot, 'packages/client/src/runtime/oar-failure-runtime.js'), 'utf8');
  const { body } = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const reexports = body.map((statement) => {
    assert.equal(statement.type, 'ExportNamedDeclaration');
    return [
      statement.source?.value,
      statement.specifiers.map(({ local, exported }) => [local.name, exported.name]),
    ];
  });
  assert.deepEqual(reexports, [
    ['../../vendor/oar/223703d/shared/failure-class.js', [['failureFromStatus', 'failureFromStatus']]],
  ]);
});

test('OAR Claude JS bridge re-exports the checked stream-json session and Claude projection', () => {
  const source = readFileSync(path.join(repoRoot, 'packages/client/src/runtime/claude-session-runtime.js'), 'utf8');
  const { body } = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const reexports = body.map((statement) => {
    assert.equal(statement.type, 'ExportNamedDeclaration');
    return [statement.source?.value, statement.specifiers.map(({ local, exported }) => [local.name, exported.name])];
  });
  assert.deepEqual(reexports, [
    ['../../vendor/oar/223703d/shared/stream-json/session.js', [['streamJsonSession', 'streamJsonSession']]],
    ['../../vendor/oar/223703d/runtimes/claude/projection.js', [
      ['claudeProjectionProfile', 'claudeProjectionProfile'], ['initialClaudeProjection', 'initialClaudeProjection'], ['resumedClaudeProjection', 'resumedClaudeProjection'],
    ]],
    ['../../vendor/oar/223703d/shared/credential-redactor.js', [['sessionCredentialRedactor', 'sessionCredentialRedactor']]],
    ['../../vendor/oar/223703d/shared/stream-json/session.js', [['claudeSessionCapabilities', 'claudeSessionCapabilities']]],
    ['../../vendor/oar/223703d/runtimes/claude/service-tier.js', [
      ['claudeServiceTierSettings', 'claudeServiceTierSettings'],
      ['claudeServiceTierRefusal', 'claudeServiceTierRefusal'],
      ['claudeServiceTierEvents', 'claudeServiceTierEvents'],
    ]],
  ]);
});

test('OAR declaration bridge matches the vendor types and BYOK consumers', () => {
  const result = spawnSync(process.execPath, [
    path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
    '--project', 'scripts/api-surface/tsconfig.oar-bridge.json',
    '--pretty', 'false',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, [
    'OAR declaration bridge drift: check scripts/api-surface/oar-bridge-types.ts.',
    result.error?.message,
    result.stdout,
    result.stderr,
  ].filter(Boolean).join('\n'));
});
