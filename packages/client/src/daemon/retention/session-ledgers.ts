import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';

/**
 * A session ledger `<runtime>-<sha256 hex>.jsonl`; a `-task-` name stays terminal evidence. Mirrors
 * `sessionFileName` and `taskTerminalFileName` in agent-session-handoff-store.ts; agent-home-contract.test.ts
 * checks real names from both against this predicate.
 */
export function isAgentSessionLedgerName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}-[a-f0-9]{64}\.jsonl$/u.test(name) && !/-task-[a-f0-9]{64}\.jsonl$/u.test(name);
}

/** Removes ledgers whose last append is at least `maxAgeMs` old. Content is never parsed. */
export async function pruneSessionLedgers(input: {
  readonly directory: string;
  readonly entries: AsyncIterable<Dirent>;
  readonly nowMs: number;
  readonly maxAgeMs: number;
  readonly remove: (file: string) => Promise<boolean>;
}): Promise<void> {
  for await (const entry of input.entries) {
    if (!entry.isFile() || !isAgentSessionLedgerName(entry.name)) continue;
    const file = path.join(input.directory, entry.name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || input.nowMs - stat.mtimeMs < input.maxAgeMs) continue;
    if (!await input.remove(file)) return;
  }
}
