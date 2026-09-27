/**
 * Executed directly by Bun (`bun <this file>`) from `hpke-bun.test.ts`, so the
 * RFC 9180 oracle, the independent-implementation interop, and a full sealed
 * provider-secret round trip run under Bun's WebCrypto as well as Node's.
 * Prints one JSON line; any failure exits non-zero.
 */
import { hpkeSealBase, importP256PublicKey } from '../../hpke';
import {
  deriveSealingKeyId,
  openProviderProvisioningSecret,
  sealProviderProvisioningRequest,
  type SealingPublicJwk,
} from '../../sealed-provider-secret';
import { runIndependentInterop, runRfc9180A31Conformance } from './hpke-conformance';

async function expectCode(label: string, promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if ((error as { code?: string }).code === code) return;
    throw new Error(`${label}: expected ${code}, got ${(error as { code?: string }).code ?? String(error)}`);
  }
  throw new Error(`${label}: expected ${code}, but it resolved`);
}

const bunVersion = (globalThis as { Bun?: { version: string } }).Bun?.version;

async function main(): Promise<void> {
  const encryptions = await runRfc9180A31Conformance();
  await runIndependentInterop();

  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } as SealingPublicJwk;
  const keyId = await deriveSealingKeyId(publicJwk);
  const secret = 'bun-probe-canary-secret';
  const request = await sealProviderProvisioningRequest({
    header: {
      tenantId: 'tenant-1', deviceId: 'device-1', agentId: 'agent-1', requestId: 'request-1',
      operation: 'replace_secret', operationGeneration: 1, expectedProfile: null,
      issuedAt: '2026-09-28T00:00:00.000Z', expiresAt: '2026-09-28T00:10:00.000Z',
    },
    config: { operation: 'replace_secret', agentId: 'agent-1', providerKind: 'zai' },
    recipient: { keyId, publicJwk },
    secret,
  });
  const opened = await openProviderProvisioningSecret({ request, recipient: { keyId, publicJwk, privateKey: pair.privateKey } });
  if (opened !== secret) throw new Error('sealed provider secret round trip failed');

  const offCurve = new Uint8Array(65);
  offCurve[0] = 0x04;
  offCurve.fill(1, 1);
  await expectCode('off-curve import', importP256PublicKey(offCurve), 'sealed_secret_invalid');
  await expectCode('off-curve seal', hpkeSealBase({ recipientPublicKey: offCurve, info: new Uint8Array(1), aad: new Uint8Array(1), plaintext: new Uint8Array(1) }), 'sealed_secret_invalid');
  const tampered = { ...request, header: { ...request.header, operationGeneration: 2 } };
  await expectCode('tampered generation', openProviderProvisioningSecret({ request: tampered, recipient: { keyId, publicJwk, privateKey: pair.privateKey } }), 'sealed_secret_open_failed');

  process.stdout.write(`${JSON.stringify({ ok: true, runtime: bunVersion === undefined ? 'not-bun' : `bun ${bunVersion}`, encryptions })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
