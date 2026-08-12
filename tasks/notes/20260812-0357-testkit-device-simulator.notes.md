# Implementation Notes: testkit-device-simulator

> **Status**: Active
> **Plan**: plans/plan-20260812-0357-testkit-device-simulator.md
> **Contract**: tasks/contracts/20260812-0357-testkit-device-simulator.contract.md
> **Review**: tasks/reviews/20260812-0357-testkit-device-simulator.review.md
> **Last Updated**: 2026-08-12 04:25
> **Lifecycle**: notes

## Falsifier: domain equivalence gate (run BEFORE any edit)

Pre-refactor byte comparison of the three `NONCE_SIGNING_DOMAIN` definitions plus
the candidate core constant, evaluated as string literals and compared as raw
UTF-8:

```
client             NONCE_SIGNING_DOMAIN = 'byok-nonce-v1\n'  hex=62796f6b2d6e6f6e63652d76310a  len=14
cloud              NONCE_SIGNING_DOMAIN = 'byok-nonce-v1\n'  hex=62796f6b2d6e6f6e63652d76310a  len=14
server             NONCE_SIGNING_DOMAIN = 'byok-nonce-v1\n'  hex=62796f6b2d6e6f6e63652d76310a  len=14
core(attestation)  DEVICE_PROOF_DOMAIN_PREFIX = 'byok-device-proof-v1\n'  hex=62796f6b2d6465766963652d70726f6f662d76310a  len=21

[1] three existing constants byte-identical: true
[2] candidate core constant hex=62796f6b2d6e6f6e63652d76310a equals all three: true
[3] nonce-domain is prefix of device-proof-domain: false
[3] device-proof-domain is prefix of nonce-domain: false

FALSIFIER GATE: PASS — premise holds, proceed
```

The three call sites also concatenated identically before the move
(`NONCE_SIGNING_DOMAIN + nonce`, UTF-8), so the moved bytes are the signed bytes.

Landed as a permanent guard in `packages/core/src/__tests__/pairing.test.ts`:
the domain is byte-frozen in hex, `nonceSigningBytes` is asserted against the
concatenation, mutual non-prefix with `DEVICE_PROOF_DOMAIN_PREFIX` is asserted,
and the three former definition sites are scanned to prove none of them
re-declares a local literal while all three still export the name.

## Design Decisions

- **Single authority in core, re-export at each end.** `NONCE_SIGNING_DOMAIN` +
  `nonceSigningBytes` live in `packages/core/src/pairing.ts`. client, cloud, and
  server each `export { NONCE_SIGNING_DOMAIN } from '@byok-sdk/core'`, so every
  package's public surface is unchanged and there is exactly one definition.
  client and server now sign/verify over `nonceSigningBytes(nonce)`; cloud keeps
  string concatenation because `CloudCrypto.verifyEd25519` takes a string and
  encodes UTF-8 itself — same bytes, one encoding step instead of two.
- **`server/src/auth.ts`'s private `verifyEd25519Signature` now takes
  `Uint8Array`** instead of `string`. Private to the module, one caller, no
  public surface change.
- **The simulator owns the device end only.** The SDK mounts no admin route:
  pairing-code mint, presence read-back, and revoke are in-process `ByokCloud`
  calls. So `createDeviceSimulator` takes a `SimulatorHost` adapter (two
  methods) rather than inventing `/byok/admin/...` paths. See Deviations.
- **testkit defines no domain literal.** `identity.signNonce` calls core's
  `nonceSigningBytes`. The only place the package signs anything else is
  `assertUndomainedSignatureRejected`, which signs *less* (the bare nonce) —
  that absence is the assertion.
- **Negative assertions return structured results, never throw on failure.**
  `{ name, ok, expected, actual, response }`. Keeps testkit free of any test
  framework and lets the same four checks run under vitest, a CI script, or a
  Worker.
- **Non-JSON response bodies do not crash the transport.** `SimulatorResponse`
  carries `text` verbatim plus `body` (parsed JSON, or `undefined` when the
  payload is not JSON). Found by the red-form run below: a 404 answered in plain
  text used to surface as an opaque `SyntaxError` instead of `HTTP 404`. Nothing
  is synthesized — every DTO still goes through a `@byok-sdk/protocol` schema,
  which refuses `undefined`.

## Negative assertions: red/green evidence

Each of the four was driven against an input that must NOT trip it, observed
red, then landed green. The red forms are permanent — the
`negative assertions can fail` block asserts `ok === false` and
`actual === 'HTTP 200'` for each, so an assertion that stops being falsifiable
fails the suite.

Additionally, all four red-form expectations were temporarily inverted in
`packages/conformance/src/simulator/harness.ts` to prove the block itself is not
vacuous (inversion reverted; file diffed clean against its backup afterwards):

```
 × negative assertions can fail > unauthenticated: a public route reports failure
   → expected 'HTTP 404' to be 'HTTP 200'          (target swapped to an unmounted GET /byok/presence)
 × negative assertions can fail > pairing single-use: an unused code reports failure
   → expected true to be false                     (fresh code swapped for the already-redeemed one)
 × negative assertions can fail > undomained signature: ...
   → expected true to be false                     (domainSeparated:true dropped)
 × negative assertions can fail > post-revocation challenge: a live device reports failure
   → expected true to be false                     (revoke() inserted before the assertion)
 Tests  4 failed | 9 passed (13)
```

Landed form, all green:

```
 ✓ five primitives > pairs a freshly generated device identity
 ✓ five primitives > renews a token through challenge and a domain-separated signature
 ✓ five primitives > publishes presence under the device bearer and the host reads it back
 ✓ five primitives > revokes the device through the host control plane
 ✓ negative assertions can fail > unauthenticated: a public route reports failure
 ✓ negative assertions can fail > pairing single-use: an unused code reports failure
 ✓ negative assertions can fail > undomained signature: the domain-separated signature reports failure
 ✓ negative assertions can fail > post-revocation challenge: a live device reports failure
 ✓ negative assertions hold > rejects an uncredentialed request to a credentialed route
 ✓ negative assertions hold > rejects a second redemption of the same pairing code
 ✓ negative assertions hold > rejects a signature over the bare nonce
 ✓ negative assertions hold > rejects a challenge from a revoked device
 ✓ negative assertions hold > runs all four in one pass, ending revoked
 Tests  13 passed (13)
```

## Deviations From Plan Or Spec

- **`hostAuth` option replaced by a `SimulatorHost` adapter.** The brief sketched
  `hostAuth?: (headers) => …` for host-side presence read and revoke. The SDK
  publishes no admin wire contract — `createPairingCode` / `listPresence` /
  `revokeDevice` are in-process `ByokCloud` methods, and the only `/byok/admin/*`
  paths in the repo are target designs in `docs/`. A header injector is only
  usable alongside invented paths, and the contract's taste constraint forbids
  the simulator inventing protocol. So the host surface arrives as a two-method
  adapter the caller supplies; an HTTP host writes it in five lines with its own
  paths and credential (documented in the README).
- **The "unauthenticated admin → 401" negative is
  `assertUnauthenticatedRejected`, defaulting to `PUT /byok/presence`.** The
  SDK's own credentialed HTTP surface is device-class. Asserting against a fake
  admin route mounted by the conformance fixture would have been a mock proving
  itself — the plan's explicit stop condition. The assertion takes an optional
  target so a deployment with real admin routes asserts the same property about
  them.
- **Two paths outside the original `allowed_paths`, both added to the contract
  with their reason:**
  - `packages/server/package.json` — `@byok-sdk/server` had no `@byok-sdk/core`
    dependency at all, so the auth.ts refactor the contract mandates is
    unbuildable without declaring the workspace edge.
  - `pnpm-lock.yaml` — a new workspace package plus one new devDependency.
  `packages/protocol`, `packages/cloud-postgres`, `deploy/`, and `scripts/` are
  untouched (verified by `git diff --quiet main -- …`).
- **`packages/core/src/__tests__/constraints.test.ts` updated** (frozen export
  list + allowed index modules). Required by design: that test exists to make
  the export surface a deliberate decision.
- **testkit carries its own `identity.test.ts` and a `test` script.** vitest is
  a root devDependency, not testkit's — the package manifest still declares only
  `@byok-sdk/core` + `@byok-sdk/protocol`, matching every other package here.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Fold the simulator suite into `runCloudConformance` | Rejected | That suite certifies store ports and every composition supplies stores; folding in an HTTP-surface suite would force `@byok-sdk/cloud-postgres` to stand up a `ByokCloud` it has no opinion about — and that package must show zero diff |
| Mount a fake admin route in the conformance fixture for the 401 negative | Rejected | Would assert the fixture, not the SDK — the plan's "negative 断言靠 mock 自证" stop condition |
| Give testkit an HTTP `SimulatorHost` implementation as well | Rejected | Untested surface in a published package, and it would require inventing admin paths |
| Keep three domain literals, add a fourth in testkit | Rejected | The drift this slice removes |

## Open Questions

- **Release train (owner decision, morning).** `scripts/release/*` is untouched
  and `@byok-sdk/testkit` is deliberately NOT in the release package list, per
  the plan. `scripts/release/check-package-graph.mjs` enumerates dispatch
  packages explicitly and does not scan for new ones, so it passes unchanged.
  Adding testkit to the 0.2.x train is the owner's call; the plan's own
  suggestion is to wait for salesko CI to consume a tarball as a devDependency
  once (dogfood) before claiming "publishable".

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
