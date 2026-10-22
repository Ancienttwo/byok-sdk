import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { RuntimeOperationManifest } from '../../types';
import { RuntimeExecutionFailure } from '../../runtime-failure';

// Session-local instructions have their own read budget, independent of model context size.
const MAX_PERSONA_BYTES = 64 * 1024;
const refuse = (reason: string) => new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable', reason });

/** Read only the admitted Agent home's persona; never grant runtime folder trust. */
export async function grokAgentPersona(manifest: RuntimeOperationManifest): Promise<string | undefined> {
  if (manifest.agentRef === undefined) return undefined;
  const home = manifest.lease?.canonicalHome;
  if (!home || !manifest.lease?.leaseId || !path.isAbsolute(home) || path.resolve(home) !== home) {
    throw refuse('grok Agent persona requires a sealed canonical-home lease');
  }
  const reader = manifest.homeAccess === 'memory-reader';
  // A fresh reader runs in `runs/<taskId>`; a resumed reader runs again in the run directory its handoff recorded.
  const run = reader && manifest.sessionRef !== undefined ? path.basename(manifest.cwd ?? '') : manifest.taskId;
  if (reader && (path.basename(run) !== run || ['', '.', '..'].includes(run))) {
    throw refuse('grok Agent persona has an invalid reader task path');
  }
  const expectedCwd = reader ? path.join(home, '.byok', 'runs', run) : home;
  if (manifest.cwd !== expectedCwd) throw refuse('grok Agent persona cwd does not match its sealed lease');
  let text: string | undefined;
  try {
    if (await fs.realpath(home) !== home || !(await fs.lstat(home)).isDirectory()) throw new Error('invalid home');
    const file = path.join(home, 'AGENTS.md');
    let before;
    try { before = await fs.lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!before.isFile() || before.size > MAX_PERSONA_BYTES) throw new Error('invalid persona');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_PERSONA_BYTES) throw new Error('persona changed');
      const bytes = Buffer.alloc(MAX_PERSONA_BYTES + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      const after = await fs.lstat(file);
      const final = await handle.stat();
      if (total > MAX_PERSONA_BYTES || !after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino ||
          final.size !== total || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) throw new Error('persona changed');
      text = total === 0 ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total));
    } finally { await handle.close(); }
  } catch {
    // Do not leak file contents or filesystem error details into execution records.
    throw refuse('grok Agent persona must be a stable regular UTF-8 AGENTS.md file of at most 65536 bytes in its canonical home');
  }
  if (text !== undefined && manifest.sessionRef !== undefined) {
    throw refuse('grok Agent persona resume is not qualified; append-only rules cannot be safely reapplied to a resumed session');
  }
  return text;
}
