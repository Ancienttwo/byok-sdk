/**
 * The device side of the Host's E2EE member routes (#654 E2c-2, E2d-1).
 *
 * The registration and the key package put are device-proof writes: the
 * device signs the exact body with its enrollment key, for the route's one
 * operation, and sends no bearer token. The reads use the bearer token. The
 * device puts key packages when it rotates a scope epoch (E2d-4) or re-wraps
 * its own packages, and appends only the `rotate` entry of its own KEM
 * rotation (E2d-5).
 *
 * The Host checks shapes only. Every value read here is untrusted: core
 * verifies the pairing MAC, the chain walk and each key package.
 */
import { randomUUID } from 'node:crypto';
import { DEVICE_PROOF_HEADER } from '@byok-sdk/core';
import type { MemberChainEntryV1, MemberKeyBundleV1, ScopeKeyPackageV1 } from '@byok-sdk/core/sealed-payload';
import {
  BYOK_E2EE_CHAIN_PATH,
  BYOK_E2EE_KEY_PACKAGES_PATH,
  BYOK_E2EE_MEMBER_KEY_PATH,
  BYOK_E2EE_PAIRING_MAC_PATH,
  E2EE_MEMBER_CHAIN_APPEND_OPERATION,
  E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES,
  E2EE_MEMBER_KEY_REGISTER_OPERATION,
  E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION,
} from '@byok-sdk/protocol';
import type { AuthManager } from './auth-manager';
import type { DeviceProofSigner } from './device-proof-signer';
import { authedFetch } from './http-client';
import { toHttpBase } from './url';

export class E2eeMemberClientError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = 'E2eeMemberClientError';
  }
}

export interface E2eeMemberClientOptions {
  readonly serverUrl: string;
  readonly auth: AuthManager;
  readonly signer: DeviceProofSigner;
  readonly signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function errorOf(response: Response, what: string): Promise<E2eeMemberClientError> {
  let code: string | undefined;
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.error === 'string') code = body.error;
  } catch {
    // No JSON error body: the status alone names the failure.
  }
  return new E2eeMemberClientError(`${what} failed with HTTP ${response.status}${code === undefined ? '' : ` (${code})`}`, response.status, code);
}

async function jsonOf(response: Response, what: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!isRecord(body)) throw new E2eeMemberClientError(`${what} returned a body that is not a JSON object`);
  return body;
}

export class E2eeMemberClient {
  readonly #base: string;

  constructor(private readonly options: E2eeMemberClientOptions) {
    this.#base = toHttpBase(options.serverUrl);
  }

  /**
   * Register this device's member bundle and its device pairing MAC (§7.2
   * step 3). The Host keeps the first bundle per device; a retry with the
   * same bundle replaces only the MAC and its expiry.
   */
  async register(member: MemberKeyBundleV1, mac: string): Promise<void> {
    const result = await this.#proofPost(BYOK_E2EE_MEMBER_KEY_PATH, E2EE_MEMBER_KEY_REGISTER_OPERATION, { member, mac }, 'member key registration');
    if (result.memberId !== member.memberId) throw new E2eeMemberClientError('member key registration named another member');
  }

  /**
   * Put the key packages of one new scope epoch (E2d-4). A Host that holds
   * the epoch under another `keyId` answers 409 `e2ee_scope_key_conflict`.
   */
  async putKeyPackages(packages: readonly ScopeKeyPackageV1[]): Promise<void> {
    await this.#proofPost(BYOK_E2EE_KEY_PACKAGES_PATH, E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION, { packages }, 'key package put');
  }

  /**
   * Append signed chain entries (E2d-5). A Host that holds another entry at
   * one of their seqs answers 409 `e2ee_member_chain_conflict`.
   */
  async appendChain(entries: readonly MemberChainEntryV1[]): Promise<void> {
    await this.#proofPost(BYOK_E2EE_CHAIN_PATH, E2EE_MEMBER_CHAIN_APPEND_OPERATION, { entries }, 'member chain append');
  }

  /** One page of the member chain after `afterSeq`. */
  async readChain(afterSeq: number): Promise<readonly unknown[]> {
    const url = new URL(BYOK_E2EE_CHAIN_PATH, this.#base);
    url.searchParams.set('afterSeq', String(afterSeq));
    url.searchParams.set('limit', String(E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES));
    const response = await this.#get(url);
    if (!response.ok) throw await errorOf(response, 'member chain read');
    const { entries } = await jsonOf(response, 'member chain read');
    if (!Array.isArray(entries) || entries.length > E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES) {
      throw new E2eeMemberClientError('member chain read returned no entry list');
    }
    return entries;
  }

  /** Every chain entry after `afterSeq`, in pages of at most 256. */
  async readChainFrom(afterSeq: number): Promise<readonly unknown[]> {
    const all: unknown[] = [];
    for (let after = afterSeq; ;) {
      const page = await this.readChain(after);
      all.push(...page);
      if (page.length < E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES) return all;
      after += page.length;
    }
  }

  /** The client pairing MAC the Host relayed to this device (§7.2 step 4), or `undefined` before the relay. */
  async readPairingMac(): Promise<unknown> {
    const response = await this.#get(new URL(BYOK_E2EE_PAIRING_MAC_PATH, this.#base));
    if (response.status === 404) {
      // Drain the body so the connection is reused; a 404 is "not relayed yet".
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) throw await errorOf(response, 'pairing MAC read');
    return jsonOf(response, 'pairing MAC read');
  }

  /** The key packages of one scope addressed to this device's member: of one epoch, or of every epoch. */
  async readKeyPackages(scopeId: string, epoch?: number): Promise<readonly unknown[]> {
    const url = new URL(BYOK_E2EE_KEY_PACKAGES_PATH, this.#base);
    url.searchParams.set('scopeId', scopeId);
    if (epoch !== undefined) url.searchParams.set('epoch', String(epoch));
    const response = await this.#get(url);
    if (!response.ok) throw await errorOf(response, 'key package read');
    const { packages } = await jsonOf(response, 'key package read');
    if (!Array.isArray(packages)) throw new E2eeMemberClientError('key package read returned no package list');
    return packages;
  }

  async #proofPost(path: string, operation: string, payload: object, what: string): Promise<Record<string, unknown>> {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const proof = await this.options.signer.sign({ method: 'POST', path, operation, resource: path, requestId: randomUUID(), body });
    const response = await fetch(new URL(path, this.#base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [DEVICE_PROOF_HEADER]: Buffer.from(JSON.stringify(proof), 'utf8').toString('base64url') },
      body,
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    });
    if (!response.ok) throw await errorOf(response, what);
    return jsonOf(response, what);
  }

  #get(url: URL): Promise<Response> {
    return authedFetch(url, { method: 'GET', ...(this.options.signal === undefined ? {} : { signal: this.options.signal }) }, this.options.auth);
  }
}
