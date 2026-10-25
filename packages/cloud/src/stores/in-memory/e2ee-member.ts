import type { TenantId } from '@byok-sdk/core';
import type {
  E2eeMemberChainAppendInput,
  E2eeMemberChainAppendResult,
  E2eeMemberChainRow,
  E2eeMemberRegisterResult,
  E2eeMemberRegistrationInput,
  E2eeMemberRegistrationRow,
  E2eeMemberStore,
  E2eeProvenWrite,
  E2eeScopeKeyPackagePutInput,
  E2eeScopeKeyPackagePutResult,
  E2eeScopeKeyPackageRow,
} from '../../e2ee-member';
import { parseRecordedWriteResult } from '../../e2ee-member';
import type { RequestReceiptStore } from '../ports';

interface Expiring {
  readonly body: string;
  readonly expiresAt: string;
}

interface TenantState {
  readonly chain: Map<number, string>;
  /** `[scopeId, epoch]` JSON -> keyId. */
  readonly epochKeyIds: Map<string, string>;
  /** `[scopeId, epoch, recipient]` JSON -> row. */
  readonly packages: Map<string, E2eeScopeKeyPackageRow>;
  /** deviceId -> registration. */
  readonly registrations: Map<string, { readonly memberId: string; readonly bundle: string }>;
  readonly deviceMacs: Map<string, Expiring>;
  readonly clientMacs: Map<string, Expiring>;
  /** scopeId -> seq of its first shred. */
  readonly shredded: Map<string, number>;
  /** memberId -> KEM floor, raised by `rotate` entries. */
  readonly kemFloors: Map<string, number>;
  /** `[deviceId, requestId]` JSON -> the proof binding and the JSON result of the write. */
  readonly requests: Map<string, { readonly binding: string; readonly result: string }>;
}

const requestKey = (proof: E2eeProvenWrite) => JSON.stringify([proof.deviceId, proof.request.requestId]);
const binding = ({ request }: E2eeProvenWrite) => JSON.stringify([request.operation, request.resource, request.bodySha256, request.bodySize]);

/** The recorded result of this device request, `request_conflict` for another binding, or `undefined` for a new request. */
function recorded<T>(state: TenantState, proof: E2eeProvenWrite | undefined, parse: (text: string) => T): T | 'request_conflict' | undefined {
  const stored = proof === undefined ? undefined : state.requests.get(requestKey(proof));
  if (stored === undefined) return undefined;
  return stored.binding === binding(proof!) ? parse(stored.result) : 'request_conflict';
}

function record<T>(state: TenantState, proof: E2eeProvenWrite | undefined, result: T): T {
  if (proof !== undefined) state.requests.set(requestKey(proof), { binding: binding(proof), result: JSON.stringify(result) });
  return result;
}

/**
 * Reference E2EE member store. Each method checks and writes in one
 * synchronous step, so no other call interleaves with it. A shred receipt
 * goes to `receipts`, the composition's request receipt store, after that
 * step. Appends run one at a time through their receipt writes, so a later
 * shred of a scope cannot record its receipt before the first one.
 */
export class InMemoryE2eeMemberStore implements E2eeMemberStore {
  readonly #tenants = new Map<TenantId, TenantState>();
  readonly #receipts: Pick<RequestReceiptStore, 'record'>;
  #appends: Promise<unknown> = Promise.resolve();

  constructor(receipts: Pick<RequestReceiptStore, 'record'>) {
    this.#receipts = receipts;
  }

  #state(tenant: TenantId): TenantState {
    let state = this.#tenants.get(tenant);
    if (state === undefined) {
      state = {
        chain: new Map(),
        epochKeyIds: new Map(),
        packages: new Map(),
        registrations: new Map(),
        deviceMacs: new Map(),
        clientMacs: new Map(),
        shredded: new Map(),
        kemFloors: new Map(),
        requests: new Map(),
      };
      this.#tenants.set(tenant, state);
    }
    return state;
  }

  appendChainEntries(tenant: TenantId, input: E2eeMemberChainAppendInput): Promise<E2eeMemberChainAppendResult> {
    const run = this.#appends.then(() => this.#append(tenant, input));
    this.#appends = run.catch(() => undefined);
    return run;
  }

  async #append(tenant: TenantId, input: E2eeMemberChainAppendInput): Promise<E2eeMemberChainAppendResult> {
    const state = this.#state(tenant);
    const replay = recorded(state, input.proof, text => parseRecordedWriteResult('chainAppend', text));
    if (replay === 'request_conflict') return { outcome: 'request_conflict' };
    if (replay !== undefined) return replay;
    const { chain } = state;
    const { rows } = input;
    const headSeq = chain.size;
    let replayed = 0;
    for (const row of rows) {
      if (row.seq > headSeq) break;
      if (chain.get(row.seq) !== row.entry) return { outcome: 'conflict', seq: row.seq };
      replayed += 1;
    }
    const fresh = rows.slice(replayed);
    if (fresh.length > 0 && fresh[0]!.seq !== headSeq + 1) return { outcome: 'gap', seq: fresh[0]!.seq, headSeq };
    for (const row of fresh) chain.set(row.seq, row.entry);
    const shreds = input.shreds.filter(shred => shred.seq > headSeq);
    for (const { seq, scopeId } of shreds) {
      for (const [key, row] of state.packages) if (row.scopeId === scopeId) state.packages.delete(key);
      for (const key of state.epochKeyIds.keys()) if ((JSON.parse(key) as [string, number])[0] === scopeId) state.epochKeyIds.delete(key);
      if (!state.shredded.has(scopeId)) state.shredded.set(scopeId, seq);
    }
    for (const { seq, memberId, kemEpoch } of input.rotations) {
      if (seq > headSeq && kemEpoch > (state.kemFloors.get(memberId) ?? 0)) state.kemFloors.set(memberId, kemEpoch);
    }
    const result = record<E2eeMemberChainAppendResult>(state, input.proof, { outcome: 'appended', appended: fresh.length, replayed });
    for (const { receipt } of shreds) await this.#receipts.record(tenant, receipt);
    return result;
  }

  async readChainEntries(tenant: TenantId, input: { readonly afterSeq: number; readonly limit: number }): Promise<readonly E2eeMemberChainRow[]> {
    const { chain } = this.#state(tenant);
    const rows: E2eeMemberChainRow[] = [];
    for (let seq = input.afterSeq + 1; seq <= chain.size && rows.length < input.limit; seq += 1) {
      rows.push({ seq, entry: chain.get(seq)! });
    }
    return rows;
  }

  async putScopeKeyPackages(tenant: TenantId, { rows, proof }: E2eeScopeKeyPackagePutInput): Promise<E2eeScopeKeyPackagePutResult> {
    const state = this.#state(tenant);
    const replay = recorded(state, proof, text => parseRecordedWriteResult('keyPackagePut', text));
    if (replay === 'request_conflict') return { outcome: 'request_conflict' };
    if (replay !== undefined) return replay;
    const shredded = rows.find(row => state.shredded.has(row.scopeId));
    if (shredded !== undefined) return { outcome: 'scope_shredded', scopeId: shredded.scopeId };
    for (const { recipient, recipientKemEpoch } of rows) {
      const floor = state.kemFloors.get(recipient);
      if (floor !== undefined && recipientKemEpoch < floor) return { outcome: 'kem_epoch_stale', recipient, kemEpoch: recipientKemEpoch, floor };
    }
    // The first row of a new scope epoch fixes its keyId for the rest of the call.
    const fixed = new Map<string, string>();
    for (const row of rows) {
      const epochKey = JSON.stringify([row.scopeId, row.epoch]);
      const keyId = state.epochKeyIds.get(epochKey) ?? fixed.get(epochKey);
      if (keyId !== undefined && keyId !== row.keyId) {
        return { outcome: 'key_id_conflict', scopeId: row.scopeId, epoch: row.epoch, keyId };
      }
      fixed.set(epochKey, row.keyId);
    }
    for (const { recipientKemEpoch: _, ...row } of rows) {
      state.epochKeyIds.set(JSON.stringify([row.scopeId, row.epoch]), row.keyId);
      state.packages.set(JSON.stringify([row.scopeId, row.epoch, row.recipient]), row);
    }
    return record<E2eeScopeKeyPackagePutResult>(state, proof, { outcome: 'stored', stored: rows.length });
  }

  async readOwnScopeKeyPackages(
    tenant: TenantId,
    input: { readonly scopeId: string; readonly recipient: string; readonly afterEpoch: number; readonly limit: number },
  ): Promise<{ readonly rows: readonly E2eeScopeKeyPackageRow[]; readonly scopeHeadEpoch: number | undefined }> {
    const state = this.#state(tenant);
    const rows = [...state.packages.values()]
      .filter(row => row.scopeId === input.scopeId && row.recipient === input.recipient && row.epoch > input.afterEpoch)
      .sort((a, b) => a.epoch - b.epoch)
      .slice(0, input.limit)
      .map(row => ({ ...row }));
    let scopeHeadEpoch: number | undefined;
    for (const key of state.epochKeyIds.keys()) {
      const [scopeId, epoch] = JSON.parse(key) as [string, number];
      if (scopeId === input.scopeId && epoch > (scopeHeadEpoch ?? 0)) scopeHeadEpoch = epoch;
    }
    return { rows, scopeHeadEpoch };
  }

  async readScopeKeyPackages(
    tenant: TenantId,
    input: { readonly scopeId: string; readonly epoch?: number; readonly recipient?: string },
  ): Promise<readonly E2eeScopeKeyPackageRow[]> {
    return [...this.#state(tenant).packages.values()]
      .filter(row => row.scopeId === input.scopeId
        && (input.epoch === undefined || row.epoch === input.epoch)
        && (input.recipient === undefined || row.recipient === input.recipient))
      .sort((a, b) => a.epoch - b.epoch || (a.recipient < b.recipient ? -1 : a.recipient > b.recipient ? 1 : 0))
      .map(row => ({ ...row }));
  }

  async registerMember(tenant: TenantId, input: E2eeMemberRegistrationInput): Promise<E2eeMemberRegisterResult> {
    const state = this.#state(tenant);
    const proof = { deviceId: input.deviceId, request: input.request };
    const replay = recorded(state, proof, text => parseRecordedWriteResult('memberKeyRegister', text));
    if (replay !== undefined) return replay;
    const existing = state.registrations.get(input.deviceId);
    if (existing !== undefined && existing.bundle !== input.bundle) return 'device_conflict';
    if (existing === undefined
      && [...state.registrations.values()].some(registration => registration.memberId === input.memberId)) {
      return 'member_conflict';
    }
    if (existing === undefined) state.registrations.set(input.deviceId, { memberId: input.memberId, bundle: input.bundle });
    state.deviceMacs.set(input.deviceId, { body: input.deviceMac, expiresAt: input.macExpiresAt });
    return record<E2eeMemberRegisterResult>(state, proof, existing === undefined ? 'registered' : 'replayed');
  }

  async readMemberRegistration(
    tenant: TenantId,
    input: { readonly deviceId: string; readonly now: string },
  ): Promise<E2eeMemberRegistrationRow | undefined> {
    const state = this.#state(tenant);
    const registration = state.registrations.get(input.deviceId);
    if (registration === undefined) return undefined;
    const mac = live(state.deviceMacs.get(input.deviceId), input.now);
    return mac === undefined ? { ...registration } : { ...registration, deviceMac: mac };
  }

  async putClientPairingMac(
    tenant: TenantId,
    input: { readonly deviceId: string; readonly body: string; readonly expiresAt: string },
  ): Promise<'stored' | 'not_registered'> {
    const state = this.#state(tenant);
    if (!state.registrations.has(input.deviceId)) return 'not_registered';
    state.clientMacs.set(input.deviceId, { body: input.body, expiresAt: input.expiresAt });
    return 'stored';
  }

  async readClientPairingMac(tenant: TenantId, input: { readonly deviceId: string; readonly now: string }): Promise<string | undefined> {
    return live(this.#state(tenant).clientMacs.get(input.deviceId), input.now);
  }
}

function live(value: Expiring | undefined, now: string): string | undefined {
  return value !== undefined && Date.parse(now) < Date.parse(value.expiresAt) ? value.body : undefined;
}
