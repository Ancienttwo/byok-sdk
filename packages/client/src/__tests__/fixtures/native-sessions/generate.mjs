// From repository root: TMPDIR=/private/tmp/v2dr bun packages/client/src/__tests__/fixtures/native-sessions/generate.mjs
// The client pins @earendil-works/pi-coding-agent 1.5.0. No model or tool runs.
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = await mkdtemp(join(tmpdir(), 'native-fixture-'));
try {
  const session = SessionManager.create('/agent', scratch);
  const canary = 'EXCLUDED_CONTENT_CANARY';
  session.appendMessage({ role: 'user', content: [{ type: 'text', text: canary }, { type: 'image', data: canary, mimeType: 'image/png' }], timestamp: 1000 });
  const calls = [
    ['bash', { command: 'echo useful\necho second', description: canary }],
    ['read', { path: '/agent/notes/read.md' }],
    ['write', { path: '/agent/notes/write.md', content: canary }],
    ['edit', { path: '/agent/notes/edit.md', edits: [{ oldText: canary, newText: canary }] }],
    ['ls', { path: '/agent/notes' }],
    ['find', { pattern: '*.md', path: '/agent/notes' }],
    ['grep', { pattern: 'TODO', path: '/agent/notes' }],
    ['mcp.search', { query: canary }],
    ['extension', { input: canary }],
  ];
  session.appendMessage({ role: 'assistant', content: [
    { type: 'text', text: canary }, { type: 'thinking', thinking: canary },
    ...calls.map(([name, args], i) => ({ type: 'toolCall', id: `call-${i}`, name, arguments: args })),
  ], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 2000 });
  for (let i = 0; i < calls.length - 1; i++) session.appendMessage({ role: 'toolResult', toolCallId: `call-${i}`, toolName: calls[i][0], content: [{ type: 'text', text: canary }, { type: 'image', data: canary, mimeType: 'image/png' }], details: { canary }, isError: i === 1, timestamp: 3000 });
  session.appendCompaction(canary, session.getEntries()[0].id, 123, { canary });
  await writeFile(new URL('./pi-1.5.0.jsonl', import.meta.url), await readFile(session.getSessionFile()));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
