/**
 * The E2EE member device routes (#654 E2c-2). The three writes are `proof`
 * routes: the device signs the exact body, and the tenant and device come
 * from the proven device row. The three reads are `device` routes, so the
 * bearer check refuses a removed or revoked device before any read.
 *
 * Every handler calls the same functions as the Host control plane, so a
 * device write meets exactly the checks a Host write meets.
 */
import type { DevicePrincipal } from '@byok-sdk/core';
import {
  BYOK_E2EE_CHAIN_PATH,
  BYOK_E2EE_KEY_PACKAGES_PATH,
  BYOK_E2EE_MEMBER_KEY_PATH,
  E2EE_MEMBER_CHAIN_APPEND_MAX_ENTRIES,
  E2EE_MEMBER_CHAIN_APPEND_OPERATION,
  E2EE_MEMBER_CHAIN_ENTRY_MAX_BYTES,
  E2EE_MEMBER_KEY_REGISTER_OPERATION,
  E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION,
} from '@byok-sdk/protocol';
import type { Context } from 'hono';
import type { DeviceProofAuthDeps } from '../auth/device-proof';
import * as e2eeMember from '../e2ee-member';
import { isCloudError, type CloudErrorCode } from '../errors';
import { authenticateProofRequest, readProofRequestBody } from './device-proof-request';
import { authenticateDevice, type DeviceRouteDeps } from './shared';

/** Room for one full chain append, 64 entries of 64 KiB, plus its JSON wrapper. */
export const DEFAULT_MAX_E2EE_REQUEST_BYTES = E2EE_MEMBER_CHAIN_APPEND_MAX_ENTRIES * E2EE_MEMBER_CHAIN_ENTRY_MAX_BYTES + 64 * 1024;

export interface E2eeMemberRouteDeps {
  readonly proof: DeviceProofAuthDeps;
  readonly device: DeviceRouteDeps;
  /** The member context of the authenticated device's tenant. */
  readonly context: (device: DevicePrincipal) => e2eeMember.E2eeMemberContext;
  readonly maxRequestBytes: number;
}

const ERROR_STATUS: Partial<Record<CloudErrorCode, 400 | 409 | 500>> = {
  coordination_input_invalid: 400,
  e2ee_member_chain_conflict: 409,
  e2ee_scope_key_conflict: 409,
  e2ee_member_key_conflict: 409,
  e2ee_member_not_registered: 409,
  e2ee_member_state_unreadable: 500,
};

type ProofWrite = (context: e2eeMember.E2eeMemberContext, deviceId: string, body: unknown) => Promise<object>;

function proofWriteHandler(deps: E2eeMemberRouteDeps, operation: string, resource: string, write: ProofWrite) {
  return async (c: Context): Promise<Response> => {
    const body = await readProofRequestBody(c, deps.maxRequestBytes);
    if (body === 'too_large') return c.json({ error: 'request body too large' }, 413);
    if (body === undefined) return c.json({ error: 'invalid request body' }, 400);
    const proven = await authenticateProofRequest(c, deps.proof, { body, operation, resource });
    if (proven === undefined) return c.json({ error: 'unauthorized' }, 401);
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch {
      return c.json({ error: 'invalid request body' }, 400);
    }
    return respond(c, () => write(deps.context(proven.device), proven.device.deviceId, json));
  };
}

/** `POST /byok/e2ee/member-key`: the device registers its member key bundle and device pairing MAC. */
export function e2eeMemberKeyRegisterHandler(deps: E2eeMemberRouteDeps) {
  return proofWriteHandler(deps, E2EE_MEMBER_KEY_REGISTER_OPERATION, BYOK_E2EE_MEMBER_KEY_PATH, e2eeMember.registerDeviceMemberKey);
}

/** `POST /byok/e2ee/chain`: the device appends member chain entries, `{ entries }`. */
export function e2eeMemberChainAppendHandler(deps: E2eeMemberRouteDeps) {
  return proofWriteHandler(deps, E2EE_MEMBER_CHAIN_APPEND_OPERATION, BYOK_E2EE_CHAIN_PATH, (context, _deviceId, body) =>
    e2eeMember.appendMemberChainEntries(context, body as never));
}

/** `POST /byok/e2ee/key-packages`: the device puts scope key packages, `{ packages }`. */
export function e2eeScopeKeyPackagePutHandler(deps: E2eeMemberRouteDeps) {
  return proofWriteHandler(deps, E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION, BYOK_E2EE_KEY_PACKAGES_PATH, (context, _deviceId, body) =>
    e2eeMember.putScopeKeyPackages(context, body as never));
}

type DeviceRead = (context: e2eeMember.E2eeMemberContext, deviceId: string, query: Readonly<Record<string, number | string>>) => Promise<object | undefined>;

/** Accept only `allowed` query names, each at most once; `numeric` names must be decimal safe integers. */
function readQuery(c: Context, allowed: readonly string[], numeric: readonly string[]): Record<string, number | string> | undefined {
  const params = new URL(c.req.url).searchParams;
  const query: Record<string, number | string> = {};
  // A repeated name fails on its first occurrence, so each name is read once.
  for (const name of params.keys()) {
    const values = params.getAll(name);
    if (!allowed.includes(name) || values.length !== 1) return undefined;
    const value = values[0]!;
    if (!numeric.includes(name)) {
      query[name] = value;
    } else if (/^\d{1,16}$/u.test(value)) {
      query[name] = Number(value);
    } else {
      return undefined;
    }
  }
  return query;
}

function deviceReadHandler(deps: E2eeMemberRouteDeps, allowed: readonly string[], numeric: readonly string[], read: DeviceRead) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps.device);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);
    const query = readQuery(c, allowed, numeric);
    if (query === undefined) return c.json({ error: 'coordination_input_invalid' }, 400);
    const { device } = authenticated;
    return respond(c, () => read(deps.context(device), device.deviceId, query));
  };
}

/** `GET /byok/e2ee/chain?afterSeq=&limit=`: the member chain, for the device's own walk. */
export function e2eeMemberChainReadHandler(deps: E2eeMemberRouteDeps) {
  return deviceReadHandler(deps, ['afterSeq', 'limit'], ['afterSeq', 'limit'], (context, _deviceId, query) =>
    e2eeMember.readMemberChain(context, query));
}

/** `GET /byok/e2ee/key-packages?scopeId=&epoch=`: only packages addressed to this device's member. */
export function e2eeScopeKeyPackageReadHandler(deps: E2eeMemberRouteDeps) {
  return deviceReadHandler(deps, ['scopeId', 'epoch'], ['epoch'], (context, deviceId, query) =>
    e2eeMember.readDeviceScopeKeyPackages(context, deviceId, query as never));
}

/** `GET /byok/e2ee/pairing-mac`: the client pairing MAC relayed to this device, or 404. */
export function e2eePairingMacReadHandler(deps: E2eeMemberRouteDeps) {
  return deviceReadHandler(deps, [], [], (context, deviceId) => e2eeMember.readDeviceClientPairingMac(context, deviceId));
}

/** Only the pairing MAC read can have nothing to return. */
async function respond(c: Context, run: () => Promise<object | undefined>): Promise<Response> {
  try {
    const result = await run();
    return result === undefined ? c.json({ error: 'e2ee_pairing_mac_not_found' }, 404) : c.json(result, 200);
  } catch (error) {
    const status = isCloudError(error) ? ERROR_STATUS[error.code] : undefined;
    if (status === undefined || !isCloudError(error)) throw error;
    return c.json({ error: error.code }, status);
  }
}
