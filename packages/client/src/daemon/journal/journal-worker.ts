/**
 * The journal worker thread: the only owner of the journal's writable SQLite
 * handle, so no commit (and no fsync) ever runs on the daemon's event loop.
 *
 * Group commit. Requests are taken in arrival order. Consecutive writes share
 * one `BEGIN IMMEDIATE` … `COMMIT`, each inside its own savepoint, so a write
 * that throws rolls back alone. Whatever arrives while a commit is running
 * forms the next batch; nothing waits on a timer. A write's reply is sent only
 * after the `COMMIT` of its batch has returned under `synchronous=FULL`, so a
 * resolved append is a durable append. A failed `COMMIT` rejects every write
 * in its batch. A read or maintenance operation commits the open batch first
 * and runs alone, so it never sees rows that a later failed commit discards.
 *
 * Bundled into a string at build time (`scripts/journal-worker-source.ts`)
 * and started with `eval`, so it ships inside every bundle of the client.
 */
import { receiveMessageOnPort, workerData } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { JournalHandleCleanupError, openJournalConnection } from '../../util/sqlite-support.js';
import { JournalStore, type JournalWrite } from './journal-store.js';
import {
  decodeError,
  encodeError,
  JOURNAL_MAX_BATCH_WRITES,
  JOURNAL_WRITE_OPS,
  type JournalHostAnswer,
  type JournalHostCall,
  type JournalOpenReply,
  type JournalRequest,
  type JournalResponse,
  type JournalWorkerData,
} from './journal-worker-protocol.js';
import type { JournalFaultStep } from './sqlite-journal.js';

const data = workerData as JournalWorkerData;
const WRITES: ReadonlySet<string> = new Set(JOURNAL_WRITE_OPS);
/**
 * Writes that call the journal's thread mid-transaction (prune checks each
 * stored cancellation binding there). Each runs in a transaction of its own,
 * so a stalled journal thread delays only this write, never the commit of
 * other writes that would have shared its batch.
 */
const WRITES_ALONE: ReadonlySet<string> = new Set(['pruneConfirmedJournalTask']);
const SAVEPOINT = 'journal_op';

/** A synchronous call to the journal's own thread; this thread waits for the answer. */
function host(call: JournalHostCall): unknown {
  Atomics.store(data.signal, 1, 0);
  data.hostPort.postMessage(call);
  Atomics.wait(data.signal, 1, 0);
  const answer = receiveMessageOnPort(data.hostPort)?.message as JournalHostAnswer | undefined;
  if (answer === undefined) throw new Error('the journal thread did not answer a host call');
  if (!answer.ok) throw decodeError(answer.error);
  return answer.value;
}

/** The test fault seam: the closure lives on the journal's thread and throws exactly where it threw there. */
function fault(step: JournalFaultStep): void {
  if (data.faults === undefined) return;
  // Ends this thread the way a crash or an out-of-memory kill would.
  if (data.faults.exitWorkerAt === step) process.exit(70);
  host({ kind: 'fault', step });
}

function handshake(reply: JournalOpenReply): void {
  data.port.postMessage(reply);
  Atomics.store(data.signal, 0, 1);
  Atomics.notify(data.signal, 0);
}

// Test fault seam: a worker that dies before it answers the handshake.
if (data.faults?.exitWorkerAt === 'open') process.exit(70);
let db: DatabaseSync | undefined;
try {
  db = openJournalConnection(data.dbPath, data.busyTimeoutMs);
} catch (error) {
  // `openJournalConnection` closes its handle before throwing, unless it says otherwise.
  handshake({ ok: false, error: encodeError(error), closed: !(error instanceof JournalHandleCleanupError) });
  data.port.close();
}
if (db !== undefined) serve(db);

function serve(db: DatabaseSync): void {
  const store = new JournalStore(db, {
    dbPath: data.dbPath,
    quarantineDir: data.quarantineDir,
    fault,
    cancellationSeq: (bytes, taskId, offerSeq) => host({ kind: 'cancellationSeq', bytes, taskId, offerSeq }) as number,
  });
  const queue: JournalRequest[] = [];
  let scheduled = false;
  /** Writes in the open transaction, answered once it commits. */
  let uncommitted: Array<{ readonly id: number; readonly write: JournalWrite<unknown> }> = [];

  const reply = (response: JournalResponse): void => data.port.postMessage(response);
  const fail = (id: number, error: unknown): void => reply({ id, ok: false, error: encodeError(error) });
  const call = (op: string, args: readonly unknown[]): unknown =>
    Reflect.apply((store as unknown as Record<string, (...args: unknown[]) => unknown>)[op]!, store, args);

  /** The open transaction is lost: nothing in it committed. */
  const abort = (error: unknown): void => {
    if (db.isTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* SQLite already rolled back */ }
    }
    for (const { id } of uncommitted) fail(id, error);
    uncommitted = [];
  };

  const commit = (): void => {
    if (!db.isTransaction) return;
    const batch = uncommitted;
    uncommitted = [];
    try {
      db.exec('COMMIT');
    } catch (error) {
      uncommitted = batch;
      abort(error);
      return;
    }
    for (const { id, write } of batch) {
      try {
        for (const step of write.afterCommit) fault(step);
        reply({ id, ok: true, value: write.value });
      } catch (error) {
        fail(id, error);
      }
    }
  };

  const write = (id: number, op: string, args: readonly unknown[]): void => {
    try {
      if (!db.isTransaction) db.exec('BEGIN IMMEDIATE');
      db.exec(`SAVEPOINT ${SAVEPOINT}`);
    } catch (error) {
      abort(error);
      fail(id, error);
      return;
    }
    let result: JournalWrite<unknown>;
    try {
      result = call(op, args) as JournalWrite<unknown>;
      db.exec(`RELEASE ${SAVEPOINT}`);
    } catch (error) {
      if (!db.isTransaction) {
        // SQLite rolled the whole transaction back (IO error, disk full):
        // the writes before this one are gone with it.
        abort(error);
      } else {
        try {
          db.exec(`ROLLBACK TO ${SAVEPOINT}`);
          db.exec(`RELEASE ${SAVEPOINT}`);
        } catch (rollbackError) {
          abort(rollbackError);
        }
      }
      fail(id, error);
      return;
    }
    uncommitted.push({ id, write: result });
    if (uncommitted.length >= JOURNAL_MAX_BATCH_WRITES) commit();
  };

  const drain = (): void => {
    scheduled = false;
    for (const request of queue.splice(0)) {
      if (request.op === 'close') {
        commit();
        try {
          db.close();
        } catch (error) {
          fail(request.id, error);
          data.port.close();
          return;
        }
        reply({ id: request.id, ok: true, value: undefined });
        data.port.close();
        return;
      }
      if (WRITES_ALONE.has(request.op)) {
        commit();
        write(request.id, request.op, request.args);
        commit();
        continue;
      }
      if (WRITES.has(request.op)) {
        write(request.id, request.op, request.args);
        continue;
      }
      commit();
      try {
        reply({ id: request.id, ok: true, value: call(request.op, request.args) });
      } catch (error) {
        fail(request.id, error);
      }
    }
    commit();
  };

  data.port.on('message', (request: JournalRequest) => {
    queue.push(request);
    if (!scheduled) {
      scheduled = true;
      setImmediate(drain);
    }
  });
  handshake({ ok: true });
}
