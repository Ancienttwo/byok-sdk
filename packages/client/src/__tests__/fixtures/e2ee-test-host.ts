/**
 * The Host's E2EE member routes (#654 E2c-2) for `TestServer`: in memory,
 * shape-light, with the device proof checked by its Ed25519 signature. A test
 * plays the web client through the `client*` methods, which stand for the
 * Host control plane (relay the client MAC, append chain entries, put key
 * packages). A device puts key packages and appends chain entries through
 * the proof routes, with the Host's first-writer rules.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { DEVICE_PROOF_HEADER, deviceProofSigningInput, type DeviceProofProtectedClaims } from '@byok-sdk/core';
import type { ScopeKeyPackageV2 } from '@byok-sdk/core/sealed-payload';
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

export interface E2eeTestDevice {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly publicKeyBase64Url: string;
  readonly revoked: boolean;
}

export interface E2eeTestHostDeps {
  readonly bearerDevice: (req: IncomingMessage) => E2eeTestDevice | undefined;
  readonly device: (deviceId: string) => E2eeTestDevice | undefined;
}

export interface E2eeRegistration {
  readonly member: Record<string, unknown> & { readonly memberId: string };
  readonly mac: string;
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function rawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export class E2eeTestHost {
  /** Every registration body, in order, by device. The first bundle per device wins, as on the Host. */
  readonly registrations = new Map<string, E2eeRegistration[]>();
  readonly chain: unknown[] = [];
  readonly #pairingMacs = new Map<string, unknown>();
  /** Answer this many registrations with 503 first. */
  failRegistrations = 0;
  /** When set, every registration answers 400 with this error text. */
  rejectRegistrations: string | undefined;
  /** When set, each registration waits for it before it answers. */
  holdRegistrations: Promise<void> | undefined;
  /** Answer this many chain reads with 503 first. */
  failChainReads = 0;
  /** Chain reads answered, for poll and re-walk assertions. */
  chainReads = 0;
  /** When set, every chain read answers with this page as it is. */
  chainResponse: unknown[] | undefined;
  /** When set, each chain read waits for it before it answers. */
  holdChainReads: Promise<void> | undefined;
  pairingMacReads = 0;
  /** When set, each pairing MAC read waits for it before it answers. */
  holdPairingMacReads: Promise<void> | undefined;
  /** Every key package put, as stored. */
  readonly packages: ScopeKeyPackageV2[] = [];
  /** Answer this many key package reads with 503 first. */
  failPackageReads = 0;
  /** When set, every key package read answers with this status. */
  rejectPackageReads: number | undefined;
  /** When set, a rejected key package read carries this body instead of its error code. */
  rejectPackageBody: unknown;
  packageReads = 0;
  /** When set, every key package read answers with this list as it is. */
  packageResponse: unknown[] | undefined;
  /** When set, each key package read waits for it before it answers. */
  holdPackageReads: Promise<void> | undefined;
  /** Every device key package put body, in order. */
  readonly devicePuts: ScopeKeyPackageV2[][] = [];
  /** When set, each device key package put waits for it before it stores. */
  holdPackagePuts: Promise<void> | undefined;
  /** Answer this many device key package puts with 503 first. */
  failPackagePuts = 0;
  /** Answer device key package puts with 200 and store nothing. */
  dropPackagePuts = false;
  /** Every device chain append body, in order. */
  readonly deviceAppends: unknown[][] = [];
  /** When set, each device chain append waits for it before it stores. */
  holdChainAppends: Promise<void> | undefined;

  constructor(private readonly deps: E2eeTestHostDeps) {}

  /** Host control plane: relay the client pairing MAC to a device (§7.2 step 4). */
  clientRelayPairingMac(deviceId: string, relay: unknown): void {
    this.#pairingMacs.set(deviceId, relay);
  }

  /** Host control plane: append signed entries at the end of the chain. */
  clientAppend(...entries: unknown[]): void {
    this.chain.push(...entries);
  }

  /** Host control plane: store key packages, one per (scope, epoch, recipient). */
  clientPutPackages(...packages: ScopeKeyPackageV2[]): void {
    this.packages.push(...packages);
  }

  /** The registered bundle and the latest device MAC of a device. */
  registration(deviceId: string): E2eeRegistration | undefined {
    const all = this.registrations.get(deviceId);
    return all === undefined ? undefined : { member: all[0]!.member, mac: all.at(-1)!.mac };
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = req.method ?? 'GET';
    if (method === 'POST' && url.pathname === BYOK_E2EE_MEMBER_KEY_PATH) {
      await this.#register(req, res);
      return true;
    }
    if (method === 'GET' && url.pathname === BYOK_E2EE_CHAIN_PATH) {
      if (this.#bearer(req, res) === undefined) return true;
      if (this.failChainReads > 0) {
        this.failChainReads -= 1;
        respond(res, 503, { error: 'unavailable' });
        return true;
      }
      this.chainReads += 1;
      await this.holdChainReads;
      if (this.chainResponse !== undefined) {
        respond(res, 200, { entries: this.chainResponse });
        return true;
      }
      const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0');
      const limit = Math.min(Number(url.searchParams.get('limit') ?? E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES), E2EE_MEMBER_CHAIN_READ_MAX_ENTRIES);
      respond(res, 200, { entries: this.chain.slice(afterSeq, afterSeq + limit) });
      return true;
    }
    if (method === 'GET' && url.pathname === BYOK_E2EE_KEY_PACKAGES_PATH) {
      const device = this.#bearer(req, res);
      if (device === undefined) return true;
      if (this.failPackageReads > 0) {
        this.failPackageReads -= 1;
        respond(res, 503, { error: 'unavailable' });
        return true;
      }
      if (this.rejectPackageReads !== undefined) {
        respond(res, this.rejectPackageReads, this.rejectPackageBody ?? { error: 'forbidden' });
        return true;
      }
      this.packageReads += 1;
      await this.holdPackageReads;
      if (this.packageResponse !== undefined) {
        respond(res, 200, { packages: this.packageResponse });
        return true;
      }
      const recipient = this.registration(device.deviceId)?.member.memberId;
      const scopeId = url.searchParams.get('scopeId');
      const epoch = url.searchParams.get('epoch');
      // The Host reads one epoch per request.
      if (epoch === null) {
        respond(res, 400, { error: 'coordination_input_invalid' });
        return true;
      }
      respond(res, 200, {
        packages: this.packages.filter((pkg) => pkg.recipient === recipient && pkg.scopeId === scopeId && pkg.epoch === Number(epoch)),
      });
      return true;
    }
    if (method === 'POST' && url.pathname === BYOK_E2EE_KEY_PACKAGES_PATH) {
      await this.#put(req, res);
      return true;
    }
    if (method === 'POST' && url.pathname === BYOK_E2EE_CHAIN_PATH) {
      await this.#append(req, res);
      return true;
    }
    if (method === 'GET' && url.pathname === BYOK_E2EE_PAIRING_MAC_PATH) {
      const device = this.#bearer(req, res);
      if (device === undefined) return true;
      this.pairingMacReads += 1;
      await this.holdPairingMacReads;
      const relay = this.#pairingMacs.get(device.deviceId);
      if (relay === undefined) respond(res, 404, { error: 'e2ee_pairing_mac_not_found' });
      else respond(res, 200, relay);
      return true;
    }
    return false;
  }

  #bearer(req: IncomingMessage, res: ServerResponse): E2eeTestDevice | undefined {
    const device = this.deps.bearerDevice(req);
    if (device === undefined || device.revoked) {
      respond(res, 401, { error: 'unauthorized' });
      return undefined;
    }
    return device;
  }

  /** The proven device: the proof's claims bind this route, this body, and verify under the device key. */
  #proven(req: IncomingMessage, body: Buffer, operation: string, path: string): E2eeTestDevice | undefined {
    const header = req.headers[DEVICE_PROOF_HEADER];
    if (typeof header !== 'string' || req.headers.authorization !== undefined) return undefined;
    let proof: { protected: DeviceProofProtectedClaims; signature: string };
    try {
      proof = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    } catch {
      return undefined;
    }
    const claims = proof.protected;
    const device = this.deps.device(claims.deviceId);
    if (
      device === undefined || device.revoked || claims.tenantId !== device.tenantId
      || claims.operation !== operation || claims.resource !== path || claims.path !== path || claims.method !== 'POST'
      || claims.bodySize !== body.byteLength || claims.bodySha256 !== `sha256:${createHash('sha256').update(body).digest('hex')}`
    ) {
      return undefined;
    }
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: device.publicKeyBase64Url }, format: 'jwk' });
    return edVerify(null, deviceProofSigningInput(claims), key, Buffer.from(proof.signature, 'base64url')) ? device : undefined;
  }

  /** The device put: one `keyId` per scope epoch, and a repeat recipient replaces its package. */
  async #put(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await rawBody(req);
    if (this.#proven(req, body, E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION, BYOK_E2EE_KEY_PACKAGES_PATH) === undefined) {
      return respond(res, 401, { error: 'unauthorized' });
    }
    if (this.failPackagePuts > 0) {
      this.failPackagePuts -= 1;
      return respond(res, 503, { error: 'unavailable' });
    }
    const { packages } = JSON.parse(body.toString('utf8')) as { packages: ScopeKeyPackageV2[] };
    this.devicePuts.push(packages);
    await this.holdPackagePuts;
    if (this.dropPackagePuts) return respond(res, 200, { stored: packages.length, skippedDeviceIds: [] });
    const conflict = packages.some((put) => this.packages.some((stored) => stored.scopeId === put.scopeId && stored.epoch === put.epoch && stored.keyId !== put.keyId));
    if (conflict) return respond(res, 409, { error: 'e2ee_scope_key_conflict' });
    for (const put of packages) {
      const at = this.packages.findIndex((stored) => stored.scopeId === put.scopeId && stored.epoch === put.epoch && stored.recipient === put.recipient);
      if (at >= 0) this.packages.splice(at, 1);
      this.packages.push(put);
    }
    respond(res, 200, { stored: packages.length, skippedDeviceIds: [] });
  }

  /** The device append: each entry takes the next seq; the same entry at a stored seq is a replay. */
  async #append(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await rawBody(req);
    if (this.#proven(req, body, E2EE_MEMBER_CHAIN_APPEND_OPERATION, BYOK_E2EE_CHAIN_PATH) === undefined) {
      return respond(res, 401, { error: 'unauthorized' });
    }
    const { entries } = JSON.parse(body.toString('utf8')) as { entries: Array<{ seq: number }> };
    this.deviceAppends.push(entries);
    await this.holdChainAppends;
    let appended = 0;
    let replayed = 0;
    for (const entry of entries) {
      if (entry.seq === this.chain.length + 1) {
        this.chain.push(entry);
        appended += 1;
      } else if (JSON.stringify(this.chain[entry.seq - 1]) === JSON.stringify(entry)) {
        replayed += 1;
      } else {
        return respond(res, 409, { error: 'e2ee_member_chain_conflict' });
      }
    }
    respond(res, 200, { appended, replayed });
  }

  async #register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await rawBody(req);
    const device = this.#proven(req, body, E2EE_MEMBER_KEY_REGISTER_OPERATION, BYOK_E2EE_MEMBER_KEY_PATH);
    if (device === undefined) return respond(res, 401, { error: 'unauthorized' });
    if (this.failRegistrations > 0) {
      this.failRegistrations -= 1;
      return respond(res, 503, { error: 'unavailable' });
    }
    if (this.rejectRegistrations !== undefined) return respond(res, 400, { error: this.rejectRegistrations });
    await this.holdRegistrations;
    const registration = JSON.parse(body.toString('utf8')) as E2eeRegistration;
    if (registration.member.deviceId !== device.deviceId) return respond(res, 400, { error: 'coordination_input_invalid' });
    const all = this.registrations.get(device.deviceId) ?? [];
    if (all.length > 0 && JSON.stringify(all[0]!.member) !== JSON.stringify(registration.member)) {
      return respond(res, 409, { error: 'e2ee_member_key_conflict' });
    }
    all.push(registration);
    this.registrations.set(device.deviceId, all);
    respond(res, 200, { memberId: registration.member.memberId });
  }
}
