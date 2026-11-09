import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';

const SESSION_LEDGER_NAME = /^[A-Za-z0-9._-]{1,64}-[a-f0-9]{64}\.jsonl$/u;

/**
 * A session ledger `<runtime>-<sha256 hex>.jsonl`; a `-task-` name is classified as terminal evidence. Mirrors
 * `sessionFileName` and `taskTerminalFileName` in agent-session-handoff-store.ts; agent-home-contract.test.ts
 * checks real names from both against these predicates. Ambiguous names require both TTLs to expire.
 */
export function isAgentSessionLedgerName(name: string): boolean {
  return SESSION_LEDGER_NAME.test(name) && !isAgentTaskTerminalName(name);
}
export function isAgentTaskTerminalName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}-task-[a-f0-9]{64}\.jsonl$/u.test(name);
}

/** Names such as custom-task-<hash> can be either kind. Never shorten either retention window. */
export function agentSessionFileTtlMs(name: string, sessionTtlMs: number, terminalTtlMs: number): number {
  if (!isAgentTaskTerminalName(name)) return sessionTtlMs;
  return SESSION_LEDGER_NAME.test(name) ? Math.max(sessionTtlMs, terminalTtlMs) : terminalTtlMs;
}
export function piSessionRefFromFileName(name: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_([A-Za-z0-9-]{1,128})\.jsonl$/u.exec(name)?.[1];
}

/** Pi 1.4.0 `SessionManager` names a file `<ISO time with : and . as ->_<session id>.jsonl`; other names are the Host's. */
export function isPiSessionFileName(name: string): boolean {
  return piSessionRefFromFileName(name) !== undefined;
}

const CODEX_ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u;

/** Codex names a rollout `rollout-<local time>-<thread id>.jsonl`, in `YYYY/MM/DD` folders; the thread id is the session ref. */
export function codexThreadIdFromRolloutName(name: string): string | undefined {
  return CODEX_ROLLOUT.exec(name)?.[1];
}
export const isCodexRolloutFileName = (name: string): boolean => codexThreadIdFromRolloutName(name) !== undefined;

/** Removes matching files whose last write is at least `maxAgeMs` old. Content is never parsed. */
export async function pruneByLastWrite(input: {
  readonly directory: string;
  readonly entries: AsyncIterable<Dirent>;
  readonly match: (name: string) => boolean;
  readonly nowMs: number;
  readonly maxAgeMs: number | ((name: string) => number);
  readonly remove: (file: string) => Promise<boolean>;
}): Promise<void> {
  for await (const entry of input.entries) {
    if (!entry.isFile() || !input.match(entry.name)) continue;
    const file = path.join(input.directory, entry.name);
    const stat = await fs.lstat(file);
    const maxAgeMs = typeof input.maxAgeMs === 'number' ? input.maxAgeMs : input.maxAgeMs(entry.name);
    if (!stat.isFile() || input.nowMs - stat.mtimeMs < maxAgeMs) continue;
    if (!await input.remove(file)) return;
  }
}
