import { CloudDoError, type CloudDoErrorCode } from './errors';
import type { CloudOperationGuard } from './input-guard';

export type InvocationState = 'accepted' | 'running' | 'succeeded' | 'failed' | 'aborted' | 'interrupted' | 'timed_out';
export type InvocationTerminalState = Exclude<InvocationState, 'accepted' | 'running'>;
export interface InvocationInput {
  invocationId: string;
  sessionId: string;
  conversationId: number;
  assistantEntryId: number;
  toolCallId: string;
  toolName: string;
  argsDigest: string;
  argsJson: string;
  replay: 'safe' | 'unsafe';
  deadlineAt: number;
}
export interface InvocationRow extends InvocationInput {
  seq: number;
  state: InvocationState;
  attempt: number;
  replayCount: number;
  abortRequested: number;
  resultJson: string | null;
  settledAt: number | null;
  settledEventSeq: number | null;
  errorCode: CloudDoErrorCode | null;
  mode: 'inline' | 'job';
  segmentStartedAt: number | null;
  nextSegmentAt: number | null;
  jobStateJson: string | null;
  progressJson: string | null;
  deliveredState?: 'delivered' | 'undelivered';
  taskId?: number | null;
  resultEntryId?: number | null;
}
export interface ExecutionRow {
  conversationId: number;
  deadlineAt: number;
  steps: number;
  tools: number;
  fatalCode: CloudDoErrorCode | null;
  aborted: number;
}
export interface InvocationFinishOptions {
  /** An old attempt cannot settle an invocation claimed by recovery. */
  attempt?: number;
  clientConnected?: boolean;
  /** Ledger recovery may settle after the old native conversation was aborted. */
  recovery?: boolean;
}

export interface InvocationLedgerOptions {
  started?(row: InvocationRow, guard?: CloudOperationGuard): void;
  startedCommitted?(row: InvocationRow): void;
  /** Runs inside the state transaction. Errors roll back state and events together. */
  terminal?(row: InvocationRow, recovery: boolean): { seq: number; createdAt: number } | void;
  /** Post-commit notification cannot affect the invocation outcome. */
  committed?(row: InvocationRow): void;
}

const terminal = (state: InvocationState) => state !== 'accepted' && state !== 'running';
const fatalCodes = new Set<CloudDoErrorCode>([
  'CLOUD_TOOL_RESULT_LIMIT', 'CLOUD_TOOL_LIMIT', 'CLOUD_STEP_LIMIT',
  'CLOUD_TOOL_TIMEOUT', 'CLOUD_EXECUTION_TIMEOUT',
]);

/** Host tables share the DO database with the pi_ tables. No function enters storage. */
export class InvocationLedger {
  constructor(private readonly storage: DurableObjectStorage, private readonly options: InvocationLedgerOptions = {}) {}

  /** The host calls this only after credential and identity preflight. */
  ensureSchema(): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cloud_invocations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        invocationId TEXT NOT NULL UNIQUE, sessionId TEXT NOT NULL,
        conversationId INTEGER NOT NULL, assistantEntryId INTEGER NOT NULL,
        toolCallId TEXT NOT NULL, toolName TEXT NOT NULL,
        argsDigest TEXT NOT NULL, argsJson TEXT NOT NULL,
        replay TEXT NOT NULL CHECK (replay IN ('safe','unsafe')),
        state TEXT NOT NULL CHECK (state IN ('accepted','running','succeeded','failed','aborted','interrupted','timed_out')),
        attempt INTEGER NOT NULL, replayCount INTEGER NOT NULL DEFAULT 0,
        deadlineAt INTEGER NOT NULL, abortRequested INTEGER NOT NULL DEFAULT 0,
        resultJson TEXT, errorCode TEXT,
        mode TEXT NOT NULL DEFAULT 'inline' CHECK (mode IN ('inline','job')),
        segmentStartedAt INTEGER, nextSegmentAt INTEGER, jobStateJson TEXT, progressJson TEXT
      );
      CREATE INDEX IF NOT EXISTS cloud_invocations_pending ON cloud_invocations(state,seq);
      CREATE TABLE IF NOT EXISTS cloud_executions (
        conversationId INTEGER PRIMARY KEY, deadlineAt INTEGER NOT NULL,
        steps INTEGER NOT NULL DEFAULT 0, tools INTEGER NOT NULL DEFAULT 0,
        fatalCode TEXT, aborted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS cloud_counted_tools (
        conversationId INTEGER NOT NULL, taskId TEXT NOT NULL,
        PRIMARY KEY(conversationId,taskId)
      )`);
      const columns = new Set(this.storage.sql.exec<{ name: string }>('PRAGMA table_info(cloud_invocations)').toArray().map(row => row.name));
      for (const name of ['settledAt', 'settledEventSeq']) {
        if (!columns.has(name)) this.storage.sql.exec(`ALTER TABLE cloud_invocations ADD COLUMN ${name} INTEGER`);
      }
    });
  }

  read(id: string): InvocationRow | undefined {
    return this.storage.sql.exec<InvocationRow & Record<string, SqlStorageValue>>('SELECT * FROM cloud_invocations WHERE invocationId = ?', id).toArray()[0];
  }

  pending(): InvocationRow[] {
    return this.storage.sql.exec<InvocationRow & Record<string, SqlStorageValue>>("SELECT * FROM cloud_invocations WHERE state IN ('accepted','running') ORDER BY seq").toArray();
  }

  begin(input: InvocationInput, guard?: CloudOperationGuard): { kind: 'started' | 'pending' | 'settled'; row: InvocationRow } {
    const begun = this.storage.transactionSync<{ kind: 'started' | 'pending' | 'settled'; row: InvocationRow }>(() => {
      const previous = this.read(input.invocationId);
      if (previous) {
        if (previous.argsDigest !== input.argsDigest || previous.toolName !== input.toolName) {
          throw new CloudDoError('CLOUD_TOOL_INVOCATION_CONFLICT');
        }
        return { kind: terminal(previous.state) ? 'settled' : 'pending', row: previous };
      }
      this.storage.sql.exec(`INSERT INTO cloud_invocations
        (invocationId,sessionId,conversationId,assistantEntryId,toolCallId,toolName,argsDigest,argsJson,replay,state,attempt,deadlineAt)
        VALUES (?,?,?,?,?,?,?,?,?,'running',1,?)`, input.invocationId, input.sessionId,
      input.conversationId, input.assistantEntryId, input.toolCallId, input.toolName,
      input.argsDigest, input.argsJson, input.replay, input.deadlineAt);
      const row = this.read(input.invocationId)!;
      this.options.started?.(row, guard);
      return { kind: 'started', row };
    });
    if (begun.kind === 'started') {
      try { this.options.startedCommitted?.(begun.row); }
      catch { /* A doorbell cannot change a committed invocation. */ }
    }
    return begun;
  }

  finish(id: string, state: InvocationTerminalState, result?: Record<string, unknown>, errorCode?: CloudDoErrorCode,
    now = Date.now(), options: InvocationFinishOptions = {}): InvocationRow | undefined {
    let changed: InvocationRow | undefined;
    const resultRow = this.storage.transactionSync(() => {
      const row = this.read(id);
      if (!row || terminal(row.state) || (options.attempt !== undefined && options.attempt !== row.attempt)) return row;
      const execution = this.execution(row.conversationId);
      let settledState = state;
      let settledError = errorCode ?? null;
      if (state === 'succeeded') {
        if (row.abortRequested || options.clientConnected === false || (!options.recovery && execution?.aborted)) {
          settledState = 'aborted'; settledError = 'CLOUD_EXECUTION_ABORTED';
        } else if (now >= row.deadlineAt || (execution && now >= execution.deadlineAt)) {
          settledState = 'timed_out';
          settledError = execution && now >= execution.deadlineAt ? 'CLOUD_EXECUTION_TIMEOUT' : 'CLOUD_TOOL_TIMEOUT';
        } else if (!options.recovery && execution?.fatalCode) {
          settledState = 'failed'; settledError = execution.fatalCode;
        }
      }
      this.storage.sql.exec(`UPDATE cloud_invocations SET state=?,resultJson=?,errorCode=?
        WHERE invocationId=? AND attempt=? AND state IN ('accepted','running')`,
      settledState, settledState === 'succeeded' && result !== undefined ? JSON.stringify(result) : null, settledError, id, row.attempt);
      if (settledError && fatalCodes.has(settledError)) this.failExecution(row.conversationId, settledError);
      changed = this.read(id)!;
      changed = this.#terminal(changed, options.recovery === true);
      return changed;
    });
    if (changed) this.#notify(changed);
    return resultRow;
  }

  #terminal(row: InvocationRow, recovery: boolean): InvocationRow {
    const event = this.options.terminal?.(row, recovery);
    if (event) {
      this.storage.sql.exec('UPDATE cloud_invocations SET settledAt=?,settledEventSeq=? WHERE invocationId=?', event.createdAt, event.seq, row.invocationId);
    }
    return this.read(row.invocationId)!;
  }

  #notify(row: InvocationRow): void {
    try { this.options.committed?.(row); }
    catch { /* The state and event are already committed. */ }
  }

  /** Claim before network replay. A second restart never dispatches a claimed row again. */
  claimRecovery(now = Date.now()): InvocationRow[] {
    const settled: InvocationRow[] = [];
    const claimed = this.storage.transactionSync(() => {
      const claimed: InvocationRow[] = [];
      for (const row of this.pending()) {
        const execution = this.execution(row.conversationId);
        if (row.abortRequested || execution?.aborted) {
          this.storage.sql.exec(`UPDATE cloud_invocations SET state='aborted',resultJson=NULL,errorCode='CLOUD_EXECUTION_ABORTED'
            WHERE invocationId=? AND state IN ('accepted','running')`, row.invocationId);
        } else if (now >= row.deadlineAt || (execution && now >= execution.deadlineAt)) {
          const code = execution && now >= execution.deadlineAt ? 'CLOUD_EXECUTION_TIMEOUT' : 'CLOUD_TOOL_TIMEOUT';
          this.storage.sql.exec(`UPDATE cloud_invocations SET state='timed_out',resultJson=NULL,errorCode=?
            WHERE invocationId=? AND state IN ('accepted','running')`, code, row.invocationId);
          this.failExecution(row.conversationId, code);
        } else if (row.replay === 'safe' && row.mode === 'inline' && row.replayCount === 0) {
          this.storage.sql.exec(`UPDATE cloud_invocations SET replayCount=1,attempt=attempt+1,state='running'
            WHERE invocationId=? AND replayCount=0 AND state IN ('accepted','running')`, row.invocationId);
          claimed.push(this.read(row.invocationId)!);
        } else {
          this.storage.sql.exec(`UPDATE cloud_invocations SET state=?,resultJson=NULL,errorCode='CLOUD_EXECUTION_INTERRUPTED'
            WHERE invocationId=? AND state IN ('accepted','running')`,
          row.replayCount >= 1 ? 'failed' : 'interrupted', row.invocationId);
        }
        const updated = this.read(row.invocationId)!;
        if (terminal(updated.state)) {
          settled.push(this.#terminal(updated, true));
        }
      }
      return claimed;
    });
    for (const row of settled) this.#notify(row);
    return claimed;
  }

  forConversation(conversationId: number): InvocationRow[] {
    return this.storage.sql.exec<InvocationRow & Record<string, SqlStorageValue>>('SELECT * FROM cloud_invocations WHERE conversationId=? ORDER BY seq', conversationId).toArray();
  }

  startExecution(conversationId: number, deadlineAt: number): ExecutionRow {
    this.storage.sql.exec('INSERT INTO cloud_executions(conversationId,deadlineAt) VALUES (?,?) ON CONFLICT(conversationId) DO NOTHING', conversationId, deadlineAt);
    return this.execution(conversationId)!;
  }

  execution(conversationId: number): ExecutionRow | undefined {
    return this.storage.sql.exec<ExecutionRow & Record<string, SqlStorageValue>>('SELECT * FROM cloud_executions WHERE conversationId=?', conversationId).toArray()[0];
  }

  failExecution(conversationId: number, code: CloudDoErrorCode): ExecutionRow | undefined {
    this.storage.sql.exec('UPDATE cloud_executions SET fatalCode=COALESCE(fatalCode,?) WHERE conversationId=?', code, conversationId);
    return this.execution(conversationId);
  }

  abortExecution(conversationId: number, code: CloudDoErrorCode): ExecutionRow | undefined {
    return this.storage.transactionSync(() => {
      this.storage.sql.exec('UPDATE cloud_executions SET aborted=1,fatalCode=COALESCE(fatalCode,?) WHERE conversationId=?', code, conversationId);
      this.storage.sql.exec(`UPDATE cloud_invocations SET abortRequested=1
        WHERE conversationId=? AND state IN ('accepted','running')`, conversationId);
      return this.execution(conversationId);
    });
  }

  private executionRejection(row: ExecutionRow, now: number): CloudDoErrorCode | undefined {
    if (row.fatalCode) return row.fatalCode;
    if (row.aborted) return 'CLOUD_EXECUTION_ABORTED';
    if (now >= row.deadlineAt) return 'CLOUD_EXECUTION_TIMEOUT';
    return undefined;
  }

  countModel(conversationId: number, maxSteps = 8, now = Date.now()): ExecutionRow {
    const outcome = this.storage.transactionSync(() => {
      const row = this.execution(conversationId);
      if (!row) return { code: 'CLOUD_EXECUTION_INTERRUPTED' as const };
      const code = this.executionRejection(row, now) ?? (row.steps >= maxSteps ? 'CLOUD_STEP_LIMIT' : undefined);
      if (code) { this.failExecution(conversationId, code); return { code }; }
      this.storage.sql.exec('UPDATE cloud_executions SET steps=steps+1 WHERE conversationId=?', conversationId);
      return { row: this.execution(conversationId)! };
    });
    // Throw outside the transaction so the fatal disposition remains durable.
    if (outcome.code) throw new CloudDoError(outcome.code);
    return outcome.row!;
  }

  countTool(conversationId: number, taskId: string, maxTools = 12, now = Date.now()): ExecutionRow {
    const outcome = this.storage.transactionSync(() => {
      const row = this.execution(conversationId);
      if (!row) return { code: 'CLOUD_EXECUTION_INTERRUPTED' as const };
      const stopped = this.executionRejection(row, now);
      if (stopped) { this.failExecution(conversationId, stopped); return { code: stopped }; }
      const counted = this.storage.sql.exec('SELECT taskId FROM cloud_counted_tools WHERE conversationId=? AND taskId=?', conversationId, taskId).toArray()[0];
      if (counted) return { row };
      if (row.tools >= maxTools) {
        this.failExecution(conversationId, 'CLOUD_TOOL_LIMIT');
        return { code: 'CLOUD_TOOL_LIMIT' as const };
      }
      this.storage.sql.exec('INSERT INTO cloud_counted_tools(conversationId,taskId) VALUES (?,?)', conversationId, taskId);
      this.storage.sql.exec('UPDATE cloud_executions SET tools=tools+1 WHERE conversationId=?', conversationId);
      return { row: this.execution(conversationId)! };
    });
    if (outcome.code) throw new CloudDoError(outcome.code);
    return outcome.row!;
  }
}
