import { generateKeyPairSync } from 'node:crypto';
import { BYOK_CHALLENGE_PATH, BYOK_TOKEN_PATH } from '@byok-sdk/protocol';
import { AuthManager } from '../../daemon/auth-manager';
import { exportPrivateKeyPem } from '../../daemon/device-keys';
import { DeviceStore, type DeviceRecord } from '../../daemon/store';

/**
 * Test-only enrollment setup. It mirrors production authority deliberately:
 * the in-memory credential double receives the complete enrollment record and
 * `device.json` receives only its deterministic metadata projection.
 */
export async function seedDeviceEnrollment(store: DeviceStore, record: DeviceRecord): Promise<void> {
  await store.credentials.replace(record);
  await store.save({
    deviceId: record.deviceId,
    tenantId: record.tenantId,
    devicePublicKey: record.devicePublicKey,
  });
}

export async function clearDeviceEnrollment(store: DeviceStore): Promise<void> {
  await store.credentials.clear();
  await store.remove();
}

/**
 * A loaded `AuthManager` that already holds an hour-long access token. The
 * token lives only in memory (#2045), so it is exchanged here once, against
 * a stand-in for `/byok/challenge` + `/byok/token` that is removed before
 * this returns: the test's own fetch fixture never sees the exchange, and
 * `getValidAccessToken()` answers from memory without touching the network.
 * The enrollment key is real because the exchange signs the challenge.
 */
export async function seedAuthHoldingToken(
  store: DeviceStore,
  serverUrl: string,
  identity: { readonly deviceId: string; readonly tenantId: string },
): Promise<AuthManager> {
  const keys = generateKeyPairSync('ed25519');
  const x = keys.publicKey.export({ format: 'jwk' }).x;
  if (x === undefined) throw new Error('test key has no public x coordinate');
  await seedDeviceEnrollment(store, { ...identity, devicePrivateKeyPem: exportPrivateKeyPem(keys.privateKey), devicePublicKey: x });
  const auth = new AuthManager({ serverUrl, store });
  await auth.loadExisting();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input));
    if (pathname === BYOK_CHALLENGE_PATH) return Response.json({ nonce: 'fixture-nonce' });
    if (pathname === BYOK_TOKEN_PATH) return Response.json({ accessToken: 'fixture-token', expiresIn: 3600 });
    throw new Error(`unexpected request ${pathname} while seeding an access token`);
  }) as typeof fetch;
  try {
    await auth.getValidAccessToken();
  } finally {
    globalThis.fetch = realFetch;
  }
  return auth;
}
