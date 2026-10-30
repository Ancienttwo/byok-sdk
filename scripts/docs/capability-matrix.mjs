import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CLAUDE_RUNTIME_CAPABILITIES } from '../../packages/client/src/adapters/claude/claude-capabilities.ts';
import { CODEX_RUNTIME_CAPABILITIES } from '../../packages/client/src/adapters/codex/codex-capabilities.ts';
import { GROK_RUNTIME_CAPABILITIES } from '../../packages/client/src/adapters/grok/grok-capabilities.ts';
import { HERMES_RUNTIME_CAPABILITIES } from '../../packages/client/src/adapters/hermes/hermes-capabilities.ts';
import { PI_DURABLE_RUNTIME_CAPABILITIES, PI_RUNTIME_CAPABILITIES } from '../../packages/client/src/adapters/pi/pi-capabilities.ts';
import { QUALIFIED_CLAUDE_VERSION } from '../../packages/client/src/adapters/claude/claude-version.ts';
import { QUALIFIED_CODEX_VERSION } from '../../packages/client/src/adapters/codex/codex-version.ts';
import { QUALIFIED_GROK_VERSION } from '../../packages/client/src/adapters/grok/grok-version.ts';
import { QUALIFIED_HERMES_VERSION } from '../../packages/client/src/adapters/hermes/hermes-version.ts';

// #1103: the capability matrix table in docs/adapter-capabilities.md is a
// projection of the adapter capability constants, which are also what each
// adapter descriptor and conn.hello/presence report.
const root = fileURLToPath(new URL('../../', import.meta.url));
const DOC = 'docs/adapter-capabilities.md';
const piPin = JSON.parse(readFileSync(path.join(root, 'packages/client/package.json'), 'utf8')).byok.piRuntimePin;

export const COLUMNS = [
  ['Claude', CLAUDE_RUNTIME_CAPABILITIES, QUALIFIED_CLAUDE_VERSION],
  ['Codex', CODEX_RUNTIME_CAPABILITIES, QUALIFIED_CODEX_VERSION],
  ['Grok', GROK_RUNTIME_CAPABILITIES, QUALIFIED_GROK_VERSION],
  ['Hermes', HERMES_RUNTIME_CAPABILITIES, QUALIFIED_HERMES_VERSION],
  ['Pi', PI_RUNTIME_CAPABILITIES, piPin],
  ['Pi (`durablePi`)', PI_DURABLE_RUNTIME_CAPABILITIES, piPin],
];

const ROWS = [
  ['Resume a known native session', 'resume', (c) => c.resume],
  ['Redirect the active turn', 'steer', (c) => c.steer],
  ['Display-only message draft', 'messageDraft', (c) => c.messageDraft],
  ['Task-scoped MCP toolsets', 'mcpToolsets', (c) => c.mcpToolsets],
  ['Interactive approval channel', 'approvalInteractive', (c) => c.approvalInteractive],
  ['Tool authorization `auto`', 'toolAuthorizationAuto', (c) => c.toolAuthorizationAuto],
  ['Prepared lane', 'preparedLane', (c) => c.preparedLane],
  ['Durable Pi worker', 'durablePi', (c) => c.durablePi],
  ['Keeps user-level instructions out', 'isolation.userContext', (c) => c.isolation?.userContext],
  ['Keeps user MCP servers out', 'isolation.userMcpServers', (c) => c.isolation?.userMcpServers],
  ['Turns off the transcript store', 'isolation.sessionPersistence', (c) => c.isolation?.sessionPersistence],
];

const row = (cells) => `| ${cells.join(' | ')} |`;

export function matrixTable() {
  return [
    row(['Capability', 'Wire field', ...COLUMNS.map(([name]) => name)]),
    row(['---', '---', ...COLUMNS.map(() => '---')]),
    row(['Qualified version (PR CI)', '—', ...COLUMNS.map(([, , version]) => `\`${version}\``)]),
    ...ROWS.map(([label, field, read]) => row([label, `\`${field}\``, ...COLUMNS.map(([, capabilities]) => (read(capabilities) === true ? 'yes' : 'no'))])),
  ].join('\n');
}

export function generateDoc(current) {
  const start = '<!-- generated:capability-matrix:start -->';
  const end = '<!-- generated:capability-matrix:end -->';
  if (current.split(start).length !== 2 || current.split(end).length !== 2) throw new Error('Missing/duplicate generated section capability-matrix');
  return current.slice(0, current.indexOf(start) + start.length) + '\n' + matrixTable() + '\n' + current.slice(current.indexOf(end));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.join(root, DOC);
  const current = readFileSync(file, 'utf8');
  const generated = generateDoc(current);
  if (process.argv.includes('--write')) writeFileSync(file, generated);
  else if (generated !== current) throw new Error('Adapter capability matrix is stale: bun run docs:capability-matrix');
  else console.log('Adapter capability matrix: generated table PASS');
}
