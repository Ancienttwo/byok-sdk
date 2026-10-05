import { CloudDoError, type CloudDoErrorCode } from './errors';
import { INBOX_DAY, type CloudInboxAdmission, type InboxSource } from './inbox-admission';
import type { CloudOperationGuard } from './input-guard';
import type { ExecutionRow, InvocationRow } from './invocation-ledger';
import type { PlatformProfileId } from './platform-credentials';
import { canonicalArgs } from './tools';

export type InboxState = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled' | 'expired';
export interface InboxRow {
  seq: number; dedupKey: string; payloadDigest: string; source: InboxSource; profile: PlatformProfileId;
  payloadJson: string | null; availableAt: number; expiresAt: number; state: InboxState;
  runId: number | null; attempts: number; errorCode: CloudDoErrorCode | null; createdAt: number; settledAt: number | null; inputDurable: number; revision: number | null;
}
export interface RunRow extends ExecutionRow {
  trigger: 'submit' | 'wake'; requestId: string | null; submissionId: number | null;
  state: 'starting' | 'running' | 'completed' | 'failed' | 'interrupted';
  errorCode: CloudDoErrorCode | null; startedAt: number | null; settledAt: number | null;
  reservation: 'none' | 'pending' | 'held' | 'released'; eligibilityJson: string | null;
  admissionDigest: string | null; admittedSeqs: string | null; settlementAck: number | null; revision: number | null; membershipPending: number | null;
}
export interface TranscriptCursor { horizon: number; run: number | null; item: number | null }
export interface TranscriptTurn {
  seq: number; runId: number | null; state: InboxState | null; errorCode: CloudDoErrorCode | null;
  revision: number | null; text: string | null;
}
export interface TranscriptItem {
  seq: number; dedupKey: string; state: InboxState; errorCode: CloudDoErrorCode | null;
  runId: number | null; attempts: number; revision: number | null; text: string | null;
}
export interface TranscriptInvocation {
  invocationId: string; toolName: string; state: InvocationRow['state']; errorCode: CloudDoErrorCode | null; revision: number | null;
}
export interface TranscriptRun {
  nativeRunId: number; revision: number | null; state: RunRow['state']; errorCode: CloudDoErrorCode | null;
  trigger: RunRow['trigger']; settlementAck: boolean; claimedSeqs: number[]; turns: TranscriptTurn[];
  text?: string; truncated?: boolean; invocations: TranscriptInvocation[];
}
export interface TranscriptPlan {
  runs: Array<{ run: RunRow; turns: TranscriptTurn[]; invocations: TranscriptInvocation[] }>;
  items: TranscriptItem[]; next: TranscriptCursor;
}
export interface AdmissionIdentity { digest: string; seqs: number[] }
export interface CloudEventRow {
  seq: number; eventKey: string; type: string; conversationId: number | null; ref: string | null; dataJson: string; createdAt: number;
}
export interface CloudEventInput {
  eventKey: string; type: string; conversationId?: number; ref?: string; data: Record<string, unknown>; createdAt?: number;
}
export interface CloudEventMeta { trimmedThrough: number; highWater: number }
export interface SchedulingState { busy?: boolean; repairRetrying?: boolean }
export interface RunSettlement {
  state: 'completed' | 'failed' | 'interrupted'; errorCode?: CloudDoErrorCode; text?: string; entryId?: number;
  /** The caller derives this only from the durable pre-recovery eligibility snapshot. */
  requeue?: boolean;
}
export interface RunHistory { input: unknown; reply: string }
export interface InboxInput { seq: number; source: InboxSource; text: string }
export type InvocationProjection = (row: InvocationRow) => { key: string; dataJson: string } | undefined;
type SqlRow<T> = T & Record<string, SqlStorageValue>;
const encoder = new TextEncoder();
export const CLOUD_CONTEXT_BYTES = 48_000;
const RETENTION = 7 * INBOX_DAY;
const terminalInbox = "state NOT IN ('queued','running')";
const terminalRun = "state NOT IN ('starting','running')";
const terminalInvocation = "state NOT IN ('accepted','running')";

export function inboxInput(rows: readonly InboxRow[]): InboxInput[] {
  return rows.map(row => ({ seq: row.seq, source: row.source, text: (JSON.parse(row.payloadJson!) as { text: string }).text }));
}
export function admissionIdentity(rows: readonly InboxRow[]): AdmissionIdentity {
  return { digest: sha256(JSON.stringify(rows.map(row => [row.seq, row.dedupKey,
    sha256((JSON.parse(row.payloadJson!) as { text: string }).text), row.profile]))), seqs: rows.map(row => row.seq) };
}
/** Accept only the committed native wake input shape. */
export function runInputSeqs(entries: readonly unknown[]): number[] {
  if (!Array.isArray(entries)) return [];
  const entry = entries.find(value => value !== null && typeof value === 'object' && (value as {kind?:unknown}).kind === 'byok.run-input');
  if (!entry || typeof entry !== 'object') return [];
  const data = (entry as {data?:unknown}).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const items = (data as {items?:unknown}).items;
  if (!Array.isArray(items) || items.length > 16) return [];
  const seqs: number[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const {seq, source, text} = item as {seq?:unknown;source?:unknown;text?:unknown};
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0 || seqs.includes(seq)
      || (typeof source !== 'string' || !['message','schedule','invocation'].includes(source)) || typeof text !== 'string') return [];
    seqs.push(seq);
  }
  return seqs;
}
function payloadText(row: InboxRow | undefined): string | null {
  if (row?.payloadJson === null || row?.payloadJson === undefined) return null;
  const value = JSON.parse(row.payloadJson) as {text?:unknown};
  return typeof value.text === 'string' ? value.text : null;
}
/** Fit inbox first. Add the newest history prefix, then emit it in chronological order. */
export function composeCloudInput(rows: readonly InboxRow[], historyNewestFirst: readonly RunHistory[] = []): string {
  const inbox = inboxInput(rows);
  const history: RunHistory[] = [];
  for (const item of historyNewestFirst.slice(0, 20)) {
    const candidate = [item, ...history];
    if (encoder.encode(canonicalArgs({ history: candidate, inbox })).byteLength > CLOUD_CONTEXT_BYTES) break;
    history.unshift(item);
  }
  return canonicalArgs({ history, inbox });
}
export function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0; let end = 0;
  for (const point of text) {
    const size = encoder.encode(point).length;
    if (bytes + size > maxBytes) break;
    bytes += size; end += point.length;
  }
  return text.slice(0, end);
}

/** Synchronous SHA-256 keeps projection digests inside the existing SQLite transaction. */
function sha256(text: string): string {
  const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const source = encoder.encode(text); const data = new Uint8Array(Math.ceil((source.length + 9) / 64) * 64);
  data.set(source); data[source.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 8, Math.floor(source.length / 0x20000000));
  view.setUint32(data.length - 4, source.length * 8);
  const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotate = (value: number, count: number) => (value >>> count) | (value << (32 - count));
  const words = new Uint32Array(64);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15]!; const b = words[i - 2]!;
      words[i] = words[i - 16]! + (rotate(a,7) ^ rotate(a,18) ^ (a >>> 3)) + words[i - 7]!
        + (rotate(b,17) ^ rotate(b,19) ^ (b >>> 10));
    }
    let [a,b,c,d,e,f,g,h] = hash as [number,number,number,number,number,number,number,number];
    for (let i = 0; i < 64; i++) {
      const first = (h + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + constants[i]! + words[i]!) | 0;
      const second = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h=g; g=f; f=e; e=(d+first)|0; d=c; c=b; b=a; a=(first+second)|0;
    }
    for (const [index,value] of [a,b,c,d,e,f,g,h].entries()) hash[index] = (hash[index]! + value) >>> 0;
  }
  return hash.map(value => value.toString(16).padStart(8,'0')).join('');
}

/** Visible SQL state. Sync helpers can participate in the caller's transaction. */
export class CloudState {
  private scheduling: SchedulingState = {};
  constructor(private readonly storage: DurableObjectStorage) {}
  private rows<T>(query: string, ...values: SqlStorageValue[]): T[] {
    return this.storage.sql.exec<SqlRow<T>>(query, ...values).toArray();
  }
  ensureSchema(): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cloud_inbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, dedupKey TEXT NOT NULL UNIQUE, payloadDigest TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('message','schedule','invocation')), profile TEXT NOT NULL, payloadJson TEXT,
        availableAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','running','done','failed','interrupted','cancelled','expired')),
        runId INTEGER, attempts INTEGER NOT NULL DEFAULT 0, errorCode TEXT, createdAt INTEGER NOT NULL, settledAt INTEGER);
        CREATE INDEX IF NOT EXISTS cloud_inbox_runnable ON cloud_inbox(state,availableAt,seq);
        CREATE TABLE IF NOT EXISTS cloud_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,eventKey TEXT NOT NULL UNIQUE,type TEXT NOT NULL,
        conversationId INTEGER,ref TEXT,dataJson TEXT NOT NULL,createdAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS cloud_event_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),trimmedThrough INTEGER NOT NULL DEFAULT 0,
        highWater INTEGER NOT NULL DEFAULT 0,pendingMaintenanceAt INTEGER);
        INSERT INTO cloud_event_meta(singleton) VALUES(1) ON CONFLICT DO NOTHING;
        CREATE TABLE IF NOT EXISTS cloud_projections (
        key TEXT PRIMARY KEY,invocationId TEXT NOT NULL,state TEXT NOT NULL,payloadDigest TEXT NOT NULL,
        dataJson TEXT NOT NULL,errorCode TEXT,createdAt INTEGER NOT NULL)`);
      const legacyMembership = !this.rows<{name:string}>('PRAGMA table_info(cloud_executions)').some(row => row.name === 'membershipPending');
      this.migrate('cloud_inbox', { inputDurable: 'INTEGER NOT NULL DEFAULT 0', revision: 'INTEGER' });
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cloud_run_turns (
        runId INTEGER NOT NULL, seq INTEGER NOT NULL, claimEvent INTEGER, releaseEvent INTEGER,
        PRIMARY KEY (runId,seq));
        CREATE INDEX IF NOT EXISTS cloud_run_turns_by_seq ON cloud_run_turns(seq,runId)`);
      this.migrate('cloud_executions', {
        trigger: "TEXT NOT NULL DEFAULT 'submit'", requestId: 'TEXT', submissionId: 'INTEGER',
        state: "TEXT NOT NULL DEFAULT 'interrupted'", errorCode: 'TEXT', startedAt: 'INTEGER', settledAt: 'INTEGER',
        reservation: "TEXT NOT NULL DEFAULT 'none'", eligibilityJson: 'TEXT',
        admissionDigest: 'TEXT', admittedSeqs: 'TEXT', settlementAck: 'INTEGER', revision: 'INTEGER', membershipPending: 'INTEGER',
      });
      if (legacyMembership) {
        this.storage.sql.exec('INSERT OR IGNORE INTO cloud_run_turns(runId,seq) SELECT runId,seq FROM cloud_inbox WHERE runId IS NOT NULL');
        this.storage.sql.exec("UPDATE cloud_executions SET membershipPending=1 WHERE trigger='wake'");
      }
      this.migrate('cloud_invocations', { deliveredState: "TEXT NOT NULL DEFAULT 'undelivered'", taskId: 'INTEGER', resultEntryId: 'INTEGER' });
    });
  }
  private migrate(table: string, columns: Record<string, string>): void {
    const existing = new Set(this.rows<{ name: string }>(`PRAGMA table_info(${table})`).map(row => row.name));
    for (const [name, type] of Object.entries(columns)) if (!existing.has(name)) this.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  readInboxItem(seq: number): InboxRow | undefined { return this.rows<InboxRow>('SELECT * FROM cloud_inbox WHERE seq=?', seq)[0]; }
  run(conversationId: number): RunRow | undefined { return this.rows<RunRow>('SELECT * FROM cloud_executions WHERE conversationId=?', conversationId)[0]; }
  unsettledRuns(): RunRow[] { return this.rows<RunRow>(`SELECT * FROM cloud_executions WHERE ${terminalRun.replace('NOT IN', 'IN')} ORDER BY conversationId`); }
  completedRuns(): RunRow[] { return this.rows<RunRow>("SELECT * FROM cloud_executions WHERE state='completed' ORDER BY conversationId DESC LIMIT 20"); }
  invocationRowsForRun(id: number): InvocationRow[] { return this.rows<InvocationRow>('SELECT * FROM cloud_invocations WHERE conversationId=? ORDER BY seq', id); }

  private stamp(table: 'cloud_inbox' | 'cloud_executions', key: number, revision: number): void {
    this.storage.sql.exec(`UPDATE ${table} SET revision=? WHERE ${table === 'cloud_inbox' ? 'seq' : 'conversationId'}=? AND (revision IS NULL OR revision<?)`, revision, key, revision);
  }
  claimedSeqs(id: number): number[] {
    return this.rows<{seq:number}>('SELECT seq FROM cloud_run_turns WHERE runId=? ORDER BY seq',id).map(row => row.seq);
  }
  markInputDurable(id: number, seqs: readonly number[]): void {
    this.storage.transactionSync(() => {
      for (const seq of seqs) this.storage.sql.exec("UPDATE cloud_inbox SET inputDurable=1 WHERE seq=? AND runId=? AND state='running'",seq,id);
    });
  }
  pendingBackfills(before = Number.MAX_SAFE_INTEGER): RunRow[] {
    return this.rows<RunRow>('SELECT * FROM cloud_executions WHERE membershipPending=1 AND conversationId<? ORDER BY conversationId DESC LIMIT 25',before);
  }
  applyBackfill(id: number, seqs: readonly number[]): void {
    this.storage.transactionSync(() => {
      if (this.run(id)?.membershipPending !== 1) return;
      for (const seq of seqs) this.storage.sql.exec(`INSERT INTO cloud_run_turns(runId,seq)
        SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM cloud_run_turns WHERE seq=?)
        AND NOT EXISTS(SELECT 1 FROM cloud_inbox WHERE seq=?)`,id,seq,seq,seq);
      this.storage.sql.exec('UPDATE cloud_executions SET membershipPending=0 WHERE conversationId=?',id);
    });
  }
  unackedRuns(): RunRow[] {
    return this.rows<RunRow>(`SELECT * FROM cloud_executions WHERE ${terminalRun} AND settlementAck=0 ORDER BY conversationId`);
  }
  ackSettlement(id: number, guard: CloudOperationGuard, now=Date.now()): boolean {
    return this.storage.transactionSync(() => {
      if (this.run(id)?.settlementAck !== 0) return false;
      this.storage.sql.exec('UPDATE cloud_executions SET settlementAck=1 WHERE conversationId=?',id);
      const event = this.appendEvent({eventKey:`run:${id}:settlement`,type:'run.settlement',conversationId:id,
        data:{nativeRunId:id,ack:true},createdAt:now},guard);
      this.stamp('cloud_executions',id,event.seq);
      return true;
    });
  }

  /** Read-only preflight also works before this DO has initialized its schema. */
  validateEnqueue(input: CloudInboxAdmission, guard: CloudOperationGuard, now = Date.now()): void {
    guard.guardText(input.text); guard.guardText(input.dedupKey);
    const exists = this.rows<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_inbox'").length > 0;
    const previous = exists ? this.rows<InboxRow>('SELECT * FROM cloud_inbox WHERE dedupKey=?', input.dedupKey)[0] : undefined;
    this.enqueueIdentity(input, previous, now);
  }
  private enqueueIdentity(input: CloudInboxAdmission, previous: InboxRow | undefined, now: number) {
    const retained = previous && (previous.settledAt === null || previous.settledAt + RETENTION > now) ? previous : undefined;
    const availableAt = input.availableAt ?? retained?.availableAt ?? now;
    const expiresAt = input.expiresAt ?? retained?.expiresAt ?? availableAt + INBOX_DAY;
    if (!Number.isSafeInteger(availableAt) || !Number.isSafeInteger(expiresAt)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    const payloadDigest = sha256(canonicalArgs({ source: input.source, text: input.text, profile: input.profile, availableAt, expiresAt }));
    if (retained && retained.payloadDigest !== payloadDigest) throw new CloudDoError('CLOUD_INBOX_CONFLICT');
    if (expiresAt <= availableAt || (!retained && availableAt > now + 30 * INBOX_DAY)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    return { retained, availableAt, expiresAt, payloadDigest };
  }

  async enqueue(input: CloudInboxAdmission, guard: CloudOperationGuard, now = Date.now(), options?: SchedulingState): Promise<{ accepted: boolean; row: InboxRow }> {
    guard.guardText(input.text); guard.guardText(input.dedupKey);
    if (options) this.setSchedulingState(options);
    return this.storage.transaction(async () => {
      const previous = this.rows<InboxRow>('SELECT * FROM cloud_inbox WHERE dedupKey=?', input.dedupKey)[0];
      const {retained,availableAt,expiresAt,payloadDigest} = this.enqueueIdentity(input, previous, now);
      if (retained) return { accepted: false, row: retained };
      if (this.rows<{ count: number }>("SELECT COUNT(*) AS count FROM cloud_inbox WHERE state='queued'")[0]!.count >= 100) throw new CloudDoError('CLOUD_INBOX_FULL');
      if (previous) this.storage.sql.exec('DELETE FROM cloud_inbox WHERE seq=?', previous.seq);
      const row = this.rows<InboxRow>(`INSERT INTO cloud_inbox(dedupKey,payloadDigest,source,profile,payloadJson,availableAt,expiresAt,state,createdAt)
        VALUES(?,?,?,?,?,?,?,'queued',?) RETURNING *`, input.dedupKey,payloadDigest,input.source,input.profile,
      guard.guardPayload(JSON.stringify({ text: input.text })),availableAt,expiresAt,now)[0]!;
      const event = this.appendEvent({ eventKey: `inbox:${row.seq}:accepted`,type:'inbox.accepted',ref:String(row.seq),data:{ seq:row.seq,source:row.source,profile:row.profile,availableAt,expiresAt },createdAt:now },guard);
      this.stamp('cloud_inbox',row.seq,event.seq);
      await this.rearmAlarm(undefined, now);
      return { accepted: true, row: this.readInboxItem(row.seq)! };
    });
  }

  /** Selection never skips another profile or a prefix item that exceeds the budget. */
  selectBatch(now = Date.now(), guard?: CloudOperationGuard): InboxRow[] {
    return this.storage.transactionSync(() => {
      const candidates = this.rows<InboxRow>("SELECT * FROM cloud_inbox WHERE state='queued' AND availableAt<=? AND expiresAt>? ORDER BY availableAt,seq LIMIT 17",now,now);
      const selected: InboxRow[] = [];
      for (const row of candidates) {
        if (selected.length >= 16 || (selected.length && row.profile !== selected[0]!.profile)) break;
        if (encoder.encode(composeCloudInput([...selected,row])).length > CLOUD_CONTEXT_BYTES) {
          if (!selected.length && guard) this.settleItem(row,'failed','CLOUD_INBOX_TOO_LARGE',guard,now);
          break;
        }
        selected.push(row);
      }
      return selected;
    });
  }
  startRun(id: number, trigger: 'submit' | 'wake', deadlineAt: number, guard: CloudOperationGuard, now = Date.now()): RunRow {
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(`INSERT INTO cloud_executions(conversationId,deadlineAt,trigger,requestId,state,startedAt,settlementAck)
        VALUES(?,?,?,?,?,?,0) ON CONFLICT(conversationId) DO UPDATE SET trigger=excluded.trigger,
        requestId=excluded.requestId,state=excluded.state,startedAt=excluded.startedAt,settlementAck=0 WHERE cloud_executions.startedAt IS NULL`,id,deadlineAt,trigger,`${trigger}:${id}`,trigger==='wake'?'starting':'running',now);
      if (trigger==='submit') {
        const event = this.appendEvent({eventKey:`run:${id}:started`,type:'run.started',conversationId:id,data:{trigger},createdAt:now},guard);
        this.stamp('cloud_executions',id,event.seq);
      }
      return this.run(id)!;
    });
  }
  markRunning(id: number, guard: CloudOperationGuard, now = Date.now()): void {
    this.storage.transactionSync(() => {
      const row = this.run(id);
      if (!row || row.state !== 'starting') return;
      this.storage.sql.exec("UPDATE cloud_executions SET state='running' WHERE conversationId=?",id);
      const event = this.appendEvent({eventKey:`run:${id}:started`,type:'run.started',conversationId:id,data:{trigger:row.trigger},createdAt:now},guard);
      this.stamp('cloud_executions',id,event.seq);
    });
  }
  recordSubmission(id: number, submissionId: number): void { this.storage.sql.exec('UPDATE cloud_executions SET submissionId=? WHERE conversationId=?',submissionId,id); }
  markReservation(id: number, reservation: RunRow['reservation'], guard: CloudOperationGuard, now = Date.now(), admission?: AdmissionIdentity): void {
    this.storage.transactionSync(() => {
      const row = this.run(id);
      if (!row || (row.state !== 'starting' && row.state !== 'running')) return;
      if (reservation === 'pending' && admission && row.admissionDigest === null) this.storage.sql.exec(
        'UPDATE cloud_executions SET admissionDigest=?,admittedSeqs=? WHERE conversationId=? AND admissionDigest IS NULL',admission.digest,JSON.stringify(admission.seqs),id);
      if (row.reservation === reservation) return;
      this.storage.sql.exec('UPDATE cloud_executions SET reservation=? WHERE conversationId=?',reservation,id);
      if (reservation !== 'pending') this.appendEvent({eventKey:`run:${id}:reservation:${reservation}`,type:'run.reservation',conversationId:id,
        data:{key:row.requestId,reservation,action:reservation==='released'?'release':'reserve'},createdAt:now},guard);
    });
  }
  captureEligibility(originalStale?: ReadonlySet<number>): RunRow[] {
    return this.storage.transactionSync(() => {
      for (const row of this.unsettledRuns()) if (row.eligibilityJson === null) this.storage.sql.exec(
        'UPDATE cloud_executions SET eligibilityJson=? WHERE conversationId=? AND eligibilityJson IS NULL',
        JSON.stringify({steps:row.steps,aborted:row.aborted,fatalCode:row.fatalCode,wasStale:originalStale?.has(row.conversationId)??false}),row.conversationId);
      return this.unsettledRuns();
    });
  }
  claim(id: number, seqs: readonly number[], profile: PlatformProfileId, guard: CloudOperationGuard, now = Date.now()): InboxRow[] {
    return this.storage.transactionSync(() => {
      const run = this.run(id);
      if (!run || run.state !== 'starting') return [];
      const stopped = run.fatalCode ?? (run.aborted ? 'CLOUD_EXECUTION_ABORTED' : now >= run.deadlineAt ? 'CLOUD_EXECUTION_TIMEOUT' : undefined);
      if (stopped) { this.settleRun(id,{state:'interrupted',errorCode:stopped},guard,now); return []; }
      const allowed = new Set(seqs);
      const selected: InboxRow[] = [];
      for (const row of this.selectBatch(now,guard)) {
        if (!allowed.has(row.seq) || row.profile !== profile) break;
        selected.push(row);
      }
      const claimed: InboxRow[] = [];
      for (const row of selected) {
        if (row.attempts >= 3) { this.storage.sql.exec('UPDATE cloud_inbox SET attempts=attempts+1 WHERE seq=?',row.seq); this.settleItem(row,'failed','CLOUD_WAKE_EXHAUSTED',guard,now); continue; }
        this.storage.sql.exec("UPDATE cloud_inbox SET state='running',runId=?,attempts=attempts+1 WHERE seq=? AND state='queued'",id,row.seq);
        claimed.push(this.readInboxItem(row.seq)!);
      }
      if (!claimed.length) { this.settleRun(id,{state:'interrupted',errorCode:'CLOUD_WAKE_EMPTY'},guard,now); return []; }
      this.storage.sql.exec("UPDATE cloud_executions SET state='running' WHERE conversationId=?",id);
      const event = this.appendEvent({eventKey:`run:${id}:started`,type:'run.started',conversationId:id,data:{trigger:'wake',seqs:claimed.map(row=>row.seq)},createdAt:now},guard);
      for (const item of claimed) {
        this.storage.sql.exec('INSERT INTO cloud_run_turns(runId,seq,claimEvent) VALUES(?,?,?)',id,item.seq,event.seq);
        this.stamp('cloud_inbox',item.seq,event.seq);
      }
      this.stamp('cloud_executions',id,event.seq);
      return claimed.map(item => this.readInboxItem(item.seq)!);
    });
  }
  private settleItem(row: InboxRow, state: Exclude<InboxState,'queued'|'running'>, code: CloudDoErrorCode | undefined, guard: CloudOperationGuard, now: number): void {
    this.storage.sql.exec('UPDATE cloud_inbox SET state=?,errorCode=?,payloadJson=CASE WHEN inputDurable=1 THEN NULL ELSE payloadJson END,settledAt=? WHERE seq=? AND state IN (\'queued\',\'running\')',state,code??null,now,row.seq);
    const event = this.appendEvent({eventKey:`inbox:${row.seq}:settled`,type:'inbox.settled',conversationId:row.runId??undefined,ref:String(row.seq),data:{seq:row.seq,state,errorCode:code??null},createdAt:now},guard);
    this.stamp('cloud_inbox',row.seq,event.seq);
  }
  failQueued(seqs: readonly number[], code: CloudDoErrorCode, guard: CloudOperationGuard, now = Date.now()): void {
    this.storage.transactionSync(() => { for (const seq of seqs) { const row=this.readInboxItem(seq); if(row?.state==='queued') this.settleItem(row,'failed',code,guard,now); } });
  }
  cancelQueued(seq: number, guard: CloudOperationGuard, now = Date.now()): InboxRow | undefined {
    return this.storage.transactionSync(() => { const row=this.readInboxItem(seq); if(row?.state==='queued') this.settleItem(row,'cancelled','CLOUD_EXECUTION_ABORTED',guard,now); return this.readInboxItem(seq); });
  }
  expireQueued(guard: CloudOperationGuard, now = Date.now()): number {
    return this.storage.transactionSync(() => {
      const rows=this.rows<InboxRow>("SELECT * FROM cloud_inbox WHERE state='queued' AND expiresAt<=? ORDER BY expiresAt,seq LIMIT 100",now);
      for(const row of rows) this.settleItem(row,'expired','CLOUD_INBOX_EXPIRED',guard,now);
      return rows.length;
    });
  }
  settleRun(id: number, outcome: RunSettlement, guard: CloudOperationGuard, now = Date.now()): RunRow | undefined {
    return this.storage.transactionSync(() => {
      const row=this.run(id);
      if(!row || (row.state!=='starting' && row.state!=='running')) return row;
      const items=this.rows<InboxRow>("SELECT * FROM cloud_inbox WHERE runId=? AND state='running' ORDER BY seq",id);
      for(const item of items) {
        if(outcome.requeue && item.expiresAt>now) this.storage.sql.exec("UPDATE cloud_inbox SET state='queued',runId=NULL,inputDurable=0 WHERE seq=? AND state='running'",item.seq);
        else {
          const expiredRequeue = outcome.requeue && item.expiresAt <= now;
          this.settleItem(item,expiredRequeue?'expired':outcome.state==='completed'?'done':outcome.state==='failed'?'failed':'interrupted',
            expiredRequeue?'CLOUD_INBOX_EXPIRED':outcome.errorCode,guard,now);
        }
      }
      if(row.reservation==='pending'||row.reservation==='held') {
        this.storage.sql.exec("UPDATE cloud_executions SET reservation='released' WHERE conversationId=?",id);
        this.appendEvent({eventKey:`run:${id}:reservation:released`,type:'run.reservation',conversationId:id,data:{key:row.requestId,reservation:'released',action:'release'},createdAt:now},guard);
      }
      this.storage.sql.exec('UPDATE cloud_executions SET state=?,errorCode=?,settledAt=?,settlementAck=0 WHERE conversationId=?',outcome.state,outcome.errorCode??null,now,id);
      const data:Record<string,unknown>={state:outcome.state,errorCode:outcome.errorCode??null,seqs:items.map(item=>item.seq)};
      if(outcome.requeue) data.requeued=items.filter(item=>item.expiresAt>now).map(item=>item.seq);
      if(outcome.entryId!==undefined) data.entryId=outcome.entryId;
      if(outcome.state==='completed'&&outcome.text!==undefined) {
        try { guard.guardText(outcome.text); data.text=outcome.text; }
        catch { data.errorCode='CLOUD_MODEL_RESPONSE_REJECTED'; }
        if(encoder.encode(JSON.stringify(data)).length>65_536) { data.text=utf8Prefix(outcome.text,1024); data.truncated=true; }
      }
      const event = this.appendEvent({eventKey:`run:${id}:settled`,type:`run.${outcome.state}`,conversationId:id,data,createdAt:now},guard);
      for (const item of items) if (outcome.requeue && item.expiresAt > now) {
        this.storage.sql.exec('UPDATE cloud_run_turns SET releaseEvent=? WHERE runId=? AND seq=? AND releaseEvent IS NULL',event.seq,id,item.seq);
        this.stamp('cloud_inbox',item.seq,event.seq);
      }
      this.stamp('cloud_executions',id,event.seq);
      return this.run(id);
    });
  }

  /** The caller must wrap this and its state write in one transaction. */
  appendEvent(event: CloudEventInput, guard: CloudOperationGuard): CloudEventRow {
    guard.guardText(event.eventKey); guard.guardText(event.type);
    if(event.ref!==undefined) guard.guardText(event.ref);
    const dataJson=guard.guardPayload(JSON.stringify(event.data));
    if(encoder.encode(dataJson).length>65_536) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    const previous=this.rows<CloudEventRow>('SELECT * FROM cloud_events WHERE eventKey=?',event.eventKey)[0];
    if(previous) {
      if(previous.type!==event.type||previous.conversationId!==(event.conversationId??null)||previous.ref!==(event.ref??null)||previous.dataJson!==dataJson) throw new CloudDoError('CLOUD_REQUEST_INVALID');
      return previous;
    }
    const count=this.rows<{count:number}>('SELECT COUNT(*) AS count FROM cloud_events')[0]!.count;
    if(count>=10_000) this.trimPrefix(count-9500);
    const row=this.rows<CloudEventRow>(`INSERT INTO cloud_events(eventKey,type,conversationId,ref,dataJson,createdAt)
      VALUES(?,?,?,?,?,?) RETURNING *`,event.eventKey,event.type,event.conversationId??null,event.ref??null,dataJson,event.createdAt??Date.now())[0]!;
    this.storage.sql.exec('UPDATE cloud_event_meta SET highWater=? WHERE singleton=1',row.seq);
    return row;
  }
  eventMeta(): CloudEventMeta { return this.rows<CloudEventMeta>('SELECT trimmedThrough,highWater FROM cloud_event_meta WHERE singleton=1')[0]!; }
  eventPage(after: number, limit = 100): CloudEventRow[] {
    return this.storage.transactionSync(() => {
      const meta=this.eventMeta();
      if(!Number.isSafeInteger(after)||after<0||(after!==0&&after<meta.trimmedThrough)||after>meta.highWater) throw new CloudDoError('CLOUD_EVENT_CURSOR_EXPIRED');
      return this.rows<CloudEventRow>('SELECT * FROM cloud_events WHERE seq>? ORDER BY seq LIMIT ?',after===0?meta.trimmedThrough:after,this.pageLimit(limit));
    });
  }
  private pageLimit(value=100): number {
    if(!Number.isSafeInteger(value)||value<1||value>100) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    return value;
  }
  /** Capture ownership and payloads before any asynchronous pi context read. */
  planTranscript(after: TranscriptCursor | undefined, limit: number): TranscriptPlan {
    return this.storage.transactionSync(() => {
      const highWater = this.eventMeta().highWater;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new CloudDoError('CLOUD_REQUEST_INVALID');
      if (after !== undefined) {
        if (!after || typeof after !== 'object' || Array.isArray(after)
          || Object.keys(after).length !== 3 || !['horizon','run','item'].every(key => Object.hasOwn(after,key))
          || !Number.isSafeInteger(after.horizon) || after.horizon < 0 || after.horizon > highWater
          || [after.run,after.item].some(value => value !== null && (!Number.isSafeInteger(value) || value <= 0))) {
          throw new CloudDoError('CLOUD_REQUEST_INVALID');
        }
      }
      const horizon = after?.horizon ?? highWater;
      const runRows = after?.run === null ? [] : this.rows<RunRow>(
        'SELECT * FROM cloud_executions WHERE conversationId<? ORDER BY conversationId DESC LIMIT ?',after?.run ?? Number.MAX_SAFE_INTEGER,limit);
      const runs = runRows.map(run => {
        const memberships = this.rows<{seq:number}>(`SELECT seq FROM cloud_run_turns WHERE runId=?
          AND (claimEvent IS NULL OR claimEvent<=?) AND (releaseEvent IS NULL OR releaseEvent>?) ORDER BY seq`,run.conversationId,horizon,horizon);
        const turns = memberships.map(({seq}): TranscriptTurn => {
          const inbox = this.readInboxItem(seq);
          // A NULL legacy clock proves historical input only. Live membership proves the current link.
          const current = inbox ? inbox.runId : this.rows<{runId:number}>(`SELECT runId FROM cloud_run_turns
            WHERE seq=? AND claimEvent IS NOT NULL AND releaseEvent IS NULL ORDER BY runId DESC LIMIT 1`,seq)[0]?.runId ?? null;
          return {seq,runId:current,state:inbox?.state ?? null,errorCode:inbox?.errorCode ?? null,
            revision:inbox?.revision ?? null,text:payloadText(inbox)};
        });
        const invocations = this.invocationRowsForRun(run.conversationId).map(row => ({
          invocationId:row.invocationId,toolName:row.toolName,state:row.state,errorCode:row.errorCode,
          revision:row.state === 'accepted' || row.state === 'running' ? null : row.settledEventSeq,
        }));
        return {run,turns,invocations};
      });
      const itemRows = after?.item === null ? [] : this.rows<InboxRow>(`SELECT i.* FROM cloud_inbox i WHERE i.seq<?
        AND NOT EXISTS(SELECT 1 FROM cloud_run_turns t WHERE t.seq=i.seq
          AND (t.claimEvent IS NULL OR t.claimEvent<=?) AND (t.releaseEvent IS NULL OR t.releaseEvent>?))
        ORDER BY i.seq DESC LIMIT ?`,after?.item ?? Number.MAX_SAFE_INTEGER,horizon,horizon,limit);
      const items = itemRows.map(row => ({seq:row.seq,dedupKey:row.dedupKey,state:row.state,errorCode:row.errorCode,
        runId:row.runId,attempts:row.attempts,revision:row.revision,text:payloadText(row)}));
      return {runs,items,next:{horizon,run:runRows.length < limit ? null : runRows.at(-1)!.conversationId,
        item:itemRows.length < limit ? null : itemRows.at(-1)!.seq}};
    });
  }
  readRun(id: number): RunRow | undefined { return this.run(id); }
  readRuns(options: {after?:number;limit?:number} = {}): RunRow[] {
    return this.rows<RunRow>(`SELECT * FROM cloud_executions WHERE ${terminalRun} AND conversationId<? ORDER BY conversationId DESC LIMIT ?`,this.pageAfter(options.after),this.pageLimit(options.limit));
  }
  readInbox(options: {after?:number;limit?:number} = {}): InboxRow[] {
    return this.rows<InboxRow>(`SELECT * FROM cloud_inbox WHERE ${terminalInbox} AND seq<? ORDER BY seq DESC LIMIT ?`,this.pageAfter(options.after),this.pageLimit(options.limit)).map(row=>({...row,payloadJson:null}));
  }
  readInvocations(options: {after?:number;limit?:number} = {}): Array<Pick<InvocationRow,'seq'|'invocationId'|'toolName'|'state'|'errorCode'>> {
    return this.rows(`SELECT seq,invocationId,toolName,state,errorCode FROM cloud_invocations WHERE ${terminalInvocation} AND seq<? ORDER BY seq DESC LIMIT ?`,this.pageAfter(options.after),this.pageLimit(options.limit));
  }
  private pageAfter(after: number | undefined): number {
    if(after!==undefined&&(!Number.isSafeInteger(after)||after<0)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    return after??Number.MAX_SAFE_INTEGER;
  }
  snapshot(): {highWater:number;trimmedThrough:number;inbox:InboxRow[];runs:RunRow[];invocations:Array<Pick<InvocationRow,'seq'|'invocationId'|'toolName'|'state'|'errorCode'>>} {
    return this.storage.transactionSync(() => {
      const inbox=[...this.rows<InboxRow>("SELECT * FROM cloud_inbox WHERE state IN ('queued','running') ORDER BY seq"),...this.readInbox()].map(row=>({...row,payloadJson:null}));
      const runs=[...this.unsettledRuns(),...this.readRuns()];
      const invocations=[...this.rows<Pick<InvocationRow,'seq'|'invocationId'|'toolName'|'state'|'errorCode'>>("SELECT seq,invocationId,toolName,state,errorCode FROM cloud_invocations WHERE state IN ('accepted','running') ORDER BY seq"),...this.readInvocations()];
      return {...this.eventMeta(),inbox,runs,invocations};
    });
  }
  setDelivery(id: string, state: 'delivered'|'undelivered', taskId: number|null, entryId: number|null, guard: CloudOperationGuard, now=Date.now()): void {
    const row=this.rows<InvocationRow&{deliveredState:string;taskId:number|null;resultEntryId:number|null}>('SELECT * FROM cloud_invocations WHERE invocationId=?',id)[0];
    if(!row||row.deliveredState===state&&row.taskId===taskId&&row.resultEntryId===entryId) return;
    this.storage.sql.exec('UPDATE cloud_invocations SET deliveredState=?,taskId=?,resultEntryId=? WHERE invocationId=?',state,taskId,entryId,id);
    this.appendEvent({eventKey:`tool:${id}:delivered:${state}:${taskId??''}:${entryId??''}`,type:'tool.delivered',conversationId:row.conversationId,ref:id,
      data:{invocationId:id,deliveredState:state,taskId,resultEntryId:entryId},createdAt:now},guard);
  }
  projectInvocation(row: InvocationRow, project: InvocationProjection | undefined, guard: CloudOperationGuard, now=Date.now()): void {
    if(!project) return;
    let admitted:{key:string;dataJson:string;digest:string}|undefined;
    try {
      const value=project(Object.freeze({...row}));
      if(value===undefined) return;
      const key = value.key;
      const rawDataJson = value.dataJson;
      if(typeof key!=='string'||!key.length||key.length>128||/[\u0000-\u001f\u007f-\u009f]/u.test(key)||typeof rawDataJson!=='string') throw new Error();
      // Bound raw hook input before JSON parsing and decoded-value traversal.
      if (rawDataJson.length > 16_384 || encoder.encode(rawDataJson).byteLength > 16_384) throw new Error();
      guard.guardText(key);
      const dataJson=guard.guardPayload(rawDataJson);
      if(encoder.encode(dataJson).length>16_384) throw new Error();
      admitted={key:`projection:${row.invocationId}:${key}`,dataJson,digest:sha256(dataJson)};
    } catch { this.projectionFailed(row,guard,now); return; }
    const previous=this.rows<{invocationId:string;state:string;payloadDigest:string}>('SELECT invocationId,state,payloadDigest FROM cloud_projections WHERE key=?',admitted.key)[0];
    if(previous) {
      if(previous.invocationId!==row.invocationId||previous.state!==row.state||previous.payloadDigest!==admitted.digest) this.projectionFailed(row,guard,now);
      return;
    }
    this.storage.sql.exec('INSERT INTO cloud_projections(key,invocationId,state,payloadDigest,dataJson,createdAt) VALUES(?,?,?,?,?,?)',admitted.key,row.invocationId,row.state,admitted.digest,admitted.dataJson,now);
    this.appendEvent({eventKey:admitted.key,type:'projection',conversationId:row.conversationId,ref:row.invocationId,
      data:{key:admitted.key,invocationId:row.invocationId,data:JSON.parse(admitted.dataJson)},createdAt:now},guard);
  }
  private projectionFailed(row: InvocationRow, guard: CloudOperationGuard, now: number): void {
    const key=`sdk:${row.invocationId}:projection-failed`;
    const existing=this.rows<{key:string}>('SELECT key FROM cloud_projections WHERE key=?',key)[0];
    if(existing) return;
    const dataJson='{"code":"CLOUD_PROJECTION_FAILED"}';
    this.storage.sql.exec('INSERT INTO cloud_projections(key,invocationId,state,payloadDigest,dataJson,errorCode,createdAt) VALUES(?,?,?,?,?,?,?)',key,row.invocationId,row.state,sha256(dataJson),dataJson,'CLOUD_PROJECTION_FAILED',now);
    this.appendEvent({eventKey:key,type:'projection.failed',conversationId:row.conversationId,ref:row.invocationId,data:{invocationId:row.invocationId,code:'CLOUD_PROJECTION_FAILED'},createdAt:now},guard);
  }
  private trimPrefix(count: number): number {
    const rows=this.rows<{seq:number}>('SELECT seq FROM cloud_events ORDER BY seq LIMIT ?',count);
    if(!rows.length) return 0;
    const through=rows.at(-1)!.seq;
    this.storage.sql.exec('DELETE FROM cloud_events WHERE seq<=?',through);
    this.storage.sql.exec('UPDATE cloud_event_meta SET trimmedThrough=MAX(trimmedThrough,?) WHERE singleton=1',through);
    return rows.length;
  }
  retention(now=Date.now()): {events:number;inbox:number} {
    return this.storage.transactionSync(() => {
      // Scan only the retained head. Even backdated rows never remove a middle segment.
      const head=this.rows<{seq:number;createdAt:number}>('SELECT seq,createdAt FROM cloud_events ORDER BY seq LIMIT 500');
      let count=0; for(const row of head) { if(row.createdAt+RETENTION>now) break; count++; }
      const events=this.trimPrefix(count);
      const expired=this.rows<{seq:number}>(`SELECT seq FROM cloud_inbox WHERE ${terminalInbox} AND settledAt<=? ORDER BY seq LIMIT 500`,now-RETENTION);
      for(const row of expired) this.storage.sql.exec('DELETE FROM cloud_inbox WHERE seq=?',row.seq);
      return {events,inbox:expired.length};
    });
  }
  setSchedulingState(options: SchedulingState): void {
    if (options.busy !== undefined) this.scheduling.busy = options.busy;
    if (options.repairRetrying !== undefined) this.scheduling.repairRetrying = options.repairRetrying;
  }
  nextAlarm(now=Date.now(), busy=this.scheduling.busy??false): number|null {
    const targets:number[]=[];
    const queued=this.rows<{availableAt:number;expiresAt:number}>("SELECT availableAt,expiresAt FROM cloud_inbox WHERE state='queued'");
    for(const row of queued) {
      if(!busy||row.availableAt>now) targets.push(Math.max(now,row.availableAt));
      targets.push(Math.max(now,row.expiresAt));
    }
    if(!busy&&(this.unsettledRuns().length||this.unackedRuns().length)) targets.push(now);
    const head=this.rows<{createdAt:number}>('SELECT createdAt FROM cloud_events ORDER BY seq LIMIT 1')[0];
    if(head) targets.push(Math.max(now,head.createdAt+RETENTION));
    const settled=this.rows<{settledAt:number}>(`SELECT settledAt FROM cloud_inbox WHERE ${terminalInbox} AND settledAt IS NOT NULL ORDER BY settledAt LIMIT 1`)[0];
    if(settled) targets.push(Math.max(now,settled.settledAt+RETENTION));
    return targets.length?Math.min(...targets):null;
  }
  /** This is the only alarm mutation path. Async enqueue calls it inside its storage transaction. */
  async rearmAlarm(options?: SchedulingState, now=Date.now()): Promise<void> {
    if(options) this.setSchedulingState(options);
    const target=this.nextAlarm(now);
    if(this.scheduling.repairRetrying) {
      this.storage.sql.exec('UPDATE cloud_event_meta SET pendingMaintenanceAt=? WHERE singleton=1',target);
      return;
    }
    this.storage.sql.exec('UPDATE cloud_event_meta SET pendingMaintenanceAt=NULL WHERE singleton=1');
    if(target===null) await this.storage.deleteAlarm(); else await this.storage.setAlarm(target);
  }
}
