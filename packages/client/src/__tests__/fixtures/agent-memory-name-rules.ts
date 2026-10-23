import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';

import { AgentMemoryService, captureAgentMemorySnapshot, type AgentMemoryTaskContext } from '../../daemon/agent-memory';

const sha256 = (value: string): string => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

/**
 * One home with a Windows device name, a case pair or alias, and hard links.
 * Recall and save refuse each of them with `refusal`, the snapshot leaves them
 * out, and the outside file does not change. The same steps run against the
 * native Linux backend and the Go helper.
 */
export async function expectAgentMemoryNameRules(context: AgentMemoryTaskContext, outside: string, refusal: { readonly caseAlias: string; readonly hardLink: string }): Promise<void> {
  const notes = path.join(context.canonicalHome, 'notes');
  await fs.writeFile(path.join(notes, 'con.md'), 'device name', 'utf8');
  await fs.writeFile(path.join(notes, 'plain.md'), 'plain', 'utf8');
  await fs.writeFile(path.join(notes, 'Upper.md'), 'upper', 'utf8');
  const caseInsensitive = await fs.lstat(path.join(notes, 'UPPER.md')).then(() => true, () => false);
  if (!caseInsensitive) await fs.writeFile(path.join(notes, 'upper.md'), 'lower', 'utf8');
  const sentinel = path.join(outside, 'sentinel.md');
  await fs.writeFile(sentinel, 'outside sentinel', 'utf8');
  await fs.link(sentinel, path.join(notes, 'linked.md'));
  const service = new AgentMemoryService(context);

  await expect(service.recall({ path: 'notes/con.md' })).rejects.toThrow('notes/<safe-relative>.md');
  for (const alias of caseInsensitive ? ['notes/upper.md'] : ['notes/upper.md', 'notes/Upper.md']) {
    await expect(service.recall({ path: alias })).rejects.toThrow(refusal.caseAlias);
    await expect(service.save({ op: 'replace', path: alias, expectedRevision: sha256(caseInsensitive ? 'upper' : 'lower'), content: 'next' })).rejects.toThrow(refusal.caseAlias);
  }
  await expect(service.recall({ path: 'notes/linked.md' })).rejects.toThrow(refusal.hardLink);
  await expect(service.save({ op: 'replace', path: 'notes/linked.md', expectedRevision: sha256('outside sentinel'), content: 'next' })).rejects.toThrow(refusal.hardLink);
  await expect(service.save({ op: 'delete', path: 'notes/linked.md', expectedRevision: sha256('outside sentinel') })).rejects.toThrow(refusal.hardLink);
  if (caseInsensitive) expect((await service.recall({ path: 'notes/Upper.md' })).content).toBe('upper');

  const snapshot = await captureAgentMemorySnapshot(context);
  expect(snapshot.files.map((file) => file.path)).toEqual(caseInsensitive ? ['MEMORY.md', 'notes/Upper.md', 'notes/plain.md'] : ['MEMORY.md', 'notes/plain.md']);
  expect(await fs.readFile(sentinel, 'utf8')).toBe('outside sentinel');
  expect((await fs.readdir(notes)).sort()).toEqual(caseInsensitive ? ['Upper.md', 'con.md', 'linked.md', 'plain.md'] : ['Upper.md', 'con.md', 'linked.md', 'plain.md', 'upper.md']);
}
