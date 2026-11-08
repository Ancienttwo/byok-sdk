import { OPENCODE_RUNTIME_CAPABILITIES } from '../../packages/client/src/adapters/opencode/opencode-capabilities.ts';
import { OPENCODE_QUALIFICATION } from '../../packages/client/src/adapters/opencode/opencode-version.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AGY_ABSENT_ISOLATION_SOURCES, AGY_RUNTIME_CAPABILITIES } from '../../packages/client/src/adapters/antigravity/agy-capabilities.ts';
import { CLAUDE_ABSENT_ISOLATION_SOURCES, CLAUDE_RUNTIME_CAPABILITIES } from '../../packages/client/src/adapters/claude/claude-capabilities.ts';
import { CODEX_ABSENT_ISOLATION_SOURCES, CODEX_RUNTIME_CAPABILITIES } from '../../packages/client/src/adapters/codex/codex-capabilities.ts';
import { DSH_ABSENT_ISOLATION_SOURCES, DSH_RUNTIME_CAPABILITIES } from '../../packages/client/src/adapters/dsh/dsh-capabilities.ts';
import { GROK_ABSENT_ISOLATION_SOURCES, GROK_RUNTIME_CAPABILITIES } from '../../packages/client/src/adapters/grok/grok-capabilities.ts';
import { HERMES_ABSENT_ISOLATION_SOURCES, HERMES_RUNTIME_CAPABILITIES } from '../../packages/client/src/adapters/hermes/hermes-capabilities.ts';
import { PI_ABSENT_ISOLATION_SOURCES, PI_DURABLE_RUNTIME_CAPABILITIES, PI_RUNTIME_CAPABILITIES } from '../../packages/client/src/adapters/pi/pi-capabilities.ts';
import { QUALIFIED_AGY_VERSION } from '../../packages/client/src/adapters/antigravity/agy-version.ts';
import { QUALIFIED_CLAUDE_VERSION } from '../../packages/client/src/adapters/claude/claude-version.ts';
import { QUALIFIED_CODEX_VERSION } from '../../packages/client/src/adapters/codex/codex-version.ts';
import { QUALIFIED_DSH_VERSION } from '../../packages/client/src/adapters/dsh/dsh-version.ts';
import { QUALIFIED_GROK_VERSION } from '../../packages/client/src/adapters/grok/grok-version.ts';
import { QUALIFIED_HERMES_VERSION } from '../../packages/client/src/adapters/hermes/hermes-version.ts';

// #1103: the capability matrix table in docs/adapter-capabilities.md is a
// projection of the adapter capability constants, which are also what each
// adapter descriptor and conn.hello/presence report. A true isolation bit
// whose source the adapter's absent-sources record declares missing reads
// "yes (no source)".
const root = fileURLToPath(new URL('../../', import.meta.url));
const DOC = 'docs/adapter-capabilities.md';
const piPin = JSON.parse(readFileSync(path.join(root, 'packages/client/package.json'), 'utf8')).byok.piRuntimePin;

export const COLUMNS = [
  ['agy', AGY_RUNTIME_CAPABILITIES, QUALIFIED_AGY_VERSION, AGY_ABSENT_ISOLATION_SOURCES],
  ['Claude', CLAUDE_RUNTIME_CAPABILITIES, QUALIFIED_CLAUDE_VERSION, CLAUDE_ABSENT_ISOLATION_SOURCES],
  ['Codex', CODEX_RUNTIME_CAPABILITIES, QUALIFIED_CODEX_VERSION, CODEX_ABSENT_ISOLATION_SOURCES],
  ['dsh', DSH_RUNTIME_CAPABILITIES, QUALIFIED_DSH_VERSION, DSH_ABSENT_ISOLATION_SOURCES],
  ['Grok', GROK_RUNTIME_CAPABILITIES, QUALIFIED_GROK_VERSION, GROK_ABSENT_ISOLATION_SOURCES],
  ['Hermes', HERMES_RUNTIME_CAPABILITIES, QUALIFIED_HERMES_VERSION, HERMES_ABSENT_ISOLATION_SOURCES],
  ['OpenCode (unqualified)', OPENCODE_RUNTIME_CAPABILITIES, OPENCODE_QUALIFICATION, {}],
  ['Pi', PI_RUNTIME_CAPABILITIES, piPin, PI_ABSENT_ISOLATION_SOURCES],
  ['Pi (`durableLane`)', PI_DURABLE_RUNTIME_CAPABILITIES, piPin, PI_ABSENT_ISOLATION_SOURCES],
];

export const ROWS = [
  ['Resume a known native session', 'resume', (c) => c.resume],
  ['Redirect the active turn', 'steer', (c) => c.steer],
  ['Display-only message draft', 'messageDraft', (c) => c.messageDraft],
  ['Task-scoped MCP toolsets', 'mcpToolsets', (c) => c.mcpToolsets],
  ['Interactive approval channel', 'approvalInteractive', (c) => c.approvalInteractive],
  ['Tool authorization `auto`', 'toolAuthorizationAuto', (c) => c.toolAuthorizationAuto],
  ['Prepared lane', 'preparedLane', (c) => c.preparedLane],
  ['Durable worker lane', 'durableLane', (c) => c.durableLane],
  ['Keeps user-level instructions out', 'isolation.userInstructions', (c) => c.isolation?.userInstructions],
  ['Keeps the user output style out', 'isolation.userOutputStyle', (c) => c.isolation?.userOutputStyle],
  ['Keeps user-level memory out', 'isolation.userMemory', (c) => c.isolation?.userMemory],
  ['Keeps user skills out', 'isolation.userSkills', (c) => c.isolation?.userSkills],
  ['Keeps user hook context out', 'isolation.userHookContext', (c) => c.isolation?.userHookContext],
  ['Keeps user MCP servers out', 'isolation.userMcpServers', (c) => c.isolation?.userMcpServers],
  ['Turns off the transcript store', 'isolation.sessionPersistence', (c) => c.isolation?.sessionPersistence],
];

const row = (cells) => `| ${cells.join(' | ')} |`;

export function matrixCell(field, capabilities, absentSources, read) {
  if (read(capabilities) !== true) return 'no';
  const [group, bit] = field.split('.');
  return group === 'isolation' && absentSources[bit] !== undefined ? 'yes (no source)' : 'yes';
}

export function matrixTable() {
  return [
    row(['Capability', 'Wire field', ...COLUMNS.map(([name]) => name)]),
    row(['---', '---', ...COLUMNS.map(() => '---')]),
    row(['Qualified version (PR CI)', '—', ...COLUMNS.map(([, , version]) => `\`${version}\``)]),
    ...ROWS.map(([label, field, read]) => row([label, `\`${field}\``, ...COLUMNS.map(([, capabilities, , absentSources]) => matrixCell(field, capabilities, absentSources, read))])),
  ].join('\n');
}

export function generateDoc(current) {
  const start = '<!-- generated:capability-matrix:start -->';
  const end = '<!-- generated:capability-matrix:end -->';
  if (current.split(start).length !== 2 || current.split(end).length !== 2) throw new Error('Missing/duplicate generated section capability-matrix');
  return current.slice(0, current.indexOf(start) + start.length) + '\n' + matrixTable() + '\n' + current.slice(current.indexOf(end));
}

if (import.meta.main) {
  const file = path.join(root, DOC);
  const current = readFileSync(file, 'utf8');
  const generated = generateDoc(current);
  if (process.argv.includes('--write')) writeFileSync(file, generated);
  else if (generated !== current) throw new Error('Adapter capability matrix is stale: bun run docs:capability-matrix');
  else console.log('Adapter capability matrix: generated table PASS');
}
