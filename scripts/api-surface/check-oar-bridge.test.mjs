// Keep this check at root, outside package source and declaration build roots.
// It compares the private JS/declaration bridge with vendor and SDK source types.
// The SDK projection imports built protocol types, so run after `bun run build`.
// On re-vendor, update the a122061 pins together in these files:
// packages/client/src/runtime/codex-session-runtime.js,
// packages/client/src/runtime/oar-process-tree.js,
// packages/client/src/runtime/acp-session-runtime.js,
// packages/client/src/runtime/dsh-session-runtime.js,
// packages/client/src/runtime/claude-session-runtime.js,
// packages/client/src/runtime/oar-failure-runtime.js, this test, and
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
  assert.equal(body.length, 7, 'OAR JS bridge must have exactly seven checked re-exports');
  const reexports = body.map((statement) => {
    assert.equal(statement.type, 'ExportNamedDeclaration');
    return [
      statement.source?.value,
      statement.specifiers.map(({ local, exported }) => [local.name, exported.name]),
    ];
  });
  assert.deepEqual(reexports, [
    ['../../vendor/oar/a122061/runtimes/codex/session.js', [['codexSession', 'codexSession']]],
    ['../../vendor/oar/a122061/contracts/session-not-found-error.js', [['SessionNotFoundError', 'SessionNotFoundError']]],
    ['../../vendor/oar/a122061/contracts/session-unavailable-error.js', [['SessionUnavailableError', 'SessionUnavailableError']]],
    ['../../vendor/oar/a122061/contracts/runtime-failure-error.js', [['RuntimeFailureError', 'RuntimeFailureError']]],
    ['../../vendor/oar/a122061/contracts/errors.js', [['UnsupportedOptionError', 'UnsupportedOptionError']]],
    ['../../vendor/oar/a122061/contracts/model-confirmation-error.js', [['ModelConfirmationError', 'ModelConfirmationError']]],
    ['../../vendor/oar/a122061/runtimes/codex/session.js', [['codexSessionCapabilities', 'codexSessionCapabilities']]],
  ]);
});

test('OAR process-tree JS bridge re-exports the checked vendored functions', () => {
  const source = readFileSync(path.join(repoRoot, 'packages/client/src/runtime/oar-process-tree.js'), 'utf8');
  const { body } = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  assert.equal(body.length, 1, 'OAR process-tree bridge must have one checked re-export');
  const statement = body[0];
  assert.equal(statement.type, 'ExportNamedDeclaration');
  assert.equal(statement.source?.value, '../../vendor/oar/a122061/shared/executable/process-tree.js');
  assert.deepEqual(statement.specifiers.map(({ local, exported }) => [local.name, exported.name]), [
    ['descendantsOf', 'descendantsOf'],
    ['killEntries', 'killEntries'],
    ['parseProcessPs', 'parseProcessPs'],
    ['readProcessTable', 'readProcessTable'],
  ]);
});

test('OAR ACP JS bridge re-exports the checked vendored values', () => {
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
    ['../../vendor/oar/a122061/shared/acp/errors.js', [['AcpError', 'AcpError']]],
    ['../../vendor/oar/a122061/contracts/session-not-found-error.js', [['SessionNotFoundError', 'SessionNotFoundError']]],
    ['../../vendor/oar/a122061/contracts/runtime-failure-error.js', [['RuntimeFailureError', 'RuntimeFailureError']]],
    ['../../vendor/oar/a122061/contracts/errors.js', [['UnsupportedOptionError', 'UnsupportedOptionError']]],
    ['../../vendor/oar/a122061/contracts/model-confirmation-error.js', [['ModelConfirmationError', 'ModelConfirmationError']]],
    ['../../vendor/oar/a122061/runtimes/grok/session.js', [['grokSession', 'grokSession']]],
    ['../../vendor/oar/a122061/runtimes/antigravity/session.js', [['antigravitySession', 'antigravitySession']]],
    ['../../vendor/oar/a122061/runtimes/opencode/session.js', [['opencodeSession', 'opencodeSession']]],
    ['../../vendor/oar/a122061/contracts/session-unavailable-error.js', [['SessionUnavailableError', 'SessionUnavailableError']]],
    ['../../vendor/oar/a122061/runtimes/grok/list-models.js', [['grokListModels', 'grokListModels']]],
    ['../../vendor/oar/a122061/runtimes/grok/account-usage.js', [['grokAccountUsage', 'grokAccountUsage']]],
    ['../../vendor/oar/a122061/runtimes/antigravity/list-models.js', [['antigravityListModels', 'antigravityListModels']]],
    ['../../vendor/oar/a122061/runtimes/antigravity/session.js', [['antigravitySessionCapabilities', 'antigravitySessionCapabilities']]],
    ['../../vendor/oar/a122061/runtimes/grok/session.js', [['grokSessionCapabilities', 'grokSessionCapabilities']]],
    ['../../vendor/oar/a122061/runtimes/opencode/version.js', [['opencodeSessionCapabilities', 'opencodeSessionCapabilities']]],
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
    ['../../vendor/oar/a122061/runtimes/dsh/mcp.js', [['dshMcpRows', 'dshMcpRows']]],
    ['../../vendor/oar/a122061/runtimes/dsh/session.js', [['dshSession', 'dshSession']]],
    ['../../vendor/oar/a122061/contracts/session-not-found-error.js', [['SessionNotFoundError', 'SessionNotFoundError']]],
    ['../../vendor/oar/a122061/contracts/runtime-failure-error.js', [['RuntimeFailureError', 'RuntimeFailureError']]],
    ['../../vendor/oar/a122061/contracts/errors.js', [['UnsupportedOptionError', 'UnsupportedOptionError']]],
    ['../../vendor/oar/a122061/contracts/model-confirmation-error.js', [['ModelConfirmationError', 'ModelConfirmationError']]],
    ['../../vendor/oar/a122061/contracts/session-unavailable-error.js', [['SessionUnavailableError', 'SessionUnavailableError']]],
    ['../../vendor/oar/a122061/runtimes/dsh/session.js', [['dshSessionCapabilities', 'dshSessionCapabilities']]],
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
    ['../../vendor/oar/a122061/runtimes/codex/failure.js', [['codexFailure', 'codexFailure']]],
    ['../../vendor/oar/a122061/shared/failure-class.js', [['failureFromStatus', 'failureFromStatus']]],
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
    ['../../vendor/oar/a122061/shared/stream-json/session.js', [['streamJsonSession', 'streamJsonSession']]],
    ['../../vendor/oar/a122061/runtimes/claude/projection.js', [
      ['claudeProjectionProfile', 'claudeProjectionProfile'], ['initialClaudeProjection', 'initialClaudeProjection'], ['resumedClaudeProjection', 'resumedClaudeProjection'],
    ]],
    ['../../vendor/oar/a122061/shared/credential-redactor.js', [['sessionCredentialRedactor', 'sessionCredentialRedactor']]],
    ['../../vendor/oar/a122061/shared/stream-json/session.js', [['claudeSessionCapabilities', 'claudeSessionCapabilities']]],
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
