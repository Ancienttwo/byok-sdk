import { canTransition, type TaskState } from '@byok/protocol';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { openSqliteDatabase, secureSqliteFilePermissions } from './sqlite-support';
import { IllegalTaskTransitionError, type CreateTaskInput, type TaskRecord, type TaskStore } from './task-store';
import type { TaskResult } from './types';

export interface SqliteTaskStoreOptions {
  /**
   * Database file path. Use `:memory:` to exercise the SQLite code path
   * without a temp file (e.g. schema/query correctness tests) — but note
   * that defeats the entire point of this store (restart-safety), since an
   * in-memory SQLite database vanishes with the process exactly like
   * `InMemoryTaskStore` does. Real persistence requires a real file path.
   */
  path: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id     TEXT PRIMARY KEY,
  state       TEXT NOT NULL,
  instruction TEXT NOT NULL,
  runtime     TEXT,
  policy_json TEXT NOT NULL,
  device_id   TEXT,
  session_ref TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  result_json TEXT
);
`;

function rowToRecord(row: Record<string, unknown>): TaskRecord {
  const resultJson = row.result_json as string | null;
  return {
    taskId: row.task_id as string,
    state: row.state as TaskState,
    instruction: row.instruction as string,
    runtime: ((row.runtime as string | null) ?? undefined) as TaskRecord['runtime'],
    policy: JSON.parse(row.policy_json as string) as TaskRecord['policy'],
    deviceId: (row.device_id as string | null) ?? undefined,
    sessionRef: (row.session_ref as string | null) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    result: resultJson ? (JSON.parse(resultJson) as TaskResult) : undefined,
  };
}

/**
 * Persistent {@link TaskStore} backed by the Node.js built-in `node:sqlite`
 * module — no native dependency (`sqlite-support.ts`'s doc comment explains
 * why that's a hard requirement here). A fresh instance pointed at the same
 * database file recovers every task's full RECORD (instruction, policy,
 * device/session refs, result) exactly as `InMemoryTaskStore` would have
 * held it in memory — this is the M3 "task records survive a process
 * restart" story.
 *
 * Scope of that claim, precisely: this is RECORD persistence, not live
 * active-task recovery. A fresh `ConnectionHub` (`hub.ts`) wired to a
 * reopened store starts with empty runtimes/result-promises/event-queues/
 * device-registry/outboxes — so a task that was `Running` at restart comes
 * back as a `Running` *record* you can read and further `transition()`, not
 * as a task with its device/runtime connection reattached that will go on
 * to actually produce more events. Recovering/resuming an in-flight task's
 * live connection is a larger feature and out of scope here.
 *
 * Every write goes through a compare-and-set `UPDATE ... WHERE task_id = ?
 * AND state = ?` (the state {@link transition} just validated against), not
 * an unconditional update: two connections racing on the same task (both
 * reading e.g. `Running`, both independently validating a different target
 * state) can't both commit, which would otherwise let the later write
 * silently perform an illegal transition — including terminal -> terminal —
 * that neither validation call would have allowed had it seen the other's
 * write first. A lost compare-and-set re-reads the row and either
 * re-validates the requested move against the state that actually won, or
 * throws {@link IllegalTaskTransitionError} against it.
 *
 * Requires Node.js 22.5+ (`node:sqlite`'s minimum); constructing this on an
 * older/unsupported runtime throws `SqliteUnavailableError`
 * (`sqlite-support.ts`) with a clear message rather than a cryptic "Cannot
 * find module" trace.
 *
 * Enforces the exact same `TASK_TRANSITIONS`/`canTransition` state machine
 * as `InMemoryTaskStore`, via the same {@link IllegalTaskTransitionError}.
 */
export class SqliteTaskStore implements TaskStore {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly updateStmt: StatementSync;
  private readonly selectStmt: StatementSync;
  private readonly selectAllStmt: StatementSync;

  constructor(opts: SqliteTaskStoreOptions) {
    this.db = openSqliteDatabase(opts.path);
    this.db.exec(SCHEMA);
    secureSqliteFilePermissions(opts.path);
    this.insertStmt = this.db.prepare(
      `INSERT INTO tasks
         (task_id, state, instruction, runtime, policy_json, device_id, session_ref, created_at, updated_at, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // A separate UPDATE-in-place (rather than reusing `INSERT OR REPLACE`,
    // which is a delete+insert under the hood) so a transitioned task keeps
    // its original `rowid` — `list()`'s `ORDER BY rowid ASC` must stay in
    // creation order across transitions, mirroring `InMemoryTaskStore`'s
    // `Map`, where `.set()` on an existing key never moves it in iteration
    // order either.
    //
    // `AND state = ?` makes this a compare-and-set rather than an
    // unconditional update: `transition()` binds the FROM-state it just
    // validated against as the last parameter, so the write only lands if
    // the row is still in that state — see `transition()`'s doc comment.
    this.updateStmt = this.db.prepare(
      `UPDATE tasks SET
         state = ?, instruction = ?, runtime = ?, policy_json = ?, device_id = ?,
         session_ref = ?, created_at = ?, updated_at = ?, result_json = ?
       WHERE task_id = ? AND state = ?`,
    );
    this.selectStmt = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?');
    this.selectAllStmt = this.db.prepare('SELECT * FROM tasks ORDER BY rowid ASC');
  }

  create(input: CreateTaskInput): TaskRecord {
    const now = new Date().toISOString();
    const record: TaskRecord = {
      taskId: input.taskId,
      state: 'Offered',
      instruction: input.instruction,
      runtime: input.runtime,
      policy: input.policy,
      deviceId: input.deviceId,
      sessionRef: input.sessionRef,
      createdAt: now,
      updatedAt: now,
    };
    this.insertStmt.run(
      record.taskId,
      record.state,
      record.instruction,
      record.runtime ?? null,
      JSON.stringify(record.policy),
      record.deviceId ?? null,
      record.sessionRef ?? null,
      record.createdAt,
      record.updatedAt,
      record.result ? JSON.stringify(record.result) : null,
    );
    return record;
  }

  get(taskId: string): TaskRecord | undefined {
    const row = this.selectStmt.get(taskId);
    return row ? rowToRecord(row) : undefined;
  }

  list(): TaskRecord[] {
    return this.selectAllStmt.all().map(rowToRecord);
  }

  /**
   * Apply `taskId`'s state -> `to`, merging `patch` into the record. Throws
   * {@link IllegalTaskTransitionError} if the move isn't legal per
   * `TASK_TRANSITIONS`, and if the task doesn't exist at all — identical
   * contract and error shapes to `InMemoryTaskStore.transition`.
   *
   * Implemented as a compare-and-set retry loop rather than a single
   * read-validate-write, because two separate connections (two processes,
   * or two `SqliteTaskStore` instances in this one) can both read the same
   * current state and both validate a move against it before either writes.
   * An unconditional `UPDATE` would let whichever commits last silently win
   * — including an illegal terminal -> terminal transition neither
   * validation call would have allowed with up-to-date information. Each
   * iteration here reads the CURRENT state fresh, validates `to` against
   * it, then writes with `WHERE state = <the state just validated>`
   * (`updateStmt`). If zero rows changed, some other writer committed
   * between this read and this write, so the loop re-reads and either
   * re-validates `to` against whatever the state actually is now, or throws
   * {@link IllegalTaskTransitionError} against it — the same outcome a
   * caller would get if it happened to run a moment later.
   */
  transition(taskId: string, to: TaskState, patch: Partial<Omit<TaskRecord, 'taskId' | 'state'>> = {}): TaskRecord {
    for (;;) {
      const record = this.get(taskId);
      if (!record) {
        throw new Error(`unknown taskId: ${taskId}`);
      }
      if (!canTransition(record.state, to)) {
        throw new IllegalTaskTransitionError(taskId, record.state, to);
      }
      const updated: TaskRecord = {
        ...record,
        ...patch,
        state: to,
        updatedAt: new Date().toISOString(),
      };
      const { changes } = this.updateStmt.run(
        updated.state,
        updated.instruction,
        updated.runtime ?? null,
        JSON.stringify(updated.policy),
        updated.deviceId ?? null,
        updated.sessionRef ?? null,
        updated.createdAt,
        updated.updatedAt,
        updated.result ? JSON.stringify(updated.result) : null,
        updated.taskId,
        record.state,
      );
      if (Number(changes) > 0) {
        return updated;
      }
      // Lost the compare-and-set: `taskId` changed state under us between
      // the read and the write above. Loop back and re-validate against
      // the (now current) real state instead of returning stale success.
    }
  }

  /**
   * Close the underlying database connection. Not part of the `TaskStore`
   * interface (an in-memory store has nothing to close) — call this
   * explicitly when a store instance is done, e.g. before opening a second
   * instance against the same file, or on process shutdown.
   */
  close(): void {
    this.db.close();
  }
}
