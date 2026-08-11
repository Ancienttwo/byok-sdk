# @byok-sdk/testkit

A headless device simulator for the BYOK device wire (docs/protocol.md §6, §12.3).

If you are integrating the SDK and writing a smoke test, this package is the part
of that test you should not be writing yourself: generating an Ed25519 identity,
exporting it the way `PairRequest.devicePublicKey` expects, knowing that a
challenge nonce is signed under a domain-separation prefix, knowing what that
prefix is, and knowing the exact shapes of `pair` / `challenge` / `token` /
`presence`. All of that is upstream knowledge. Hand-written downstream, it goes
quietly green against nothing the moment upstream changes any of it.

Runtime dependencies are `@byok-sdk/core` and `@byok-sdk/protocol`, and nothing
else — **no test framework**. The negative assertions are async functions
returning structured results, so the same checks run under vitest, under a plain
CI script, and inside a Worker. Requires Node ≥ 22.19 (or any runtime exposing
WebCrypto Ed25519 on `globalThis.crypto.subtle`).

## Install

```sh
npm install --save-dev @byok-sdk/testkit
```

## Usage

```ts
import { createDeviceSimulator, runNegativeAssertions, failedAssertions } from '@byok-sdk/testkit';

const simulator = await createDeviceSimulator({
  baseUrl: 'https://cloud.example.com',
  // Optional. Defaults to globalThis.fetch; pass `cloud.fetch` to drive an
  // in-process composition with no socket.
  // fetch: async (input, init) => cloud.fetch(new Request(input, init)),
  host: {
    listPresence: () => cloud.listPresence(tenant),
    revokeDevice: (deviceId) => cloud.revokeDevice(tenant, deviceId),
  },
});

// 1. pair — redeem a one-time pairing code your control plane minted
const session = await simulator.pair(pairingCode, 'ci-device');

// 2. challenge + 3. token — renew without re-pairing
const nonce = await simulator.challenge(session.deviceId);
await simulator.token({
  deviceId: session.deviceId,
  nonce,
  signature: await simulator.identity.signNonce(nonce),
});
// …or `await simulator.renewAccessToken()` for all three in one call.

// 4. presence — published under the device bearer, read back host-side
await simulator.publishPresence('working', 'running the suite');
const hints = await simulator.readHostPresence();

// 5. revoke — through your host control plane
await simulator.revoke();
```

### The host adapter

`pair`, `challenge`, `token`, and `publishPresence` go over HTTP, because those
are real mounted routes. Minting a pairing code, reading presence back, and
revoking a device are **not**: the SDK mounts no admin route, and those are
in-process calls on `ByokCloud` / `ByokServer`. A deployment that exposes them
over HTTP chooses the paths and the credential itself, so this package will not
guess either — you pass a `SimulatorHost` with two methods. In-process (above)
and HTTP are both a few lines:

```ts
const host = {
  async listPresence() {
    const response = await fetch(`${adminUrl}/presence`, { headers: adminAuth });
    return response.json();
  },
  async revokeDevice(deviceId) {
    await fetch(`${adminUrl}/devices/${deviceId}/revoke`, { method: 'POST', headers: adminAuth });
  },
};
```

### Negative assertions

Four checks, each returning `{ name, ok, expected, actual, response }` rather
than throwing, so your runner decides what a failure means:

```ts
const results = await runNegativeAssertions(simulator, { redeemedPairingCode: pairingCode });
expect(failedAssertions(results)).toEqual([]);
```

`runNegativeAssertions` revokes the device as its last step (post-revocation is
terminal for that identity), so give it a simulator you are done with.

They can also be called individually — `assertUnauthenticatedRejected`,
`assertPairingCodeSingleUse`, `assertUndomainedSignatureRejected`,
`assertRevokedDeviceChallengeRejected`. Each takes an argument that makes it go
red, and the repo's `pairing-simulator` conformance suite exercises exactly that
before trusting the green form: an assertion that cannot fail is decoration.

`assertUnauthenticatedRejected` defaults to `PUT /byok/presence` — the SDK's own
credentialed HTTP surface is device-class. If your deployment publishes admin
routes, pass one as the second argument to assert the same property about it.

## Replacement condition

This table is the contract with a downstream host: when every row is covered,
the hand-written protocol section of your smoke test can be deleted. The
left-hand column is the inventory a real integration (`salesko`,
`scripts/byok-pairing-smoke.ts`, 11 HTTP requests / 15 assertions) was forced to
write by hand before this package existed.

| Hand-written detail | Replaced by | Verified by |
|---|---|---|
| `crypto.subtle.generateKey({name:'Ed25519'})` + JWK `x` export, base64url, 43 chars | `createDeviceIdentity()`, `simulator.identity.publicKeyBase64Url`, `DEVICE_PUBLIC_KEY_LENGTH` | `packages/testkit/src/__tests__/identity.test.ts` |
| `byok-nonce-v1\n` + nonce domain-separated signing bytes | `simulator.identity.signNonce(nonce)` — bytes come from `@byok-sdk/core`'s `nonceSigningBytes`, the single authority; this package defines no domain literal | `packages/core/src/__tests__/pairing.test.ts` |
| `pair(pairingCode, deviceName, devicePublicKey) → {deviceId, accessToken}` | `simulator.pair(pairingCode, deviceName)` | conformance `pairing simulator › five primitives` |
| `challenge → {nonce}` | `simulator.challenge(deviceId?)` | same |
| `token(deviceId, nonce, signature)` | `simulator.token({deviceId, nonce, signature})`, or `renewAccessToken()` | same |
| `PUT /byok/presence {level, detail}` under device bearer | `simulator.publishPresence(level, detail?)` | same |
| Host-side presence read-back | `simulator.readHostPresence()` via `SimulatorHost` | same |
| Revoke | `simulator.revoke()` via `SimulatorHost` | same |
| Negative: unauthenticated request → 401 | `assertUnauthenticatedRejected` | conformance `negative assertions hold` + `can fail` |
| Negative: pairing code single-use, second redemption → 401 | `assertPairingCodeSingleUse` | same |
| Negative: non-domain-separated signature rejected | `assertUndomainedSignatureRejected` | same |
| Negative: post-revocation challenge → 401 | `assertRevokedDeviceChallengeRejected` | same |

Not covered, and still yours to write: anything about your own product surface —
your admin routes' authorization, your pairing-code issuance UI, and any
assertion about what your application does with a paired device.

## License

MIT
