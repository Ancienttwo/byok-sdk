# #386 remaining protocol compatibility: assessment and next staged slice

Assessment baseline: `origin/main@76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c` (2026-10-14). This is a docs-only Draft for [#386](https://github.com/Ancienttwo/byok-sdk/issues/386), following merged staged [#447](https://github.com/Ancienttwo/byok-sdk/pull/447). It implements no runtime or test changes and does not close #386.

## Conclusion

Keep #386 open. #447 delivered the production envelope-additions table, published-decoder checks, append-only envelope corpus/release-prefix registry, sender admission integration and the single freeze rule. Its description explicitly deferred HTTP corpus/registry evidence, recursive path and enum completeness, client decoder unification/exemptions, and the constants entry. Current main still has those gaps.

The immediate independent slice is compatibility evidence for the HTTP bodies already present on main. The public `EventsPollResponse.events` cutover remains an owner decision; adding the HTTP evidence must not silently choose it. Full issue completion also needs the later completeness and decoder slices.

## P1: current boundary and authority

| Authority / consumer | Verified current implementation | Limit of this evidence |
| --- | --- | --- |
| Production additions | [packages/protocol/src/wire-additions.ts:26](https://github.com/Ancienttwo/byok-sdk/blob/76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c/packages/protocol/src/wire-additions.ts#L26) defines `WireAddition.surface` as `MessageType`; senders use `requiredReceiverCapabilities`. | The table has no HTTP surface kind. |
| Published decoders | [packages/protocol/package.json:53](https://github.com/Ancienttwo/byok-sdk/blob/76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c/packages/protocol/package.json#L53) pins registry tarball aliases for floor 0.25.0 and previous 0.26.1. | These are protocol packages, not executions of the old client-private parsers. |
| Release byte ledger | [packages/protocol/src/__tests__/compat.test.ts:49](https://github.com/Ancienttwo/byok-sdk/blob/76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c/packages/protocol/src/__tests__/compat.test.ts#L49) reads `v2.envelopes.ndjson`; its `ReleaseEntry` contains only `envelopes`. | No `v2.http.ndjson` or HTTP prefixes exist. |
| Schema compatibility | [packages/protocol/src/__tests__/compat.test.ts:233](https://github.com/Ancienttwo/byok-sdk/blob/76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c/packages/protocol/src/__tests__/compat.test.ts#L233) compares all released `*Schema` exports, including HTTP schemas, for narrowing. | Schema structure comparison does not exercise HTTP body bytes or batch accounting. |
| Corpus completeness | [packages/protocol/src/__tests__/compat.test.ts:376](https://github.com/Ancienttwo/byok-sdk/blob/76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c/packages/protocol/src/__tests__/compat.test.ts#L376) covers every additions-table row, message type, and top-level payload key added since the floor. | It does not enumerate every recursive payload/body property path or every enum value. No new estimate of missing paths was measured. |
| Freeze rule | [docs/protocol.md:35](https://github.com/Ancienttwo/byok-sdk/blob/76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c/docs/protocol.md#L35) states version bump / gated addition / strip-safe addition; architecture and version comments link to it. | The document itself says HTTP bodies are not in the corpus yet at line 88. |
| Release maintenance | [docs/releases/README.md:6](https://github.com/Ancienttwo/byok-sdk/blob/76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c/docs/releases/README.md#L6) records both aliases, immutable prefixes and registration timing. | HTTP ledger introduction still needs an explicit evidence boundary. |
| Client receive policy | [packages/client/src/daemon/long-poll-transport.ts:143](https://github.com/Ancienttwo/byok-sdk/blob/76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c/packages/client/src/daemon/long-poll-transport.ts#L143) validates the page privately, then parses each event independently. | The exported protocol schema still uses `EnvelopeSchema[]`, so substituting it now changes unknown-event behaviour. |
| Renewal control data | [packages/client/src/daemon/auth-manager.ts:271](https://github.com/Ancienttwo/byok-sdk/blob/76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c/packages/client/src/daemon/auth-manager.ts#L271) casts challenge/token JSON to exported response types at lines 284 and 299. | Shared response schemas are not invoked on this path. |
| Constants entry | [packages/protocol/package.json:23](https://github.com/Ancienttwo/byok-sdk/blob/76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c/packages/protocol/package.json#L23) exports the root and `input-preparation-version`. | No `./constants`; coordinate its owner in #398. |

HTTP bodies, envelopes and client-private parsers are distinct evidence surfaces. Core-owned declaration/truth routes, historical unreleased query flags, Host production and paid provider calls are outside this slice.

## P2: concrete production trace

The outbound trace is daemon envelope batch → `POST /byok/messages` → the hosted messages handler's real `MessagesSendRequestSchema` and inbound dispositions → `accepted`/optional `rejected` plus handshake capability advertisement → [packages/client/src/daemon/long-poll-transport.ts:367](https://github.com/Ancienttwo/byok-sdk/blob/76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c/packages/client/src/daemon/long-poll-transport.ts#L367). The client parses `MessagesSendResponseSchema`, verifies `accepted + (rejected ?? 0) === envelopes.length`, and returns the response only after that equality. An invalid body/count produces a route failure and no usable response. Counts are acknowledgement authority, not an additive field to lose silently.

The receive trace is requested cursor/optional `afterSeq` → mailbox handler → raw poll JSON → private outer-page validator → per-entry `parseMessage` → ordered handler/cursor disposition. A malformed/unknown executable entry must not be erased by validating the entire array as known envelopes; a later valid event must not acknowledge across the gap. Source: [packages/client/src/daemon/long-poll-transport.ts:453](https://github.com/Ancienttwo/byok-sdk/blob/76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c/packages/client/src/daemon/long-poll-transport.ts#L453) and the retained unknown-type/stall suites.

Renewal is separately challenge JSON → nonce signature → token JSON → atomic credential replacement ([packages/client/src/daemon/auth-manager.ts:271](https://github.com/Ancienttwo/byok-sdk/blob/76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c/packages/client/src/daemon/auth-manager.ts#L271)). Moving both responses to shared runtime schemas changes a control-data admission boundary and belongs to the explicitly reviewed decoder cutover, not to a fixture-only HTTP evidence slice.

## #447 completion evidence and remaining acceptance

| #386 criterion / full-scheme item | Current assessment |
| --- | --- |
| Published-decoder suite and homeAccess / unknown agent-home-readers gate | Delivered by #447. Its accepted head has 48 successful CI checks. |
| Five required negative mutations | #447 records failures for removing homeAccess, using an already-known gate, changing released corpus byte 1, removing finalMessage and lowering maxLength. Those are recorded mutation results; this assessment does not claim a fresh rerun. |
| Cloud envelope admission derives flags from the table | Delivered, with `wire-additions-admission.test.ts`; current HTTP receipt gates remain a different surface. |
| Single freeze rule and release alias timing | Delivered. |
| Explain each deleted assertion | #447 contains an explicit replacement table; it intentionally retained the negotiation drill and HTTP additive-poll block. These retain receiver-policy evidence, not an alternative mutable fingerprint authority. |
| HTTP corpus and HTTP prefix ledger / batchLength | Still missing. |
| Every recursive payload/body path and enum value | Still missing; existing completeness is narrower. |
| Client unified events/challenge/token decoders and typed release exemptions | Still missing; owner decision 5 remains open in #447. |
| Constants entry | Still pending #398. |

Evidence freshness: `git diff --quiet 89ade4de2380818b48d2ca63eff80e505f84434b..76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c -- packages/protocol` returns 0. Protocol source/tests are identical to the #447 head whose CI completed successfully. This is reuse of that exact protocol evidence, not a claim of a fresh full-workspace run on this assessment branch.

The current envelope corpus has 47 lines. A local byte-level check independently recomputed the registered 32-line SHA-256 prefix for 0.25.0, 0.26.0 and 0.26.1; all three match. The same inventory confirms no HTTP corpus and no HTTP registry members.

## Corrections to the historical issue scheme

- `noHold` is not a remaining main feature. [CHANGELOG.md:115](https://github.com/Ancienttwo/byok-sdk/blob/76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c/CHANGELOG.md#L115) says the unreleased flag was removed because handshake readiness now comes from `POST /byok/messages`; no current source definition/caller exists. Do not restore it for compatibility coverage.
- #391 is closed. `MessagesSendResponse.capabilities` exists at [packages/protocol/src/http-api.ts:260](https://github.com/Ancienttwo/byok-sdk/blob/76e59b217e4fa6caf2c2ab7e7e1d1017c6ad337c/packages/protocol/src/http-api.ts#L260), is optional, and is emitted on accepted handshake batches. Absence means no advertisement update on the client; the plan must preserve that observable distinction.
- #397 is open. Current `MessagesSendResponseSchema` has no `outcomes`, and current `EventsPollResponseSchema` has no `ingress`. Do not add fictitious vectors, aliases or guessed semantics. Add their vectors/declarations only with the actual contract when it lands.
- #398 is open, and the constants entry does not exist here. Root export of `WIRE_ADDITIONS` is already present; a narrow entry is separately owned.

## P3: decision and next staged slice

Stage HTTP evidence for existing contracts; keep the current receive policy and public event-array type during this slice. This isolates an observable gap without a second production parser, a test-local allowlist, feature flags or a parallel runtime path. At larger protocol surfaces, the first weakness is unobserved nested branches and dropped fields; the later completeness slice must bound that gap explicitly.

### Scope and ownership

- `packages/protocol/src/wire-additions.ts`: extend the one production table to identify HTTP surfaces/field paths needed by the existing HTTP corpus. Sender capability derivation remains for envelope admission. Apply the repository's public API/version policy and review the intentional API-surface delta; do not suppress it.
- `packages/protocol/src/__tests__/compat.test.ts` and `golden/v2.http.ndjson`: test current and both published HTTP schemas against owned literal raw bytes. Use existing schemas, never a reimplementation of either decoder. All new corpus lines remain append-only.
- `golden/releases.json` and `docs/releases/README.md`: define the first HTTP-corpus release boundary and enforce prefix immutability for releases that actually ship it. Existing registered envelope bytes/hashes must remain unchanged. Historical HTTP bytes were not recorded: do not backfill fabricated shipped-prefix claims. The ledger transition must be explicit and reviewed before implementation, with no inferred/default historical HTTP proof.
- Keep the retained HTTP additive-poll test and client negotiation/unknown-event tests until their actual replacement proof is present. Do not delete an assertion based only on a newly created filename.
- No work on #436/#437, Draft #430/#431, Host production or paid-model calls.

### Fixtures and positive/negative checks

1. Cover current challenge/token responses and legal events-page/request bodies; distinguish protocol schema compatibility from the separately exempt old client-private parsers.
2. Cover current `MessagesSendResponse` with absent/present capability advertisement and `accepted`/`rejected` variants. Associate response vectors with a posted batch length; require the current validated response's authoritative counts to sum to that length.
3. For each released schema, an accepted HTTP body may lose only an explicitly declared strip-safe path. A rejection requires a documented supported receiver admission rule; fail on unclassified loss/rejection. Do not label authoritative acknowledgement counts strip-safe.
4. Introduce typed, bounded exemptions for client-private decoders of releases at or below 0.26.1, naming the surface, unexecuted boundary and removal condition from #386. These are proof exclusions, not synthesized runtime output.
5. Mutate a committed HTTP byte, remove each HTTP declaration and change a batch count to show the corresponding checks fail. Restore every mutation; preserve all existing assertions and deadlines.

### Exit criteria for this slice

The real current/floor/previous HTTP schemas pass the owned corpus; declarations are exercised and dropped paths are classified; batch-count mismatches and recorded prefix changes fail; public API and version deltas are intentional. The release-boundary decision is resolved without claiming old HTTP bytes existed. Existing envelope tests, admission tests and receiver-policy tests still pass. Report HTTP coverage separately from full recursive/enum coverage.

Required implementation verification follows #386: protocol compat/freeze/http routes; cloud wire-additions/admission and device surface; server agent-home readers; client unknown-message/stall/reliability suites; build/typecheck, API surface, version authority, release graph and script tests. Use the shared install/build/typecheck lock and isolated TMPDIR; exclude local tests that write real macOS Keychain as required. No whole-suite rerun is needed for this docs-only assessment.

## Following slices and issue closure

After the HTTP ledger/corpus slice, add recursive property-path and enum completeness over both corpora using the real current schema surface. Then resolve the owner decision for the one-shot client decoder cutover, remove the private parser/casts in that same work-package, and preserve stall/cursor/auth refusal behaviour. Coordinate #398's constants export independently.

Close #386 only when the actual full-scheme rows above have completion evidence or an explicit owner-approved scope change. Successful #447 CI and six delivered acceptance bullets do not make its listed Deferred work complete. This Draft is a staging artifact, not a close comment or implementation acceptance.
