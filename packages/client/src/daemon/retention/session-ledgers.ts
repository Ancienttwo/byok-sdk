import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';

/**
 * A session ledger `<runtime>-<sha256 hex>.jsonl`; a `-task-` name is terminal evidence. Mirrors
 * `sessionFileName` and `taskTerminalFileName` in agent-session-handoff-store.ts; agent-home-contract.test.ts
 * checks real names from both against these predicates.
 */
export function isAgentSessionLedgerName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}-[a-f0-9]{64}\.jsonl$/u.test(name) && !isAgentTaskTerminalName(name);
}
export function isAgentTaskTerminalName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}-task-[a-f0-9]{64}\.jsonl$/u.test(name);
}
export function piSessionRefFromFileName(name: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_([A-Za-z0-9-]{1,128})\.jsonl$/u.exec(name)?.[1];
}

/** Pi 1.4.0 `SessionManager` names a file `<ISO time with : and . as ->_<session id>.jsonl`; other names are the Host's. */
export function isPiSessionFileName(name: string): boolean {
  return piSessionRefFromFileName(name) !== undefined;
}

/** Removes matching files whose last write is at least `maxAgeMs` old. Content is never parsed. */
export async function pruneByLastWrite(input: {
  readonly directory: string;
  readonly entries: AsyncIterable<Dirent>;
  readonly match: (name: string) => boolean;
  readonly nowMs: number;
  readonly maxAgeMs: number;
  readonly remove: (file: string) => Promise<boolean>;
}): Promise<void> {
  for await (const entry of input.entries) {
    if (!entry.isFile() || !input.match(entry.name)) continue;
    const file = path.join(input.directory, entry.name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || input.nowMs - stat.mtimeMs < input.maxAgeMs) continue;
    if (!await input.remove(file)) return;
  }
}
