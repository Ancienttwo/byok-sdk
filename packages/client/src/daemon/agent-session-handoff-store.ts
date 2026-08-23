import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateAgentRef, type AgentRef } from '../agent-home';

export type AgentTerminalCause = 'complete' | 'failed' | 'cancelled';

export interface AgentSessionHandoff {
  readonly agentRef: AgentRef;
  readonly sessionRef: string;
  readonly runtimeId: string;
  /** Canonical Agent home and runtime cwd; these are intentionally one value. */
  readonly cwd: string;
  readonly leaseId: string;
  readonly terminalCause?: AgentTerminalCause;
  readonly terminalReason?: string;
  readonly updatedAt: string;
}

export interface AgentSessionHandoffMatch {
  readonly agentRef: AgentRef;
  readonly sessionRef: string;
  readonly runtimeId: string;
  readonly cwd: string;
}

interface StoredShape {
  version: 1;
  records: Record<string, AgentSessionHandoff>;
}

export class AgentSessionHandoffStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSessionHandoffStoreError';
  }
}

export class AgentSessionHandoffCorruptError extends AgentSessionHandoffStoreError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSessionHandoffCorruptError';
  }
}

export class AgentSessionHandoffMismatchError extends AgentSessionHandoffStoreError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSessionHandoffMismatchError';
  }
}

let temporarySequence = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(sessionRef: string, value: unknown): AgentSessionHandoff {
  if (!isRecord(value) || value.sessionRef !== sessionRef || !isRecord(value.agentRef)) {
    throw new AgentSessionHandoffCorruptError(`invalid Agent session handoff record for ${sessionRef}`);
  }
  let agentRef: AgentRef;
  try {
    agentRef = validateAgentRef(value.agentRef);
  } catch (error) {
    throw new AgentSessionHandoffCorruptError(`invalid AgentRef in handoff for ${sessionRef}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    typeof value.runtimeId !== 'string' || value.runtimeId.length === 0 ||
    typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) ||
    typeof value.leaseId !== 'string' || value.leaseId.length === 0 ||
    typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))
  ) {
    throw new AgentSessionHandoffCorruptError(`invalid Agent session handoff fields for ${sessionRef}`);
  }
  if (value.terminalCause !== undefined && value.terminalCause !== 'complete' && value.terminalCause !== 'failed' && value.terminalCause !== 'cancelled') {
    throw new AgentSessionHandoffCorruptError(`invalid terminal cause in Agent session handoff for ${sessionRef}`);
  }
  if (value.terminalReason !== undefined && typeof value.terminalReason !== 'string') {
    throw new AgentSessionHandoffCorruptError(`invalid terminal reason in Agent session handoff for ${sessionRef}`);
  }
  return Object.freeze({
    agentRef,
    sessionRef,
    runtimeId: value.runtimeId,
    cwd: path.resolve(value.cwd),
    leaseId: value.leaseId,
    ...(value.terminalCause === undefined ? {} : { terminalCause: value.terminalCause }),
    ...(value.terminalReason === undefined ? {} : { terminalReason: value.terminalReason }),
    updatedAt: value.updatedAt,
  });
}

function parseStore(value: unknown): StoredShape {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.records)) {
    throw new AgentSessionHandoffCorruptError('Agent session handoff store has an unknown or invalid shape');
  }
  const records: Record<string, AgentSessionHandoff> = Object.create(null) as Record<string, AgentSessionHandoff>;
  for (const [sessionRef, entry] of Object.entries(value.records)) {
    records[sessionRef] = parseEntry(sessionRef, entry);
  }
  return { version: 1, records };
}

function sameRef(left: AgentRef, right: AgentRef): boolean {
  return left.agentId === right.agentId && left.profileRevision === right.profileRevision;
}

function sameMatch(entry: AgentSessionHandoff, expected: AgentSessionHandoffMatch): boolean {
  return sameRef(entry.agentRef, expected.agentRef) &&
    entry.sessionRef === expected.sessionRef &&
    entry.runtimeId === expected.runtimeId &&
    entry.cwd === path.resolve(expected.cwd);
}

/**
 * Durable, fail-closed session handoff authority for strict Agent tasks.
 * Unlike the legacy SessionWorkspaceStore, corrupt bytes are not interpreted
 * as an empty map: resuming an Agent without exact identity evidence is
 * unsafe, so every read/write rejects until the host repairs the store.
 */
export class AgentSessionHandoffStore {
  private readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(storeDir: string) {
    if (!path.isAbsolute(storeDir)) throw new AgentSessionHandoffStoreError('Agent session handoff storeDir must be absolute');
    this.filePath = path.join(storeDir, 'agent-session-handoffs.json');
  }

  async get(sessionRef: string): Promise<AgentSessionHandoff | undefined> {
    return this.enqueue(async () => {
      const store = await this.load();
      return store.records[sessionRef];
    });
  }

  /** Exact identity check used before a strict Agent resume is admitted. */
  async requireMatch(expected: AgentSessionHandoffMatch): Promise<AgentSessionHandoff> {
    const entry = await this.get(expected.sessionRef);
    if (entry === undefined || !sameMatch(entry, expected)) {
      throw new AgentSessionHandoffMismatchError(
        `Agent session handoff ${expected.sessionRef} does not match AgentRef/profileRevision/runtime/cwd exactly`,
      );
    }
    return entry;
  }

  /** Atomic, fsynced write. The caller awaits this before task.started. */
  async record(input: Omit<AgentSessionHandoff, 'updatedAt' | 'terminalCause' | 'terminalReason'>): Promise<AgentSessionHandoff> {
    return this.enqueue(async () => {
      const store = await this.load();
      const now = new Date().toISOString();
      const next = Object.freeze({
        agentRef: validateAgentRef(input.agentRef),
        sessionRef: input.sessionRef,
        runtimeId: input.runtimeId,
        cwd: path.resolve(input.cwd),
        leaseId: input.leaseId,
        updatedAt: now,
      });
      const prior = store.records[input.sessionRef];
      if (prior !== undefined && !sameMatch(prior, next)) {
        throw new AgentSessionHandoffMismatchError(
          `session ${input.sessionRef} is already bound to a different AgentRef/profileRevision/runtime/cwd`,
        );
      }
      store.records[input.sessionRef] = next;
      await this.save(store);
      return next;
    });
  }

  /** Records the first terminal cause without changing the exact handoff identity. */
  async recordTerminal(
    expected: AgentSessionHandoffMatch,
    cause: AgentTerminalCause,
    reason?: string,
  ): Promise<AgentSessionHandoff> {
    return this.enqueue(async () => {
      const store = await this.load();
      const existing = store.records[expected.sessionRef];
      if (existing === undefined || !sameMatch(existing, expected)) {
        throw new AgentSessionHandoffMismatchError(
          `cannot record terminal cause for ${expected.sessionRef}: exact Agent handoff match failed`,
        );
      }
      const updated = Object.freeze({
        ...existing,
        terminalCause: existing.terminalCause ?? cause,
        ...(existing.terminalReason === undefined && reason === undefined ? {} : {
          terminalReason: existing.terminalReason ?? reason,
        }),
        updatedAt: new Date().toISOString(),
      });
      store.records[expected.sessionRef] = updated;
      await this.save(store);
      return updated;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async load(): Promise<StoredShape> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: Object.create(null) as Record<string, AgentSessionHandoff> };
      throw new AgentSessionHandoffStoreError(`could not read Agent session handoff store: ${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new AgentSessionHandoffCorruptError(`Agent session handoff store is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseStore(parsed);
  }

  private async save(store: StoredShape): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.${process.pid}-${temporarySequence++}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(tmpPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(store, null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(tmpPath, this.filePath);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw new AgentSessionHandoffStoreError(`could not durably write Agent session handoff store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

