# Notes: S6-a Device Proof Authority

## Status

- Worktree: `/Users/ancienttwo/Projects/byok-sdk-wt-s6-device-proof-memory`
- Branch: `codex/s6-device-proof-memory`
- Base: `origin/main@2a1c4a7`
- Claude review: paused by user; do not invoke.

## Decisions

- Core shipped golden is the sole proof-byte authority.
- Device row stores `proofKeyId=identity`, `proofKeyEpoch=0`; no verifier defaults.
- Record routes will use proof principal with no unsigned/bearer-only fallback.
- S6 is split S6-a/b/c; only all three close S6.

## Evidence

- `0004_device_proof_truth.sql` adds explicit row key id/epoch plus tenant/device/request receipt authority; prior migrations unchanged.
- Cloud proof suite: 125 tests, including Node Ed25519 signature verified through Workers-safe WebCrypto and I3 mutation matrix.
- Conformance: 117 tests on InMemory; Postgres suite 189 tests under required Postgres+MinIO env, including proof receipt parity and tenant isolation.
- Fresh workspace: build passed; typecheck passed; hard-env test passed (core 112, keys 330, protocol 189, cloud 125, server 217, client 935, conformance 117, cloud-postgres 189).
- `repo-harness run check-task-workflow --strict`: pass.
- `packages/protocol/**`: zero diff.
- Closed: full-stack independent Codex security review accepted；PR #34 passed 32/32 CI and merged as `3bc3e744791d7d457acecb2b16b1abeafbb47582`。
