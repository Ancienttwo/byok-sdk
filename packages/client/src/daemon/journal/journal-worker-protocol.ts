/**
 * What crosses between `SqliteLocalTaskJournal` (the daemon's thread) and the
 * journal worker thread. Both sides import this module; nothing else does.
 */
import type { MessagePort } from 'node:worker_threads';
import { JournalIntegrityError, JournalRecordTooLargeError, JournalUnknownTaskError } from './journal.js';
import type { JournalStore, JournalWrite } from './journal-store.js';

/** Operations that write: they share the worker's batch transaction, each in its own savepoint. */
export const JOURNAL_WRITE_OPS = [
  'appendEnvelope',
  'appendWithheldOffer',
  'recordAdmission',
  'recordTransition',
  'recordTerminal',
  'replaceRefusedTerminal',
  'terminalDisposition',
  'markRecovered',
  'pruneConfirmedJournalTask',
] as const;

/** Operations that run alone, after the batch before them has committed: they see committed state only. */
export const JOURNAL_SOLO_OPS = [
  'readTask',
  'readTaskCancellation',
  'listRecoveryTasks',
  'listPendingTerminals',
  'listRecoverable',
  'measureUsage',
  'listPrunableConfirmedTasks',
  'compact',
] as const;

export type JournalWriteOp = (typeof JOURNAL_WRITE_OPS)[number];
export type JournalSoloOp = (typeof JOURNAL_SOLO_OPS)[number];
export type JournalOp = JournalWriteOp | JournalSoloOp;

export type JournalOpArgs<K extends JournalOp> = Parameters<JournalStore[K]>;
export type JournalOpResult<K extends JournalOp> = ReturnType<JournalStore[K]> extends JournalWrite<infer T> ? T : ReturnType<JournalStore[K]>;

/**
 * The most writes one transaction carries. Bounds the commit size and how long
 * one batch holds the worker; a larger queue commits in several batches.
 */
export const JOURNAL_MAX_BATCH_WRITES = 64;

export interface JournalWorkerData {
  readonly dbPath: string;
  readonly quarantineDir: string;
  readonly busyTimeoutMs: number;
  readonly maxRecordBytes: number;
  /** Set only when a test supplied a fault seam: the worker then asks the daemon's thread at every step. */
  readonly faults?: { readonly exitWorkerAt?: string };
  /** `[0]` open handshake, `[1]` fault verdict. */
  readonly signal: Int32Array;
  readonly port: MessagePort;
  readonly faultPort?: MessagePort;
}

export type JournalRequest =
  | { readonly id: number; readonly op: JournalOp; readonly args: readonly unknown[] }
  | { readonly id: number; readonly op: 'close' };

export type JournalResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: WireError };

/** The open handshake, read synchronously by the constructor. */
export type JournalOpenReply = { readonly ok: true } | { readonly ok: false; readonly error: WireError; readonly closed: boolean };

export interface WireError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly taskId?: string;
  readonly field?: string;
  readonly actualBytes?: number;
  readonly limitBytes?: number;
  readonly code?: unknown;
  readonly errcode?: unknown;
  readonly errstr?: unknown;
  readonly cause?: WireError;
}

/** Structured clone drops an error's class and own fields; this keeps the ones callers branch on. */
export function encodeError(error: unknown): WireError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const fields = error as Error & Partial<Record<'taskId' | 'field' | 'actualBytes' | 'limitBytes' | 'code' | 'errcode' | 'errstr', unknown>>;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(typeof fields.taskId === 'string' ? { taskId: fields.taskId } : {}),
    ...(typeof fields.field === 'string' ? { field: fields.field } : {}),
    ...(typeof fields.actualBytes === 'number' ? { actualBytes: fields.actualBytes } : {}),
    ...(typeof fields.limitBytes === 'number' ? { limitBytes: fields.limitBytes } : {}),
    ...(fields.code === undefined ? {} : { code: fields.code }),
    ...(fields.errcode === undefined ? {} : { errcode: fields.errcode }),
    ...(fields.errstr === undefined ? {} : { errstr: fields.errstr }),
    ...(error.cause === undefined ? {} : { cause: encodeError(error.cause) }),
  };
}

export function decodeError(wire: WireError): Error {
  let error: Error;
  if (wire.name === 'JournalUnknownTaskError' && wire.taskId !== undefined) {
    error = new JournalUnknownTaskError(wire.taskId, '');
    error.message = wire.message;
  } else if (wire.name === 'JournalIntegrityError' && wire.taskId !== undefined) {
    error = new JournalIntegrityError(wire.taskId, wire.cause === undefined ? undefined : decodeError(wire.cause));
  } else if (wire.name === 'JournalRecordTooLargeError' && wire.field !== undefined && wire.actualBytes !== undefined && wire.limitBytes !== undefined) {
    error = new JournalRecordTooLargeError(wire.field, wire.actualBytes, wire.limitBytes);
  } else {
    error = wire.name === 'TypeError' ? new TypeError(wire.message) : wire.name === 'RangeError' ? new RangeError(wire.message) : new Error(wire.message);
    if (error.name !== wire.name) error.name = wire.name;
    const fields = error as Error & Record<string, unknown>;
    if (wire.code !== undefined) fields.code = wire.code;
    if (wire.errcode !== undefined) fields.errcode = wire.errcode;
    if (wire.errstr !== undefined) fields.errstr = wire.errstr;
    if (wire.cause !== undefined) error.cause = decodeError(wire.cause);
  }
  if (wire.stack !== undefined) error.stack = wire.stack;
  return error;
}
