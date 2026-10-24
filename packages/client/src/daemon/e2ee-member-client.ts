/**
 * The device side of the Host's E2EE member routes (#654 E2c-2, E2d-1).
 *
 * The registration is a device-proof write: the device signs the exact body
 * with its enrollment key, for the one operation `e2ee-member-key.register`,
 * and sends no bearer token. The reads use the bearer token. The device
 * appends no chain entry and puts no key package in E2d, so it signs no
 * other E2EE operation.
 *
 * The Host checks shapes only. Every value read here is untrusted: core
 * verifies the pairing MAC, the chain walk and each key package.
 */
import { randomUUID } from 'node:crypto';
import { DEVICE_PROOF_HEADER } from '@byok-sdk/core';
import type { MemberKeyBundleV1 } from '@byok-sdk/core/sealed-payload';
import {
  BYOK_E2EE_CHAIN_PATH,
  BYOK_E2EE_KEY_PACKAGES_PATH,
  BYOK_E2EE_MEMBER_KEY_PATH,
  BYOK_E2EE_PAIRING_MAC_PATH,
  E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES,
  E2EE_MEMBER_KEY_REGISTER_OPERATION,
} from '@byok-sdk/protocol';
import type { AuthManager } from './auth-manager';
import type { DeviceProofSigner } from './device-proof-signer';
import { authedFetch } from './http-client';
import { toHttpBase } from './url';

/**
 * The longest member chain this device reads, 64 full pages. A Host that
 * serves more is refused, so an endless chain cannot exhaust the daemon.
 */
export const MEMBER_CHAIN_MAX_ENTRIES = 64 * E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES;

/** A Host error code is kept only in this shape, so Host text never reaches a log line as it is. */
const HOST_ERROR_CODE = /^[a-z0-9_]{1,64}$/u;

export class E2eeMemberClientError extends Error {
  /**
   * `final` is the Host's answer, so a retry would get the same: a 4xx other
   * than 429, or a chain past {@link MEMBER_CHAIN_MAX_ENTRIES}.
   */
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly final = status !== undefined && status >= 400 && status < 500 && status !== 429,
  ) {
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
    if (isRecord(body) && typeof body.error === 'string' && HOST_ERROR_CODE.test(body.error)) code = body.error;
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
  async register(member: MemberKeyBundleV1, mac: string, signal?: AbortSignal): Promise<void> {
    const path = BYOK_E2EE_MEMBER_KEY_PATH;
    const body = new TextEncoder().encode(JSON.stringify({ member, mac }));
    const proof = await this.options.signer.sign({
      method: 'POST', path, operation: E2EE_MEMBER_KEY_REGISTER_OPERATION, resource: path, requestId: randomUUID(), body,
    });
    const response = await fetch(new URL(path, this.#base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [DEVICE_PROOF_HEADER]: Buffer.from(JSON.stringify(proof), 'utf8').toString('base64url') },
      body,
      ...this.#signal(signal),
    });
    if (!response.ok) throw await errorOf(response, 'member key registration');
    const result = await jsonOf(response, 'member key registration');
    if (result.memberId !== member.memberId) throw new E2eeMemberClientError('member key registration named another member');
  }

  /** One page of the member chain after `afterSeq`. */
  async readChain(afterSeq: number, signal?: AbortSignal): Promise<readonly unknown[]> {
    const url = new URL(BYOK_E2EE_CHAIN_PATH, this.#base);
    url.searchParams.set('afterSeq', String(afterSeq));
    url.searchParams.set('limit', String(E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES));
    const response = await this.#get(url, signal);
    if (!response.ok) throw await errorOf(response, 'member chain read');
    const { entries } = await jsonOf(response, 'member chain read');
    if (!Array.isArray(entries) || entries.length > E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES) {
      throw new E2eeMemberClientError('member chain read returned no entry list');
    }
    return entries;
  }

  /** Every chain entry after `afterSeq`, in pages of at most 256, up to {@link MEMBER_CHAIN_MAX_ENTRIES} in all. */
  async readChainFrom(afterSeq: number, signal?: AbortSignal): Promise<readonly unknown[]> {
    const all: unknown[] = [];
    for (let after = afterSeq; ;) {
      const page = await this.readChain(after, signal);
      all.push(...page);
      if (afterSeq + all.length > MEMBER_CHAIN_MAX_ENTRIES) {
        throw new E2eeMemberClientError(`the member chain is longer than ${MEMBER_CHAIN_MAX_ENTRIES} entries`, undefined, undefined, true);
      }
      if (page.length < E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES) return all;
      after += page.length;
    }
  }

  /** The client pairing MAC the Host relayed to this device (§7.2 step 4), or `undefined` before the relay. */
  async readPairingMac(signal?: AbortSignal): Promise<unknown> {
    const response = await this.#get(new URL(BYOK_E2EE_PAIRING_MAC_PATH, this.#base), signal);
    if (response.status === 404) {
      // Drain the body so the connection is reused; a 404 is "not relayed yet".
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) throw await errorOf(response, 'pairing MAC read');
    return jsonOf(response, 'pairing MAC read');
  }

  /** The key packages of one scope epoch addressed to this device's member. */
  async readKeyPackages(scopeId: string, epoch: number): Promise<readonly unknown[]> {
    const url = new URL(BYOK_E2EE_KEY_PACKAGES_PATH, this.#base);
    url.searchParams.set('scopeId', scopeId);
    url.searchParams.set('epoch', String(epoch));
    const response = await this.#get(url);
    if (!response.ok) throw await errorOf(response, 'key package read');
    const { packages } = await jsonOf(response, 'key package read');
    if (!Array.isArray(packages)) throw new E2eeMemberClientError('key package read returned no package list');
    return packages;
  }

  #get(url: URL, signal?: AbortSignal): Promise<Response> {
    return authedFetch(url, { method: 'GET', ...this.#signal(signal) }, this.options.auth);
  }

  /** The client's own signal, with the one of this call. */
  #signal(call?: AbortSignal): { signal?: AbortSignal } {
    const signals = [this.options.signal, call].filter((signal): signal is AbortSignal => signal !== undefined);
    return signals.length === 0 ? {} : { signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals) };
  }
}
