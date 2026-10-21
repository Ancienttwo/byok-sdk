# #608 Hermes separate credential-custody slice

Baseline: `f4860c0f80df8a5f28964d7417d1a87d9e01667c`.

The baseline Hermes adapter only accepts static non-secret model settings and
forwards the operation environment to Hermes. There is no keys-owned Hermes
launcher, exact local profile selector or locked credential snapshot path.
The protocol's BYOK dispatch selection is explicitly Pi-only. This is a missing
integration slice of the existing issue, not a newly filed vulnerability.

The additive Host-local `byokLauncher` option selects an exact non-secret
profile binding. Admission runs in the Host's dedicated keys process and returns
only custom-provider model metadata. Each gateway/viewer start revalidates the
profile under the existing custody lock, refuses pending changes and reads the
profile-specific key inside that process. `process.execve` retains the spawned
PID required by Hermes gateway ownership checks. A child-proxy launcher would
break that check. The client package has no runtime keys dependency; adapters
entry closure remains free of Zod. Strict request validation belongs to keys.

Mapping is deliberately restricted to enabled OpenAI-compatible bearer profiles
without Pi model overrides. No new wire dispatch authority, Windows support,
secret-store scope or permission is granted. The Host supplies a trusted launcher
and account-scoped store. SDK-copied assets, a full CLI distribution, live model
calls and Windows gateway interoperability are outside this evidence.

## Verification

- Root build, typecheck, API surface/entry closure and version-authority checks.
- Existing Hermes adapter plus new custody integration: 27 tests passed before
  the final constructor regression was added. Final custody file: 4 passed.
- Existing Pi launcher core/entry plus new keys tests: 81 passed. Final keys
  custody file: 3 passed after correcting the Pi-model fixture's required fields.
- Fake credentials only. Real Node subprocesses and Unix sockets prove gateway
  and viewer preserve their launcher PID, filter unrelated provider keys, retain
  no key in generated config, reject stale exact bindings and profile changes
  after admission, and remove the failed profile. Admission does not read keys;
  a pending custody marker refuses admission.
- First sandbox run failed with Unix-socket EPERM before gateway startup; the
  authorized socket-enabled run passed. This is not presented as a baseline bug.
- Fixture iteration exposed readonly binding type interop and incomplete test
  Pi metadata; both were repaired without weakening production assertions.
- API closure initially rejected a runtime protocol-schema import (Zod in the
  adapters entry). It was removed, not allowed through a budget/policy change.
- No duplicate full workspace suite locally; CI remains the full-suite gate.

Independent review by the parallel reviewer and root found no actionable
production defect; final root review covers the dependency-boundary correction.
Keep the PR Draft pending CI and retain #608 open for its broader acceptance.
