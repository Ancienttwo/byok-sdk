import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { agentHomeReaderRunDirectory, validateAgentRef, type AgentRef } from '../agent-home';

export type AgentTerminalCause = 'complete' | 'failed' | 'cancelled';

export interface AgentSessionHandoff {
  readonly agentRef: AgentRef;
  /** Task that created the native runtime session. */
  readonly taskId: string;
  readonly sessionRef: string;
  readonly runtimeId: string;
  /**
   * Runtime cwd. For a writer session it is the canonical Agent home. For a
   * `memory-reader` session it is the run directory `<home>/.byok/runs/<taskId>`
   * that the first Attempt created; a resume runs there again.
   */
  readonly cwd: string;
  /** Present for a `memory-reader` session only; absent means a writer session. */
  readonly homeAccess?: 'memory-reader';
  readonly leaseId: string;
  readonly terminalCause?: AgentTerminalCause;
  readonly terminalReason?: string;
  readonly updatedAt: string;
}

/**
 * Exact session identity. Every field must match the recorded handoff,
 * including the access mode: a reader session never resumes as a writer, and
 * a writer session never resumes as a reader.
 */
export interface AgentSessionHandoffMatch {
  readonly agentRef: AgentRef;
  readonly sessionRef: string;
  readonly runtimeId: string;
  /**
   * Canonical Agent home. The session ledger lives in its
   * `.byok/runtime-sessions/`. Defaults to `cwd`, which is the home of a
   * writer session. A reader session must name it.
   */
  readonly home?: string;
  readonly cwd: string;
  readonly homeAccess?: 'memory-reader';
}

export interface AgentTaskTerminalEvidence {
  readonly agentRef: AgentRef;
  readonly taskId: string;
  readonly runtimeId: string;
  /** Sealed runtime cwd: the canonical Agent home, or a reader's run directory. */
  readonly cwd: string;
  /** Present for a `memory-reader` Attempt only. */
  readonly homeAccess?: 'memory-reader';
  readonly leaseId: string;
  /** Present when adapter start succeeded but handoff persistence failed. */
  readonly sessionRef?: string;
  readonly terminalCause: 'failed';
  readonly terminalReason: string;
  readonly updatedAt: string;
}

export interface AgentTaskTerminalMatch {
  readonly agentRef: AgentRef;
  readonly taskId: string;
  readonly runtimeId: string;
  /** Canonical Agent home, as in {@link AgentSessionHandoffMatch.home}. Defaults to `cwd`. */
  readonly home?: string;
  readonly cwd: string;
  readonly homeAccess?: 'memory-reader';
}

interface StoredShape extends AgentSessionHandoff {
  readonly version: 1;
}

interface StoredTaskTerminalShape extends AgentTaskTerminalEvidence {
  readonly version: 1;
  readonly kind: 'task-terminal';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTaskTerminalEntry(value: unknown): AgentTaskTerminalEvidence {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.kind !== 'task-terminal' ||
    !isRecord(value.agentRef)
  ) {
    throw new AgentSessionHandoffCorruptError('Agent task terminal evidence has an unknown or invalid shape');
  }
  let agentRef: AgentRef;
  try {
    agentRef = validateAgentRef(value.agentRef);
  } catch (error) {
    throw new AgentSessionHandoffCorruptError(
      `invalid AgentRef in task terminal evidence: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertNonEmptyString(value.taskId, 'taskTerminal.taskId');
  assertNonEmptyString(value.runtimeId, 'taskTerminal.runtimeId');
  assertNonEmptyString(value.leaseId, 'taskTerminal.leaseId');
  assertNonEmptyString(value.terminalReason, 'taskTerminal.terminalReason');
  assertNonEmptyString(value.updatedAt, 'taskTerminal.updatedAt');
  if (value.sessionRef !== undefined) assertNonEmptyString(value.sessionRef, 'taskTerminal.sessionRef');
  if (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)) {
    throw new AgentSessionHandoffCorruptError('taskTerminal.cwd must be an absolute path');
  }
  if (value.terminalCause !== 'failed') {
    throw new AgentSessionHandoffCorruptError('taskTerminal.terminalCause must be failed');
  }
  if (value.homeAccess !== undefined && value.homeAccess !== 'memory-reader') {
    throw new AgentSessionHandoffCorruptError('taskTerminal.homeAccess is invalid');
  }
  if (Number.isNaN(Date.parse(value.updatedAt))) {
    throw new AgentSessionHandoffCorruptError('taskTerminal.updatedAt must be an ISO date');
  }
  return Object.freeze({
    agentRef,
    taskId: value.taskId,
    runtimeId: value.runtimeId,
    cwd: path.resolve(value.cwd),
    ...(value.homeAccess === undefined ? {} : { homeAccess: 'memory-reader' as const }),
    leaseId: value.leaseId,
    ...(value.sessionRef === undefined ? {} : { sessionRef: value.sessionRef }),
    terminalCause: 'failed',
    terminalReason: value.terminalReason,
    updatedAt: value.updatedAt,
  });
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new AgentSessionHandoffCorruptError(`${label} must be a non-empty string without NUL or line breaks`);
  }
}

function parseEntry(value: unknown): AgentSessionHandoff {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.agentRef)) {
    throw new AgentSessionHandoffCorruptError('Agent session handoff has an unknown or invalid shape');
  }
  let agentRef: AgentRef;
  try {
    agentRef = validateAgentRef(value.agentRef);
  } catch (error) {
    throw new AgentSessionHandoffCorruptError(
      `invalid AgentRef in handoff: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertNonEmptyString(value.taskId, 'handoff.taskId');
  assertNonEmptyString(value.sessionRef, 'handoff.sessionRef');
  assertNonEmptyString(value.runtimeId, 'handoff.runtimeId');
  assertNonEmptyString(value.leaseId, 'handoff.leaseId');
  assertNonEmptyString(value.updatedAt, 'handoff.updatedAt');
  if (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)) {
    throw new AgentSessionHandoffCorruptError('handoff.cwd must be an absolute path');
  }
  if (Number.isNaN(Date.parse(value.updatedAt))) {
    throw new AgentSessionHandoffCorruptError('handoff.updatedAt must be an ISO date');
  }
  if (
    value.terminalCause !== undefined &&
    value.terminalCause !== 'complete' &&
    value.terminalCause !== 'failed' &&
    value.terminalCause !== 'cancelled'
  ) {
    throw new AgentSessionHandoffCorruptError('handoff.terminalCause is invalid');
  }
  if (value.terminalReason !== undefined && typeof value.terminalReason !== 'string') {
    throw new AgentSessionHandoffCorruptError('handoff.terminalReason must be a string');
  }
  if (value.homeAccess !== undefined && value.homeAccess !== 'memory-reader') {
    throw new AgentSessionHandoffCorruptError('handoff.homeAccess is invalid');
  }
  return Object.freeze({
    agentRef,
    taskId: value.taskId,
    sessionRef: value.sessionRef,
    runtimeId: value.runtimeId,
    cwd: path.resolve(value.cwd),
    ...(value.homeAccess === undefined ? {} : { homeAccess: 'memory-reader' as const }),
    leaseId: value.leaseId,
    ...(value.terminalCause === undefined ? {} : { terminalCause: value.terminalCause }),
    ...(value.terminalReason === undefined ? {} : { terminalReason: value.terminalReason }),
    updatedAt: value.updatedAt,
  });
}

function sameRef(left: AgentRef, right: AgentRef): boolean {
  return left.agentId === right.agentId && left.profileRevision === right.profileRevision;
}

function sameMatch(
  entry: AgentSessionHandoff,
  expected: Omit<AgentSessionHandoffMatch, 'home'>,
): boolean {
  return (
    sameRef(entry.agentRef, expected.agentRef) &&
    entry.sessionRef === expected.sessionRef &&
    entry.runtimeId === expected.runtimeId &&
    entry.cwd === path.resolve(expected.cwd) &&
    entry.homeAccess === expected.homeAccess
  );
}

function sameTaskTerminalMatch(
  entry: AgentTaskTerminalEvidence,
  expected: Omit<AgentTaskTerminalMatch, 'home'>,
): boolean {
  return (
    sameRef(entry.agentRef, expected.agentRef) &&
    entry.taskId === expected.taskId &&
    entry.runtimeId === expected.runtimeId &&
    entry.cwd === path.resolve(expected.cwd) &&
    entry.homeAccess === expected.homeAccess
  );
}

/**
 * A writer's cwd is the home itself. A reader's cwd is a direct child of
 * `<home>/.byok/runs/`. Anything else is a caller error, never a new ledger.
 */
function assertCwdForAccess(home: string, cwd: string, homeAccess: 'memory-reader' | undefined): void {
  const resolvedHome = path.resolve(home);
  const resolvedCwd = path.resolve(cwd);
  const valid = homeAccess === undefined
    ? resolvedCwd === resolvedHome
    : (() => {
        try {
          return agentHomeReaderRunDirectory(resolvedHome, path.basename(resolvedCwd)) === resolvedCwd;
        } catch {
          return false;
        }
      })();
  if (!valid) {
    throw new AgentSessionHandoffStoreError(
      homeAccess === undefined
        ? 'a writer Agent session cwd must be the canonical Agent home'
        : 'a reader Agent session cwd must be a run directory under the canonical Agent home',
    );
  }
}

function sessionFileName(runtimeId: string, sessionRef: string): string {
  const digest = createHash('sha256').update(sessionRef, 'utf8').digest('hex');
  const runtime = runtimeId.replace(/[^a-z0-9._-]/giu, '_').slice(0, 64) || 'runtime';
  return `${runtime}-${digest}.jsonl`;
}

function taskTerminalFileName(runtimeId: string, taskId: string): string {
  const digest = createHash('sha256').update(taskId, 'utf8').digest('hex');
  const runtime = runtimeId.replace(/[^a-z0-9._-]/giu, '_').slice(0, 64) || 'runtime';
  return `${runtime}-task-${digest}.jsonl`;
}

async function evidenceDirectory(homeInput: string): Promise<string> {
  if (!path.isAbsolute(homeInput)) {
    throw new AgentSessionHandoffStoreError('Agent home must be absolute');
  }
  const cwd = await fs.realpath(homeInput);
  let cursor = cwd;
  for (const component of ['.byok', 'runtime-sessions']) {
    cursor = path.join(cursor, component);
    try {
      const stat = await fs.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new AgentSessionHandoffStoreError(`Agent session evidence path is not a real directory: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.mkdir(cursor, { mode: 0o700 });
    }
  }
  const canonical = await fs.realpath(cursor);
  const relative = path.relative(cwd, canonical);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AgentSessionHandoffStoreError('Agent session evidence path escaped the canonical Agent home');
  }
  return canonical;
}

/**
 * Durable, fail-closed session evidence stored inside the canonical Agent
 * home. Each session gets one hash-addressed append-only JSONL ledger under
 * `.byok/runtime-sessions/`; session text never becomes a pathname. Unlike
 * the legacy SessionWorkspaceStore, corrupt bytes are never interpreted as a
 * missing mapping. Reader sessions keep their ledger in the home too, not in
 * their run directory, so a resume can find the run directory by sessionRef.
 */
export class AgentSessionHandoffStore {
  private readonly queues = new Map<string, Promise<void>>();

  async get(expected: AgentSessionHandoffMatch): Promise<AgentSessionHandoff | undefined> {
    const filePath = await this.filePath(expected);
    return this.enqueue(filePath, () => this.load(filePath));
  }

  /** Append-only readback for audit/recovery; every historical terminal remains visible. */
  async history(expected: AgentSessionHandoffMatch): Promise<readonly AgentSessionHandoff[]> {
    const filePath = await this.filePath(expected);
    return this.enqueue(filePath, async () => {
      const entries = await this.loadAll(filePath);
      for (const entry of entries) {
        if (!sameMatch(entry, expected)) {
          throw new AgentSessionHandoffMismatchError(
            `Agent session history ${expected.sessionRef} contains a different AgentRef/profileRevision/runtime/cwd`,
          );
        }
      }
      return Object.freeze(entries);
    });
  }

  /** Exact identity check used before a strict Agent resume is admitted. */
  async requireMatch(expected: AgentSessionHandoffMatch): Promise<AgentSessionHandoff> {
    const entry = await this.get(expected);
    if (entry === undefined || !sameMatch(entry, expected)) {
      throw new AgentSessionHandoffMismatchError(
        `Agent session handoff ${expected.sessionRef} does not match AgentRef/profileRevision/runtime/cwd/homeAccess exactly`,
      );
    }
    return entry;
  }

  /**
   * The run directory a `memory-reader` session recorded, for its resume.
   * Throws a mismatch when no handoff exists, when the session was recorded
   * by a writer, or when the AgentRef or runtime differ.
   */
  async readerSessionCwd(
    expected: Omit<AgentSessionHandoffMatch, 'home' | 'cwd' | 'homeAccess'> & { readonly home: string },
  ): Promise<string> {
    const entry = await this.get({ ...expected, cwd: expected.home, homeAccess: 'memory-reader' });
    if (entry === undefined || entry.homeAccess !== 'memory-reader') {
      throw new AgentSessionHandoffMismatchError(
        `Agent session handoff ${expected.sessionRef} is not a memory-reader session`,
      );
    }
    const match = { ...expected, cwd: entry.cwd, homeAccess: 'memory-reader' as const };
    if (!sameMatch(entry, match)) {
      throw new AgentSessionHandoffMismatchError(
        `Agent session handoff ${expected.sessionRef} does not match AgentRef/profileRevision/runtime/cwd/homeAccess exactly`,
      );
    }
    assertCwdForAccess(expected.home, entry.cwd, 'memory-reader');
    return entry.cwd;
  }

  /**
   * Reader run directories that session ledgers of this home point to, each
   * with the last update time of its ledger in ms. Retention keeps these
   * directories until the record is older than the age limit. A corrupt
   * ledger throws, and the caller then skips retention.
   */
  async readerRunReferences(home: string): Promise<ReadonlyMap<string, number>> {
    const directory = await evidenceDirectory(home);
    const references = new Map<string, number>();
    for (const name of await fs.readdir(directory)) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(directory, name);
      const entry = await this.enqueue(filePath, () => this.loadSessionLedger(filePath));
      if (entry?.homeAccess !== 'memory-reader') continue;
      const updatedAt = Date.parse(entry.updatedAt);
      references.set(entry.cwd, Math.max(references.get(entry.cwd) ?? updatedAt, updatedAt));
    }
    return references;
  }

  /** Append-only, fsynced write. The caller awaits this before task.started. */
  async record(
    input: Omit<AgentSessionHandoff, 'updatedAt' | 'terminalCause' | 'terminalReason'> & { readonly home?: string },
  ): Promise<AgentSessionHandoff> {
    assertCwdForAccess(input.home ?? input.cwd, input.cwd, input.homeAccess);
    const filePath = await this.filePath(input);
    return this.enqueue(filePath, async () => {
      const prior = await this.load(filePath);
      const next = Object.freeze({
        agentRef: validateAgentRef(input.agentRef),
        taskId: input.taskId,
        sessionRef: input.sessionRef,
        runtimeId: input.runtimeId,
        cwd: path.resolve(input.cwd),
        ...(input.homeAccess === undefined ? {} : { homeAccess: 'memory-reader' as const }),
        leaseId: input.leaseId,
        updatedAt: new Date().toISOString(),
      });
      if (prior !== undefined && !sameMatch(prior, next)) {
        throw new AgentSessionHandoffMismatchError(
          `session ${input.sessionRef} is already bound to a different AgentRef/profileRevision/runtime/cwd/homeAccess`,
        );
      }
      await this.append(filePath, { version: 1, ...next });
      return next;
    });
  }

  /** Records the first terminal cause without changing the exact handoff identity. */
  async recordTerminal(
    expected: AgentSessionHandoffMatch,
    cause: AgentTerminalCause,
    reason?: string,
  ): Promise<AgentSessionHandoff> {
    const filePath = await this.filePath(expected);
    return this.enqueue(filePath, async () => {
      const existing = await this.load(filePath);
      if (existing === undefined || !sameMatch(existing, expected)) {
        throw new AgentSessionHandoffMismatchError(
          `cannot record terminal cause for ${expected.sessionRef}: exact Agent handoff match failed`,
        );
      }
      const updated = Object.freeze({
        ...existing,
        terminalCause: existing.terminalCause ?? cause,
        ...(existing.terminalReason === undefined && reason === undefined
          ? {}
          : { terminalReason: existing.terminalReason ?? reason }),
        updatedAt: new Date().toISOString(),
      });
      await this.append(filePath, { version: 1, ...updated });
      return updated;
    });
  }

  /**
   * Persists a claimed Agent task failure that happened before an active
   * session handoff existed. Callers await the fsync before sending
   * `task.fail`, so cloud state can never outrun the Agent-local evidence.
   */
  async recordTaskTerminal(
    input: Omit<AgentTaskTerminalEvidence, 'updatedAt' | 'terminalCause'> & { readonly home?: string },
  ): Promise<AgentTaskTerminalEvidence> {
    assertCwdForAccess(input.home ?? input.cwd, input.cwd, input.homeAccess);
    const expected: AgentTaskTerminalMatch = {
      agentRef: validateAgentRef(input.agentRef),
      taskId: input.taskId,
      runtimeId: input.runtimeId,
      ...(input.home === undefined ? {} : { home: input.home }),
      cwd: path.resolve(input.cwd),
      ...(input.homeAccess === undefined ? {} : { homeAccess: input.homeAccess }),
    };
    const filePath = await this.taskTerminalFilePath(expected);
    return this.enqueue(filePath, async () => {
      const prior = await this.loadTaskTerminal(filePath);
      if (prior !== undefined && !sameTaskTerminalMatch(prior, expected)) {
        throw new AgentSessionHandoffMismatchError(
          `task ${input.taskId} terminal evidence is bound to a different AgentRef/profileRevision/runtime/cwd`,
        );
      }
      const { home: _home, ...identity } = expected;
      const next = Object.freeze({
        ...identity,
        leaseId: input.leaseId,
        ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
        terminalCause: 'failed' as const,
        terminalReason: input.terminalReason,
        updatedAt: new Date().toISOString(),
      });
      await this.append(filePath, { version: 1, kind: 'task-terminal' as const, ...next });
      return next;
    });
  }

  async getTaskTerminal(expectedInput: AgentTaskTerminalMatch): Promise<AgentTaskTerminalEvidence | undefined> {
    const expected: AgentTaskTerminalMatch = {
      agentRef: validateAgentRef(expectedInput.agentRef),
      taskId: expectedInput.taskId,
      runtimeId: expectedInput.runtimeId,
      ...(expectedInput.home === undefined ? {} : { home: expectedInput.home }),
      cwd: path.resolve(expectedInput.cwd),
      ...(expectedInput.homeAccess === undefined ? {} : { homeAccess: expectedInput.homeAccess }),
    };
    const filePath = await this.taskTerminalFilePath(expected);
    return this.enqueue(filePath, async () => {
      const entry = await this.loadTaskTerminal(filePath);
      if (entry !== undefined && !sameTaskTerminalMatch(entry, expected)) {
        throw new AgentSessionHandoffMismatchError(
          `task ${expected.taskId} terminal evidence does not match AgentRef/profileRevision/runtime/cwd exactly`,
        );
      }
      return entry;
    });
  }

  private async filePath(
    match: Pick<AgentSessionHandoffMatch, 'agentRef' | 'sessionRef' | 'runtimeId' | 'home' | 'cwd'>,
  ): Promise<string> {
    validateAgentRef(match.agentRef);
    assertNonEmptyString(match.sessionRef, 'handoff.sessionRef');
    assertNonEmptyString(match.runtimeId, 'handoff.runtimeId');
    const directory = await evidenceDirectory(match.home ?? match.cwd);
    return path.join(directory, sessionFileName(match.runtimeId, match.sessionRef));
  }

  private async taskTerminalFilePath(match: AgentTaskTerminalMatch): Promise<string> {
    validateAgentRef(match.agentRef);
    assertNonEmptyString(match.taskId, 'taskTerminal.taskId');
    assertNonEmptyString(match.runtimeId, 'taskTerminal.runtimeId');
    const directory = await evidenceDirectory(match.home ?? match.cwd);
    return path.join(directory, taskTerminalFileName(match.runtimeId, match.taskId));
  }

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(key, tail);
    void tail.finally(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return result;
  }

  private async load(filePath: string): Promise<AgentSessionHandoff | undefined> {
    return (await this.loadAll(filePath)).at(-1);
  }

  /**
   * The latest session entry of one ledger file, or `undefined` for a
   * task-terminal evidence file. The two file kinds share one directory, and
   * a runtime id can make their names look alike, so the record kind decides.
   */
  private async loadSessionLedger(filePath: string): Promise<AgentSessionHandoff | undefined> {
    let first: unknown;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const line = raw.split('\n').find((candidate) => candidate.length > 0);
      if (line === undefined) return undefined;
      first = JSON.parse(line) as unknown;
    } catch (error) {
      throw new AgentSessionHandoffCorruptError(
        `Agent session evidence is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (isRecord(first) && first.kind === 'task-terminal') return undefined;
    return this.load(filePath);
  }

  private async loadAll(filePath: string): Promise<AgentSessionHandoff[]> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new AgentSessionHandoffStoreError(
        `could not read Agent session handoff: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const lines = raw.split('\n').filter((line) => line.length > 0);
      return lines.map((line) => parseEntry(JSON.parse(line) as unknown));
    } catch (error) {
      if (error instanceof AgentSessionHandoffStoreError) throw error;
      throw new AgentSessionHandoffCorruptError(
        `Agent session handoff is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async loadTaskTerminal(filePath: string): Promise<AgentTaskTerminalEvidence | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new AgentSessionHandoffStoreError(
        `could not read Agent task terminal evidence: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const lines = raw.split('\n').filter((line) => line.length > 0);
      const entries = lines.map((line) => parseTaskTerminalEntry(JSON.parse(line) as unknown));
      return entries.at(-1);
    } catch (error) {
      if (error instanceof AgentSessionHandoffStoreError) throw error;
      throw new AgentSessionHandoffCorruptError(
        `Agent task terminal evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async append(filePath: string, value: StoredShape | StoredTaskTerminalShape): Promise<void> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(filePath, 'a', 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Sync each name-bearing directory even when it already existed: a
      // previous attempt may have created it but failed its durability barrier.
      // The caller supplies the canonical home; its ancestors remain outside
      // this store's ownership. Node has no Windows directory-fsync surface.
      if (process.platform !== 'win32') {
        let directory = path.dirname(filePath);
        for (let depth = 0; depth < 3; depth++) {
          const parent = await fs.open(directory, 'r');
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
          directory = path.dirname(directory);
        }
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      throw new AgentSessionHandoffStoreError(
        `could not durably write Agent session handoff: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
