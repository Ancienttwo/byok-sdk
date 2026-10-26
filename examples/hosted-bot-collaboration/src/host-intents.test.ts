import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { RetiredIntentIdentityError, taskId, type FrozenInput, type FrozenSubmitPort, type IntentInput } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { seedCollaboration, SYNC_OPTIONS } from '@byok-sdk/example-bot-collaboration/test-support';
import { DeviceBindingError } from './binding';
import { EntryRefusedError, HostedCommandEntry } from './entry';
import { freezeIntent, HostedSubmitter } from './intents';
import { storedKey } from './layout';
import { TEST_HOST } from './memory-subject.test-support';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { HostedReconciler, IntentOutcomeError, type HostedIntentHandler, type HostedTaskPort } from './reconcile';
import { HostedCollaborationStore, inSchema, lockScope } from './store';

/**
 * #955: the Host's own intents on H, the cases of L's host-intents.test.ts (#882) on Postgres. A fake SDK port: a
 * submitted task completes with the document that the test set for its task id, unless `paused`.
 */
let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const table = (name: string) => `"${opened!.store.schema}".${name}`;
const submitted = new Map<string, FrozenInput>(), documents = new Map<string, unknown>();
let paused = false;
const port = {
  submit: async (input: FrozenInput) => { submitted.set(input.taskId, input); return {}; },
  offer: async (task: string) => {
    const input = submitted.get(task);
    return input && { taskId: task, deviceId: input.deviceId, type: 'task.offer_for_agent_with_egress_fresh', payload: input.payload, delivered: true };
  },
  deviceTerminal: async (task: string) => {
    if (!submitted.has(task) || paused || !documents.has(task)) return undefined;
    return { envelope: { type: 'task.complete', task_id: task, payload: { document: documents.get(task) } } };
  },
  attempt: async (task: string) => {
    const input = submitted.get(task);
    return input && { taskId: task, deviceId: input.deviceId, agentRef: input.payload.agentRef, status: 'completed', claimedRuntime: 'r', ownerDeviceId: input.deviceId };
  },
  cancel: async () => undefined,
} as unknown as HostedTaskPort & FrozenSubmitPort;

const KEY = 'host-research-1', TASK = taskId(KEY, 0), RESULT = { summary: 'host research done' };
const WAIT_UNTIL = Date.now() + 600_000;
const input = (extra: Partial<IntentInput> = {}): IntentInput => ({ key: KEY, source: 'user', execution: template('device', 'research'), waitUntil: WAIT_UNTIL, ...extra });

describe.skipIf(POSTGRES_URL === undefined)('H Host intents on real Postgres (#955)', () => {
  // One schema for each test, because the submit and reconcile scans cover the whole schema.
  beforeEach(async () => { opened = await openStore(); });
  afterEach(async () => {
    await opened?.close();
    submitted.clear(); documents.clear(); paused = false;
  });

  const hostStore = (hostIntents: Record<string, HostedIntentHandler>) =>
    new HostedCollaborationStore(opened!.pool, opened!.store.schema, { host: TEST_HOST, hostIntents });
  const reconciler = (store: HostedCollaborationStore) => new HostedReconciler(opened!.pool, store.schema, store, { port: () => port, pollMs: 0 });
  const submit = () => new HostedSubmitter(opened!.pool, opened!.store.schema, { port: () => port }).run();
  const sync = (store: HostedCollaborationStore, scope: string) => store.sync(scope, { ...SYNC_OPTIONS, history: undefined, now: Date.now() });

  /** A scope with the Main Bot on `device`, an active H binding, and its seeded Turn `t1` concluded and reported. */
  async function scoped(store: HostedCollaborationStore): Promise<string> {
    const scope = `tenant:${randomUUID()}`;
    await store.seed(scope, state => {
      seedCollaboration(state);
      Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true });
    });
    await store.bindDevice(scope, 'device');
    return scope;
  }
  /** A queued user Turn `id` of the Main Bot, frozen by the sync. */
  async function turn(store: HostedCollaborationStore, scope: string, id: string): Promise<void> {
    await store.seed(scope, state => {
      state.turns[id] = { id, root: id, botId: 'main', source: 'user', request: 'Hello', hop: 0, status: 'queued', authority: 'owner' };
    });
    await sync(store, scope);
  }
  /** A row that no Bot Turn and no Host intent owns, as a direct K4 `enqueue` in L. */
  const direct = (scope: string, extra: Partial<IntentInput> = {}) => inSchema(opened!.pool, opened!.store.schema, async client => {
    await lockScope(client, storedKey(scope));
    await freezeIntent(client, scope, input(extra));
  });
  type IntentRow = { key: string; handler: string | null; submission: string; conclusion: string | null; last_error: string | null; terminal: unknown };
  const rows = async (scope: string) => (await opened!.pool.query<IntentRow>(`SELECT key, handler, submission, conclusion, last_error, terminal
    FROM ${table('intent')} WHERE scope = $1 ORDER BY ordinal`, [storedKey(scope)])).rows.map(row => ({ ...row, key: JSON.parse(row.key) as string }));
  const row = async (scope: string, key = KEY) => (await rows(scope)).find(found => found.key === key);
  const audit = async (store: HostedCollaborationStore, scope: string, prefix: string) =>
    (await store.read(scope)).audit.filter(line => line.startsWith(prefix));
  const refusals = (store: HostedCollaborationStore, scope: string) => audit(store, scope, 'Intent outcome refused');
  const ownerFailures = (store: HostedCollaborationStore, scope: string) => audit(store, scope, 'Intent failed by owner');

  it('settles a Host intent through its handler in the terminal transaction, publishes, and keeps the K8 revision', async () => {
    const seen: unknown[] = [];
    const store = hostStore({ research: (document, tx) => { seen.push([document, tx.intent]); tx.publish('research', { done: true }); } });
    const scope = await scoped(store), revision = (await store.read(scope)).revision;
    expect(await store.enqueueHostIntent(scope, input(), 'research', Date.now)).toEqual({ key: KEY, taskId: TASK });
    expect(await submit()).toEqual({ tried: 1, failed: [] });
    documents.set(TASK, RESULT);
    expect(await reconciler(store).run()).toEqual({ concluded: 1, failed: [] });
    expect(await row(scope)).toMatchObject({ handler: 'research', conclusion: 'succeeded', terminal: { envelope: { task_id: TASK } } });
    expect(seen).toEqual([[RESULT, { key: KEY, taskId: TASK }]]);
    expect((await opened!.pool.query(`SELECT body FROM ${table('outbox')} WHERE scope = $1 AND key = $2 AND kind = 'projection'`,
      [storedKey(scope), storedKey('research')])).rows).toEqual([{ body: { done: true } }]);
    expect((await store.read(scope)).revision).toBe(revision);
    // An exact replay returns the settled intent, and the handler does not run again.
    expect(await store.enqueueHostIntent(scope, input(), 'research', Date.now)).toEqual({ key: KEY, taskId: TASK, conclusion: 'succeeded' });
    expect(await reconciler(store).run()).toEqual({ concluded: 0, failed: [] });
    expect(seen).toHaveLength(1);
  });

  it('refuses a handler name, a key or an execution that the Host intent cannot own, with nothing written', async () => {
    const store = hostStore({ research: () => {}, other: () => {} }), scope = await scoped(store);
    await expect(store.enqueueHostIntent(scope, input(), 'missing', Date.now)).rejects.toThrow('Unknown Host intent handler: missing');
    const write = template('device', 'research');
    await expect(store.enqueueHostIntent(scope, input({ execution: { ...write, payload: { ...write.payload, requiredToolsets: ['market.write'] } } }),
      'research', Date.now)).rejects.toThrow('market.write');
    await expect(store.enqueueHostIntent(scope, input({ retry: { maxAttempts: 2 } as never }), 'research', Date.now)).rejects.toThrow('H intents have no retry policy');
    await expect(store.enqueueHostIntent(scope, input({ execution: template('unbound', 'research') }), 'research', Date.now)).rejects.toBeInstanceOf(DeviceBindingError);
    await expect(store.enqueueHostIntent(scope, input({ key: 't1' }), 'research', Date.now)).rejects.toThrow('Host intent identity conflict: the key is a Bot Turn');
    expect(await rows(scope)).toEqual([]);
    await store.enqueueHostIntent(scope, input(), 'research', Date.now);
    await expect(store.enqueueHostIntent(scope, input(), 'other', Date.now)).rejects.toThrow('Host intent identity conflict');
    await expect(store.enqueueHostIntent(scope, input({ waitUntil: WAIT_UNTIL + 1 }), 'research', Date.now)).rejects.toThrow('Intent identity conflict');
    // The handler is part of the identity, so a Turn freeze of the same key and input never takes the row over.
    await expect(direct(scope)).rejects.toThrow('Intent identity conflict');
    await direct(scope, { key: 'direct' });
    await expect(store.enqueueHostIntent(scope, input({ key: 'direct' }), 'research', Date.now)).rejects.toThrow('Host intent identity conflict');
    expect((await rows(scope)).map(found => [found.key, found.handler])).toEqual([[KEY, 'research'], ['direct', null]]);
  });

  it('refuses each reconciliation of a terminal whose key K8 never wrote, and audits it once', async () => {
    const store = hostStore({}), scope = await scoped(store);
    // A row that is not a Host intent: its success must not settle as a Bot outcome or as a silent success.
    await direct(scope);
    await submit();
    documents.set(TASK, RESULT);
    const refused = { name: 'IntentOutcomeError', key: KEY, code: 'unknown_intent', message: 'No Bot Turn or Host intent has this key' };
    for (let pass = 0; pass < 2; pass++) {
      const result = await reconciler(store).run();
      expect(result).toMatchObject({ concluded: 0, failed: [{ scope, turnId: KEY, error: refused }] });
      expect(result.failed[0]!.error).toBeInstanceOf(IntentOutcomeError);
    }
    expect(await row(scope)).toMatchObject({ conclusion: null, terminal: null, last_error: 'unknown_intent: No Bot Turn or Host intent has this key' });
    expect(await refusals(store, scope)).toEqual([`Intent outcome refused unknown_intent: ${KEY} No Bot Turn or Host intent has this key`]);
  });

  it('keeps a failed handler intent open, a store without the handler refuses it, and a fixed handler settles it', async () => {
    const failing = hostStore({ research: () => { throw new Error('research store offline'); } }), scope = await scoped(failing);
    await failing.enqueueHostIntent(scope, input(), 'research', Date.now);
    await submit();
    documents.set(TASK, RESULT);
    expect(await reconciler(failing).run()).toMatchObject({ failed: [{ error: { code: 'handler_failed', message: 'research store offline' } }] });
    expect(await reconciler(failing).run()).toMatchObject({ failed: [{ error: { code: 'handler_failed' } }] });
    // The row stores the handler name, so a process without that handler fails closed.
    expect(await reconciler(hostStore({})).run()).toMatchObject({ failed: [{ error: { code: 'handler_failed', message: 'Unknown Host intent handler: research' } }] });
    expect(await refusals(failing, scope)).toEqual([`Intent outcome refused handler_failed: ${KEY} research store offline`,
      `Intent outcome refused handler_failed: ${KEY} Unknown Host intent handler: research`]);
    const seen: unknown[] = [];
    const fixed = hostStore({ research: document => { seen.push(document); } });
    expect(await reconciler(fixed).run()).toEqual({ concluded: 1, failed: [] });
    expect({ conclusion: (await row(scope))?.conclusion, seen }).toEqual({ conclusion: 'succeeded', seen: [RESULT] });
  });

  it('refuses a published value that conflicts with a stored projection, so the owner can fail the intent', async () => {
    const store = hostStore({ research: (document, tx) => { tx.publish('research', document as never); } }), scope = await scoped(store);
    const second = 'host-research-2', secondTask = taskId(second, 0);
    await store.enqueueHostIntent(scope, input(), 'research', Date.now);
    await store.enqueueHostIntent(scope, input({ key: second }), 'research', Date.now);
    await submit();
    documents.set(TASK, RESULT);
    expect(await reconciler(store).run()).toEqual({ concluded: 1, failed: [] });
    await submit();
    documents.set(secondTask, { summary: 'another result' });
    // The store writes the outbox after the terminal decides, so the terminal checks the stored row itself.
    const refused = { name: 'IntentOutcomeError', key: second, code: 'handler_failed', message: 'Projection identity conflict' };
    expect(await reconciler(store).run()).toMatchObject({ concluded: 0, failed: [{ turnId: second, error: refused }] });
    expect(await refusals(store, scope)).toEqual([`Intent outcome refused handler_failed: ${second} Projection identity conflict`]);
    await reconciler(store).failStuckIntent(scope, second);
    expect((await row(scope, second))?.conclusion).toBe('failed');
    expect((await opened!.pool.query(`SELECT body FROM ${table('outbox')} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey('research')])).rows)
      .toEqual([{ body: RESULT }]);
  });

  it('checks the value as published, not the object that the handler changes afterwards', async () => {
    const store = hostStore({ research: (document, tx) => {
      const value = { ...(document as object) };
      tx.publish('research', value);
      Object.assign(value, RESULT);
    } }), scope = await scoped(store);
    const second = 'host-research-2', secondTask = taskId(second, 0);
    await store.enqueueHostIntent(scope, input(), 'research', Date.now);
    await store.enqueueHostIntent(scope, input({ key: second }), 'research', Date.now);
    await submit();
    documents.set(TASK, RESULT);
    await reconciler(store).run();
    await submit();
    // Published as { summary: 'another result' }, then changed to the stored value: the staged copy still conflicts.
    documents.set(secondTask, { summary: 'another result' });
    expect(await reconciler(store).run()).toMatchObject({ failed: [{ turnId: second, error: { name: 'IntentOutcomeError', code: 'handler_failed',
      message: 'Projection identity conflict' } }] });
  });

  it('refuses an async handler, and consumes its rejection', async () => {
    const unhandled: unknown[] = [], record = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', record);
    onTestFinished(() => { process.off('unhandledRejection', record); });
    const store = hostStore({ research: (async () => { throw new Error('async research failed'); }) as unknown as HostedIntentHandler });
    const scope = await scoped(store);
    await store.enqueueHostIntent(scope, input(), 'research', Date.now);
    await submit();
    documents.set(TASK, RESULT);
    expect(await reconciler(store).run()).toMatchObject({ failed: [{ error: { code: 'handler_failed', message: 'Host intent handler must be synchronous' } }] });
    expect((await row(scope))?.conclusion).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  });

  it('holds the Main Bot FIFO only until its Host intent settles', async () => {
    const store = hostStore({ research: () => {} }), scope = await scoped(store);
    // The Main Bot's agentRef: one FIFO for the Host intent and the Bot's Turns.
    await store.enqueueHostIntent(scope, input({ execution: template('device', 'main') }), 'research', Date.now);
    await turn(store, scope, 'u1');
    expect(await submit()).toEqual({ tried: 1, failed: [] });
    expect((await rows(scope)).map(found => [found.key, found.submission])).toEqual([[KEY, 'delivered'], ['u1', 'reserved']]);
    documents.set(TASK, RESULT);
    await reconciler(store).run();
    expect(await submit()).toEqual({ tried: 1, failed: [] });
    expect((await row(scope, 'u1'))?.submission).toBe('delivered');
  });

  describe('failStuckIntent', () => {
    /** The owner entry of `store`, with the reconciler's settle and the K8 sync composed, as a deployment composes them. */
    const entry = (store: HostedCollaborationStore, settle = true) => new HostedCommandEntry<{ scope: string; id: string }>(store, {
      authenticate: async ({ scope, id }) => ({ scope, principal: { id, kind: 'human' } }),
      owner: async () => 'owner',
      sync: (scope, now) => store.sync(scope, { ...SYNC_OPTIONS, history: undefined, now }),
      ...(settle ? { failStuckIntent: (scope: string, key: string) => reconciler(store).failStuckIntent(scope, key) } : {}),
    });
    const owner = (scope: string) => ({ scope, id: 'owner' });

    it('fails a stuck intent on an owner call, so the next Turn of its FIFO submits', async () => {
      const store = hostStore({}), scope = await scoped(store);
      await direct(scope, { execution: template('device', 'main') });
      await submit();
      documents.set(TASK, RESULT);
      await turn(store, scope, 'u1');
      expect(await reconciler(store).run()).toMatchObject({ failed: [{ error: { code: 'unknown_intent' } }] });
      // Without the owner call, the row stays and the Turn waits behind it.
      expect(await submit()).toEqual({ tried: 0, failed: [] });
      await entry(store).failStuckIntent(owner(scope), KEY);
      expect(await row(scope)).toMatchObject({ conclusion: 'failed', terminal: null, last_error: null });
      expect(await submit()).toEqual({ tried: 1, failed: [] });
      expect(await reconciler(store).run()).toEqual({ concluded: 0, failed: [] });
      expect(await ownerFailures(store, scope)).toEqual([`Intent failed by owner unknown_intent: ${KEY} No Bot Turn or Host intent has this key`]);
    });

    it('fails a failed handler intent, and only the probe of the call runs the handler', async () => {
      let calls = 0;
      const store = hostStore({ research: () => { calls++; throw new Error('research store offline'); } }), scope = await scoped(store);
      await store.enqueueHostIntent(scope, input(), 'research', Date.now);
      await submit();
      documents.set(TASK, RESULT);
      // A process that has seen no refusal yet: the call reconciles the row first to find it.
      await entry(store).failStuckIntent(owner(scope), KEY);
      expect({ conclusion: (await row(scope))?.conclusion, calls }).toEqual({ conclusion: 'failed', calls: 1 });
      expect(await reconciler(store).run()).toEqual({ concluded: 0, failed: [] });
      expect(calls).toBe(1);
      expect(await ownerFailures(store, scope)).toEqual([`Intent failed by owner handler_failed: ${KEY} research store offline`]);
      // The row keeps its handler until compaction removes it, so an exact replay returns the failed intent.
      expect(await store.enqueueHostIntent(scope, input(), 'research', Date.now)).toEqual({ key: KEY, taskId: TASK, conclusion: 'failed' });
    });

    it('fails a Bot Turn whose outcome commit throws, so the Turn ends failed', async () => {
      const store = hostStore({}), scope = await scoped(store);
      await turn(store, scope, 'u1');
      await submit();
      // A document outside the Turn's frozen schema: the K8 outcome commit throws in the terminal transaction.
      documents.set(taskId('u1', 0), { summary: 'not a Bot Turn outcome' });
      expect(await reconciler(store).run()).toMatchObject({ failed: [{ turnId: 'u1', error: { name: 'IntentOutcomeError', code: 'outcome_failed' } }] });
      expect((await row(scope, 'u1'))?.conclusion).toBeNull();
      await entry(store).failStuckIntent(owner(scope), 'u1');
      expect((await row(scope, 'u1'))?.conclusion).toBe('failed');
      expect((await store.read(scope)).turns.u1).toMatchObject({ status: 'failed', conclusion: 'failed', reported: true });
      expect(await ownerFailures(store, scope)).toEqual([expect.stringMatching(/^Intent failed by owner outcome_failed: u1 /)]);
    });

    it('refuses an unknown key, an intent that can still settle, a settled intent and a non-owner', async () => {
      paused = true;
      const store = hostStore({ research: () => {} }), scope = await scoped(store), call = entry(store);
      await expect(call.failStuckIntent(owner(scope), 'missing')).rejects.toThrow('Unknown intent: missing');
      await store.enqueueHostIntent(scope, input(), 'research', Date.now);
      // No submit tried it yet.
      await expect(call.failStuckIntent(owner(scope), KEY)).rejects.toThrow(`Intent is not stuck: ${KEY} has no refused terminal`);
      await submit();
      documents.set(TASK, RESULT);
      // Delivered, with no terminal yet.
      await expect(call.failStuckIntent(owner(scope), KEY)).rejects.toThrow(`Intent is not stuck: ${KEY} has no refused terminal`);
      await expect(call.failStuckIntent({ scope, id: 'guest' }, KEY)).rejects.toBeInstanceOf(EntryRefusedError);
      await expect(entry(store, false).failStuckIntent(owner(scope), KEY)).rejects.toThrow('The command entry has no failStuckIntent');
      paused = false;
      // The probe applies the outcome, so the call refuses.
      await expect(call.failStuckIntent(owner(scope), KEY)).rejects.toThrow(`Intent already settled: ${KEY}`);
      expect((await row(scope))?.conclusion).toBe('succeeded');
      await expect(call.failStuckIntent(owner(scope), KEY)).rejects.toThrow(`Intent already settled: ${KEY}`);
      expect(await ownerFailures(store, scope)).toEqual([]);
      expect(await audit(store, scope, 'Action refused not_owner')).toEqual([`Action refused not_owner: failStuckIntent ${KEY} human:guest`]);
    });

    it('reports the scope of a probe that settles the intent, so the Host syncs it before the refusal', async () => {
      const store = hostStore({}), scope = await scoped(store), changed: string[] = [];
      await turn(store, scope, 'u1');
      await submit();
      // A document that the frozen outcome schema of a Main Bot user Turn accepts.
      documents.set(taskId('u1', 0), { confirmable_action: [{ action: 'send_message', summary: 'Send', draft: { text: 'hello' } }] });
      const probe = new HostedReconciler(opened!.pool, store.schema, store, { port: () => port, pollMs: 0, changed: found => { changed.push(found); } });
      await expect(probe.failStuckIntent(scope, 'u1')).rejects.toThrow('Intent already settled: u1');
      expect({ changed, conclusion: (await row(scope, 'u1'))?.conclusion }).toEqual({ changed: [scope], conclusion: 'succeeded' });
    });

    it('refuses to fail a Bot Turn that is only queued behind another stuck intent', async () => {
      const store = hostStore({}), scope = await scoped(store);
      await direct(scope, { execution: template('device', 'main') });
      await submit();
      documents.set(TASK, RESULT);
      await turn(store, scope, 'u1');
      await reconciler(store).run();
      await expect(entry(store).failStuckIntent(owner(scope), 'u1')).rejects.toThrow('Intent is not stuck: u1 has no refused terminal');
      expect(await ownerFailures(store, scope)).toEqual([]);
    });

    it('throws the error of a reconciliation that did not reach the terminal, and settles nothing', async () => {
      const store = hostStore({}), scope = await scoped(store);
      await direct(scope);
      await submit();
      documents.set(TASK, RESULT);
      const offer = vi.spyOn(port, 'offer').mockRejectedValueOnce(new Error('SDK down'));
      onTestFinished(() => { offer.mockRestore(); });
      await expect(entry(store).failStuckIntent(owner(scope), KEY)).rejects.toThrow('SDK down');
      expect((await row(scope))?.conclusion).toBeNull();
      expect(await ownerFailures(store, scope)).toEqual([]);
    });
  });

  it('compaction removes a settled Host intent with its handler, and its key can never freeze again', async () => {
    const store = hostStore({ research: () => {} }), scope = await scoped(store);
    await store.enqueueHostIntent(scope, input(), 'research', Date.now);
    await submit();
    documents.set(TASK, RESULT);
    await reconciler(store).run();
    expect(await store.compactIntents(scope, { acknowledgedTurnIds: [KEY] })).toEqual({ compactedIntents: 1, alreadyCompactedIntents: 0 });
    expect(await rows(scope)).toEqual([]);
    await expect(store.enqueueHostIntent(scope, input(), 'research', Date.now)).rejects.toBeInstanceOf(RetiredIntentIdentityError);
  });
});
