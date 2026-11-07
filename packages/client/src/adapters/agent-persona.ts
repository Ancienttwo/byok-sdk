import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { RuntimeOperationManifest } from '../types';
import { RuntimeExecutionFailure } from '../runtime-failure';
import { sameContent, sameFile } from '../util/file-state';

// Session-local instructions have their own read budget, independent of model context size.
const MAX_PERSONA_BYTES = 64 * 1024;
const refuse = (reason: string) => new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable', reason });

/**
 * Read only the admitted Agent home's persona; never grant runtime folder
 * trust. `reappliesOnResume` is for a runtime that replaces its append on
 * every resume; any other runtime refuses a resumed persona.
 */
export async function agentPersona(runtime: 'grok' | 'agy' | 'opencode', manifest: RuntimeOperationManifest, { reappliesOnResume = false }: { readonly reappliesOnResume?: boolean } = {}): Promise<string | undefined> {
  if (manifest.agentRef === undefined) return undefined;
  const home = manifest.lease?.canonicalHome;
  if (!home || !manifest.lease?.leaseId || !path.isAbsolute(home) || path.resolve(home) !== home) {
    throw refuse(`${runtime} Agent persona requires a sealed canonical-home lease`);
  }
  const reader = manifest.homeAccess === 'memory-reader';
  // A fresh reader runs in `runs/<taskId>`; a resumed reader runs again in the run directory its handoff recorded.
  const run = reader && manifest.sessionRef !== undefined ? path.basename(manifest.cwd ?? '') : manifest.taskId;
  if (reader && (path.basename(run) !== run || ['', '.', '..'].includes(run))) {
    throw refuse(`${runtime} Agent persona has an invalid reader task path`);
  }
  const expectedCwd = reader ? path.join(home, '.byok', 'runs', run) : home;
  if (manifest.cwd !== expectedCwd) throw refuse(`${runtime} Agent persona cwd does not match its sealed lease`);
  let text: string | undefined;
  try {
    if (await fs.realpath(home) !== home || !(await fs.lstat(home)).isDirectory()) throw new Error('invalid home');
    const file = path.join(home, 'AGENTS.md');
    let before;
    try { before = await fs.lstat(file, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!before.isFile() || before.size > BigInt(MAX_PERSONA_BYTES)) throw new Error('invalid persona');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameFile(opened, before) || opened.size > BigInt(MAX_PERSONA_BYTES)) throw new Error('persona changed');
      const bytes = Buffer.alloc(MAX_PERSONA_BYTES + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      const after = await fs.lstat(file, { bigint: true });
      const final = await handle.stat({ bigint: true });
      if (total > MAX_PERSONA_BYTES || !after.isFile() || !sameFile(after, opened) ||
          final.size !== BigInt(total) || !sameContent(final, opened)) throw new Error('persona changed');
      text = total === 0 ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total));
    } finally { await handle.close(); }
  } catch {
    // Do not leak file contents or filesystem error details into execution records.
    throw refuse(`${runtime} Agent persona must be a stable regular UTF-8 AGENTS.md file of at most 65536 bytes in its canonical home`);
  }
  if (text !== undefined && manifest.sessionRef !== undefined && !reappliesOnResume) {
    throw refuse(`${runtime} Agent persona resume is not qualified; append-only rules cannot be safely reapplied to a resumed session`);
  }
  return text;
}
