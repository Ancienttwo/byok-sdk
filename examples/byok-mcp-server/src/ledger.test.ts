import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BetaLedger, BetaError, DEFAULT_QUOTA, MAX_INSTRUCTION_BYTES, WINDOW_MS, canonicalJson,
  type Caller, type KeySpec, type TaskArguments, type LedgerOptions } from './index';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const spec: KeySpec = { label: 'local test Bot', scopes: ['tasks.dispatch', 'tasks.read', 'tasks.cancel', 'artifacts.read'], deviceIds: ['dev-a', 'dev-b'], runtimes: ['pi'],
  agentRef: { agentId: 'main', profileRevision: '1' } };
const { agentRef: _agentRef, ...agentless } = spec;
const args: TaskArguments = { runtime: 'pi', instruction: 'test instruction' };
function fixture(options: LedgerOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'b2-')); const path = join(root, 'ledger.sqlite');
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const ledger = new BetaLedger(path, 'tenant-a', options); cleanup.push(() => ledger.close());
  const issued = ledger.issueKey(spec); const caller = ledger.authenticate(`Bearer ${issued.token}`);
  return { root, path, ledger, caller, issued };
}
function code(run: () => unknown, expected: string) { expect(run).toThrowError(expect.objectContaining({ code: expected })); }

describe('key custody, caller authority and durable identity', () => {
  it('stores no raw key, uses private files and survives reopen with the same grants', () => {
    const f = fixture(); const token = f.issued.token; const secret = token.split('.')[1]!;
    expect(f.caller.quota).toEqual(DEFAULT_QUOTA);
    expect(f.ledger.getKey(f.caller.keyId)).toEqual(f.issued.key);
    expect(JSON.stringify(f.issued.key)).not.toContain(secret);
    for (const name of readdirSync(f.root)) {
      const file = join(f.root, name); const bytes = readFileSync(file);
      expect(bytes.includes(Buffer.from(token))).toBe(false);
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
    }
    f.ledger.close();
    const reopened = new BetaLedger(f.path, 'tenant-a'); cleanup.push(() => reopened.close());
    expect(reopened.authenticate(`bearer ${token}`)).toEqual(f.issued.key);
    expect(() => new BetaLedger(f.path, 'tenant-a')).toThrow();
    expect(reopened.quota(reopened.authenticate(`Bearer ${token}`)).runningTasks).toBe(0);
  });

  it('refuses missing, unknown, wrong and revoked credentials and forged caller objects', () => {
    const f = fixture();
    const unknown = `Bearer byok_bot_${'0'.repeat(32)}.${'x'.repeat(43)}`;
    const wrong = `Bearer ${f.issued.token.slice(0, -1)}${f.issued.token.endsWith('x') ? 'y' : 'x'}`;
    for (const value of [null, '', 'Basic secret', unknown, wrong, `Bearer ${f.issued.token} extra`]) code(() => f.ledger.authenticate(value), 'unauthorized');
    code(() => f.ledger.authorize({ ...f.caller } as Caller, 'tasks.dispatch'), 'unauthorized');
    expect(Object.isFrozen(f.caller.scopes)).toBe(true);
    expect(f.ledger.revokeKey(f.caller.keyId)).toBe(true);
    expect(f.ledger.revokeKey(f.caller.keyId)).toBe(false);
    code(() => f.ledger.authenticate(`Bearer ${f.issued.token}`), 'unauthorized');
    code(() => f.ledger.reserveTask(f.caller, args, 'dev-a'), 'unauthorized');
  });

  it('binds the file to its tenant and refuses unknown schema or unsafe storage', () => {
    const f = fixture(); f.ledger.close();
    expect(() => new BetaLedger(f.path, 'tenant-b')).toThrow(/tenant mismatch/);
    const db = new DatabaseSync(f.path); db.exec('UPDATE beta_meta SET version=99'); db.close();
    expect(() => new BetaLedger(f.path, 'tenant-a')).toThrow(/version or tenant/);
    expect(() => new BetaLedger(':memory:', 'tenant-a')).toThrow(/private/);
    const foreign = join(f.root, 'foreign.sqlite');
    const unrelated = new DatabaseSync(foreign); unrelated.exec('CREATE TABLE sqliteXpayload (value TEXT)'); unrelated.close();
    chmodSync(foreign, 0o600);
    expect(() => new BetaLedger(foreign, 'tenant-a')).toThrow(/Not a beta ledger/);
    if (process.platform !== 'win32') {
      chmodSync(f.path, 0o644);
      expect(() => new BetaLedger(f.path, 'tenant-a')).toThrow(/private/);
    }
  });

  it('refuses a persisted binding that no longer matches its immutable identity', () => {
    const f = fixture(); const reservation = f.ledger.reserveTask(f.caller, args, 'dev-a');
    f.ledger.close();
    const db = new DatabaseSync(f.path);
    db.prepare('UPDATE beta_tasks SET binding=? WHERE task_id=?').run(JSON.stringify({ ...reservation.binding,
      arguments: { ...reservation.binding.arguments, instruction: 'changed behind the receipt' } }), reservation.taskId);
    db.close();
    const reopened = new BetaLedger(f.path, 'tenant-a'); cleanup.push(() => reopened.close());
    const caller = reopened.authenticate(`Bearer ${f.issued.token}`);
    expect(() => reopened.requireTask(caller, reservation.taskId)).toThrow(/Corrupt beta task binding/);
  });

  it('rejects unknown grants and requires AgentRef for memory and routine scopes', () => {
    const f = fixture();
    code(() => f.ledger.issueKey({ ...spec, scopes: ['*'] } as unknown as KeySpec), 'invalid_input');
    code(() => f.ledger.issueKey({ ...agentless, scopes: ['routines.write'] }), 'invalid_input');
    code(() => f.ledger.issueKey({ ...spec, quota: { runningTasks: 0 } }), 'invalid_input');
    const reader = f.ledger.issueKey({ ...spec, scopes: ['tasks.read'] });
    const caller = f.ledger.authenticate(`Bearer ${reader.token}`);
    code(() => f.ledger.reserveTask(caller, args, 'dev-a'), 'forbidden');
    code(() => f.ledger.reserveTask(f.caller, { ...args, runtime: 'codex' }, 'dev-a'), 'forbidden');
    code(() => f.ledger.reserveTask(f.caller, args, 'foreign-device'), 'forbidden');
    expect(f.ledger.quota(f.caller).runningTasks).toBe(0);
  });

  it('requires AgentRef for tasks.dispatch at issue time, and not for the task read scopes', () => {
    const f = fixture();
    code(() => f.ledger.issueKey(agentless), 'invalid_input');
    code(() => f.ledger.issueKey({ ...agentless, scopes: ['tasks.dispatch'] }), 'invalid_input');
    const reader = f.ledger.issueKey({ ...agentless, scopes: ['tasks.read', 'tasks.cancel', 'artifacts.read'] });
    expect(reader.key.agentRef).toBeUndefined();
    const reservation = f.ledger.reserveTask(f.caller, args, 'dev-a');
    expect(reservation.binding.agentRef).toEqual(spec.agentRef);
  });

  it('keeps immutable bindings and exact explicit identities across reopen', () => {
    const f = fixture(); const input = { ...args, clientRequestId: 'request-1', toolsets: ['host-tools'], workspace: 'repo-1', resultSchema: { type: 'object' } };
    const first = f.ledger.reserveTask(f.caller, input, 'dev-a');
    expect(first.deduplicated).toBe(false);
    const retry = f.ledger.reserveTask(f.caller, { ...input }, 'offline-device');
    expect(retry).toEqual({ ...first, deduplicated: true });
    code(() => f.ledger.reserveTask(f.caller, { ...input, instruction: 'changed' }, 'dev-b'), 'idempotency_conflict');
    expect(f.ledger.quota(f.caller)).toMatchObject({ runningTasks: 1, remainingSubmits: 59 });
    f.ledger.close(); const reopened = new BetaLedger(f.path, 'tenant-a'); cleanup.push(() => reopened.close());
    const caller = reopened.authenticate(`Bearer ${f.issued.token}`);
    expect(reopened.lookupTask(caller, input)).toEqual({ ...first, deduplicated: true });
    expect(reopened.requireTask(caller, first.taskId).binding.deviceId).toBe('dev-a');
  });

  it('anchors fallback windows at first admission and deduplicates reordered arguments across a UTC boundary', () => {
    let now = 14 * 60_000 + 59_000; const f = fixture({ now: () => now });
    const input = { ...args, resultSchema: { type: 'object', properties: { value: { type: 'string', description: 'text' } } } };
    const first = f.ledger.reserveTask(f.caller, input, 'dev-a');
    now += 3000;
    const reordered = { instruction: args.instruction, runtime: 'pi' as const,
      resultSchema: { properties: { value: { description: 'text', type: 'string' } }, type: 'object' } };
    expect(f.ledger.reserveTask(f.caller, reordered, 'dev-b')).toEqual({ ...first, deduplicated: true });
    now = first.createdAt + WINDOW_MS;
    expect(f.ledger.reserveTask(f.caller, input, 'dev-b').taskId).not.toBe(first.taskId);
    expect(f.ledger.reserveTask(f.caller, { ...input, clientRequestId: 'deliberate-rerun' }, 'dev-a').taskId).not.toBe(first.taskId);
  });

  it('isolates task identity and not_found errors between keys', () => {
    const f = fixture(); const other = f.ledger.issueKey(spec); const b = f.ledger.authenticate(`Bearer ${other.token}`);
    const aTask = f.ledger.reserveTask(f.caller, { ...args, clientRequestId: 'same' }, 'dev-a');
    const bTask = f.ledger.reserveTask(b, { ...args, clientRequestId: 'same' }, 'dev-a');
    expect(aTask.taskId).not.toBe(bTask.taskId);
    for (const id of [aTask.taskId, 'missing']) {
      code(() => f.ledger.requireTask(b, id), 'not_found');
      code(() => f.ledger.consumeStatusRead(b, id), 'not_found');
    }
    expect(f.ledger.quota(b).remainingStatusReads).toBe(120);
  });
});

describe('atomic quota admission and rolling counters', () => {
  it('bounds a burst of reservations and does not charge duplicates at the cap', async () => {
    const f = fixture();
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() =>
      f.ledger.reserveTask(f.caller, { ...args, clientRequestId: `call-${i}` }, 'dev-a'))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(4);
    for (const result of results.filter(result => result.status === 'rejected')) expect(result.reason).toMatchObject({ code: 'quota_exceeded', retryAfterSeconds: 1 });
    const retry = f.ledger.reserveTask(f.caller, { ...args, clientRequestId: 'call-0' }, 'dev-b');
    expect(retry.deduplicated).toBe(true);
    expect(f.ledger.quota(f.caller)).toMatchObject({ runningTasks: 4, remainingSubmits: 56 });
    f.ledger.revokeKey(f.caller.keyId);
    f.ledger.close(); const reopened = new BetaLedger(f.path, 'tenant-a'); cleanup.push(() => reopened.close());
    expect(reopened.getKey(f.caller.keyId)?.revokedAt).toBeTypeOf('number');
  });

  it('enforces an hourly sliding window independently of running slots', () => {
    let now = 1_000_000; const f = fixture({ now: () => now });
    const key = f.ledger.issueKey({ ...spec, quota: { runningTasks: 10, submitsPerHour: 2 } });
    const caller = f.ledger.authenticate(`Bearer ${key.token}`);
    for (const id of ['one', 'two']) f.ledger.reserveTask(caller, { ...args, clientRequestId: id }, 'dev-a');
    code(() => f.ledger.reserveTask(caller, { ...args, clientRequestId: 'three' }, 'dev-a'), 'quota_exceeded');
    expect(f.ledger.reserveTask(caller, { ...args, clientRequestId: 'one' }, 'dev-a').deduplicated).toBe(true);
    now += 3_600_000;
    expect(f.ledger.reserveTask(caller, { ...args, clientRequestId: 'three' }, 'dev-a').deduplicated).toBe(false);
    expect(f.ledger.quota(caller)).toMatchObject({ runningTasks: 3, remainingSubmits: 1 });
  });

  it('persists the status rate limit and recovers at its exact minute boundary', () => {
    let now = 1_000_000; const f = fixture({ now: () => now });
    const key = f.ledger.issueKey({ ...spec, quota: { statusPerMinute: 2 } });
    let caller = f.ledger.authenticate(`Bearer ${key.token}`);
    const task = f.ledger.reserveTask(caller, args, 'dev-a');
    f.ledger.consumeStatusRead(caller, task.taskId); f.ledger.consumeStatusRead(caller, task.taskId);
    code(() => f.ledger.consumeStatusRead(caller, task.taskId), 'rate_limited');
    f.ledger.close(); const next = new BetaLedger(f.path, 'tenant-a', { now: () => now }); cleanup.push(() => next.close());
    caller = next.authenticate(`Bearer ${key.token}`);
    code(() => next.consumeStatusRead(caller, task.taskId), 'rate_limited');
    now += 60_000; next.consumeStatusRead(caller, task.taskId);
    expect(next.quota(caller).remainingStatusReads).toBe(1);
  });

  it('keeps routine ownership and idempotency apart from its eight-slot cap', () => {
    const f = fixture(); const issued = f.ledger.issueKey({ ...spec, scopes: ['routines.read', 'routines.write'], agentRef: { agentId: 'main', profileRevision: '1' } });
    const caller = f.ledger.authenticate(`Bearer ${issued.token}`);
    const definition = { schedule: { cron: '0 * * * *', tz: 'UTC' }, task: args };
    const rows = Array.from({ length: 8 }, (_, i) => f.ledger.reserveRoutine(caller, `r-${i}`, definition));
    code(() => f.ledger.reserveRoutine(caller, 'ninth', definition), 'quota_exceeded');
    expect(f.ledger.reserveRoutine(caller, 'r-0', definition)).toEqual({ ...rows[0], deduplicated: true });
    code(() => f.ledger.reserveRoutine(caller, 'r-0', { different: true }), 'idempotency_conflict');
    code(() => f.ledger.requireRoutine(f.caller, rows[0]!.routineId), 'forbidden');
    const other = f.ledger.issueKey({ ...spec, scopes: ['routines.read'], agentRef: { agentId: 'other', profileRevision: '1' } });
    const otherCaller = f.ledger.authenticate(`Bearer ${other.token}`);
    for (const id of [rows[0]!.routineId, 'missing']) code(() => f.ledger.requireRoutine(otherCaller, id), 'not_found');
    expect(f.ledger.releaseRoutineSlot(rows[0]!.routineId)).toBe(true);
    expect(f.ledger.reserveRoutine(caller, 'ninth', definition).deduplicated).toBe(false);
    expect(f.ledger.quota(caller).routines).toBe(8);
  });

  it('looks up and pages one key\'s routine reservations without admitting new ones', () => {
    let now = 1_000_000; const f = fixture({ now: () => now });
    const issued = f.ledger.issueKey({ ...spec, scopes: ['routines.read', 'routines.write'], agentRef: { agentId: 'main', profileRevision: '1' } });
    const caller = f.ledger.authenticate(`Bearer ${issued.token}`);
    const definition = { schedule: { minute: 0, hour: 9, tz: 'UTC' }, task: args };
    expect(f.ledger.lookupRoutine(caller, 'r-0', definition)).toBeUndefined();
    expect(f.ledger.quota(caller).routines).toBe(0);
    const rows = Array.from({ length: 3 }, (_, i) => { now += 1; return f.ledger.reserveRoutine(caller, `r-${i}`, definition); });
    expect(f.ledger.lookupRoutine(caller, 'r-0', definition)).toEqual({ ...rows[0], deduplicated: true });
    code(() => f.ledger.lookupRoutine(caller, 'r-0', { different: true }), 'idempotency_conflict');
    code(() => f.ledger.lookupRoutine(f.caller, 'r-0', definition), 'forbidden');
    const first = f.ledger.listRoutines(caller, { limit: 2 });
    expect(first.routines.map(row => row.localId)).toEqual(['r-2', 'r-1']);
    const second = f.ledger.listRoutines(caller, { limit: 2, cursor: first.nextCursor! });
    expect(second).toEqual({ routines: [{ ...rows[0], deduplicated: true }] });
    for (const limit of [0, 101]) code(() => f.ledger.listRoutines(caller, { limit }), 'invalid_input');
    code(() => f.ledger.listRoutines(caller, { limit: 1, cursor: 'not-a-cursor' }), 'invalid_input');
    code(() => f.ledger.listRoutines(f.caller, { limit: 1 }), 'forbidden');
  });

  it('rechecks revocation after lookup and does not persist a future clock after repair', () => {
    let now = 1_000_000; const f = fixture({ now: () => now });
    expect(f.ledger.lookupTask(f.caller, args)).toBeUndefined();
    f.ledger.revokeKey(f.caller.keyId);
    code(() => f.ledger.reserveTask(f.caller, args, 'dev-a'), 'unauthorized');
    const key = f.ledger.issueKey({ ...spec, quota: { statusPerMinute: 1 } });
    const caller = f.ledger.authenticate(`Bearer ${key.token}`);
    const task = f.ledger.reserveTask(caller, args, 'dev-a');
    now += 86_400_000; f.ledger.consumeStatusRead(caller, task.taskId);
    code(() => f.ledger.consumeStatusRead(caller, task.taskId), 'rate_limited');
    now -= 86_400_000; f.ledger.consumeStatusRead(caller, task.taskId);
    now += 60_000; f.ledger.consumeStatusRead(caller, task.taskId);
    expect(f.ledger.quota(caller).runningTasks).toBe(1);
  });

  it('validates instructions, registered workspace IDs and JSON before charging slots', () => {
    const f = fixture();
    for (const input of [{ ...args, instruction: 'x'.repeat(MAX_INSTRUCTION_BYTES + 1) }, { ...args, instruction: '界'.repeat(11_000) },
      { ...args, workspace: '/etc' }, { ...args, clientRequestId: 'contains space' }, { ...args, caller: 'forged' }]) {
      code(() => f.ledger.reserveTask(f.caller, input, 'dev-a'), 'invalid_input');
    }
    expect(f.ledger.quota(f.caller).runningTasks).toBe(0);
    expect(f.ledger.reserveTask(f.caller, { ...args, instruction: 'x'.repeat(MAX_INSTRUCTION_BYTES) }, 'dev-a').deduplicated).toBe(false);
  });

  it('rejects lossy, cyclic, accessor and excessively deep canonical identities', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    let deep: unknown = 1; for (let i = 0; i < 40; i++) deep = { value: deep };
    let invoked = false; const getter = { get value() { invoked = true; return 1; } };
    for (const value of [undefined, NaN, Infinity, 1n, new Date(), cyclic, deep, getter, [undefined], Array(2)]) {
      expect(() => canonicalJson(value)).toThrow(BetaError);
    }
    expect(invoked).toBe(false);
    expect(canonicalJson({ b: [2, 1], a: { y: true, x: null } })).toBe('{"a":{"x":null,"y":true},"b":[2,1]}');
  });
});
