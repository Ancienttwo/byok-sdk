# Prepared Agent Memory Contract — WP1-I-C

Status: accepted contract; SDK source implemented in `byok-sdk-wt-hermes-bot-adoption`. Current verification disposition is recorded in `tasks/reviews/20260928-0217-hermes-bot-adoption.review.md`. Host adoption and activation remain pending.

Authority: `docs/spec.md` delegates the next-version memory-only amendment to this document. Current SDK source implements this contract as input-preparation wire/record version 8, with explicit memory-only selection in prepared execution. This contract takes effect only with the atomic implementation and consumer cut below. It creates no compatibility path in running code.

## P1: boundary and design decision

Agent memory remains device-local `AgentMemoryService`, under exact AgentRef/home/lease and SHA-256 CAS. Host requests a capability and owns product semantics; it never supplies tools, executor identity, memory contents or credentials as capability authority. Official Pi remains provider/compiler/runtime authority. Compiler, request bytes, artifact envelope and memory filesystem are reused.

The implementation adds an explicit SDK-owned capability, not a registry entry. A dedicated SDK descriptor observation and a selected runtime registration share the existing `AGENT_MEMORY_TOOLS` definitions and handler. The current registry's reserved-name rejection remains mandatory.

This choice requires a finite new implementation-identity subject. `ToolImplementationSubjectV1` currently has only `mcp-server` and `runtime` (`packages/implementation-identity/src/identity.ts:362`); neither honestly identifies a memory helper. The existing install-record resolver, physical measurements, environment rules and fail-closed spawn verification remain the sole identity authority.

## C1: explicit selection and carriers

The next input-preparation version is **8**, provided 7 remains the immediate base at implementation freeze. If another workstream changes that authority, rebase this contract before coding; do not assign two meanings to the same version.

```ts
type PreparedAgentMemoryMode = 'none' | 'read' | 'read-write';
// Required field on every carrier listed below; no optional/default form.
agentMemory: PreparedAgentMemoryMode;
```

| Carrier | Required meaning |
| --- | --- |
| Local `InputPreparationRequestV1` and remote `AgentInputPreparationPayloadSchema` | Host's exact requested mode. No tools/schema/executor/credential fields are added. |
| `InputPreparationBindingV1` and strict receipt binding schema | Copy the validated requested mode, covered by request identity and durable record. |
| `TaskOfferPreparedPayloadSchema` only | Host re-presents the mode from the receipt; daemon compares exact equality before pin. Other offer types do not gain this field. |
| Prepared `RuntimeOperationManifest` and prepared launch/config | Sealed execution selection, immutable and included in manifest digest. Other operation variants have no prepared memory field; no default is added to ordinary offers. |
| Existing `InputPreparationAuthorityGrantV1` | Trusted local **ceiling** for that exact scope/Agent/profile, using the same three-value vocabulary. It is local authority, not caller text or an execution credential. |

The order is `none < read < read-write`. Missing, unknown or malformed values reject. Request above the local ceiling rejects; no downgrade. The trusted resolver already validates scope/device/Agent/profile; its returned memory ceiling must be consulted both at preparation and again at offer admission using the record's exact scope/profile. An unavailable resolver, stale profile or reduced ceiling rejects before claim. The ceiling is not copied into the Host receipt as a grant. Lookup/cancel retain their existing authorization semantics and do not mint execution rights.

Changing the resolver's trusted profile configuration follows its existing profile-revision authority. In-flight admitted executions retain the sealed selection; immediate revocation uses existing cancellation/quiescence and token revocation, not an unversioned edit to an active manifest.

`requiredToolsets` continues to mean Host MCP only. Preparation accepts an empty array when memory is non-none. For a memory-only prepared offer, omit `requiredToolsets` (the existing offer array requires at least one entry); daemon compares its normalized empty Host set with the recorded empty set. No change to the shared `RequiredToolsetsSchema`. A completely empty tool surface continues to refuse in this slice; zero-tools prepared execution is not added incidentally.

## C2: effective policy and invocation authority

The effective device policy, existing runtime expressibility checks and exact requested mode must all permit the selected tools. The matrix below is the Pi prepared support set; no new interactive approval capability is introduced.

| Effective mode | none | read | read-write |
| --- | --- | --- | --- |
| auto | Existing Host-MCP behavior | `memory_recall` | `memory_recall`, `memory_save` |
| readonly | Existing Host-MCP behavior | `memory_recall` | Reject |
| confirm | Existing Pi refusal | Reject | Reject |
| plan | Existing Pi refusal | Reject | Reject |

Pi currently refuses confirm and plan (`packages/client/src/adapters/pi/permission-mapping.ts:75`); this contract preserves that stronger constraint even though generic MCP filtering classifies plan as read-only. Existing `network:false` refusal and other inexpressible policy constraints remain.

Prepared native selection must still be empty (`allowTools: []` on the supported path). Memory is separately selected and never enabled through native `allowTools`. An effective `denyTools` entry equal to a selected memory tool's canonical bare name rejects the offer, rather than silently removing it from the counted set. No wildcard/alias/new name parser is added. Host MCP retains its existing qualified namespace and policy projection.

The daemon's task-context record gains the sealed memory mode. Both the helper dispatch and daemon control handler check the operation against that mode. A read token cannot call `save`, including a direct authenticated control-socket attempt bypassing UI/tool registration. `none` mints no memory token. Every operation still reconstructs exact task/tenant/device/AgentRef/session/runtime/home/lease/homeIdentity and rechecks existing filesystem/CAS constraints. Mode is never an MCP/model argument.

Ordinary fresh execution remains a distinct existing contract: its current reserved read/write grant is passed explicitly when constructing its context. Missing mode is not treated as read-write. This amendment does not silently reinterpret fresh readonly semantics; its narrower grant applies to the newly explicit prepared capability.

## C3: descriptor and implementation identity

### One descriptor source

`packages/client/src/bin/agent-memory-mcp-server.ts` remains the single authoring source for `AGENT_MEMORY_TOOLS`, descriptions, schemas and call semantics. Its SDK-owned entries gain an internal operation class `read` or `write`; missing/unknown classes reject. The classifier projects to descriptor selection and daemon operation ACL from this same table, not a second tool-name list. Classification is SDK authority and is not inferred from MCP annotations or names. The descriptor always advertises the complete ordered set `[memory_recall, memory_save]`; the explicit mode selects its deterministic subset. There are no second schema literals in the preparer, runtime or Host.

The SDK descriptor observation carries that operation class in each tools/list entry as `_meta: { "byok.agent-memory.operation": "read" | "write" }`, generated from the table. Missing/unknown values reject for this SDK subject. It is part of the descriptor digest and execution-handshake parity, but is not a provider tool parameter. The implementation must use one SDK-specific typed observation adapter that retains this field; generic Host MCP annotations never enter this classifier. Both helper roles project the same metadata, so selection does not depend on importing an unrelated copy of the installed helper's definitions.

Add one finite SDK helper entry **`agent-memory-describe`**, beside existing `agent-memory-mcp`. It serves the ordinary bounded MCP initialize/tools/list exchange from the same definitions, rejects **every tools/call**, and performs no control connection, Agent home discovery, memory read/write, credential lookup or task creation. It requires no BYOK memory context. It does not accept a client-controlled switch into execution mode.

Task-free preparation probes this entry after durable request reservation through the existing trusted launch boundary. Probe parsing/bounds/errors reuse the MCP transport, but the resulting observation is explicitly SDK-owned and never receives a synthetic Host toolset ID. The two roles publish the same serverInfo, negotiated protocolVersion and full ordered tools array; all three enter parity/digest checks. The real execution helper still requires the late-bound context credential. At execution handshake its full tools/list must equal the descriptor observation before any model request; unexpected/missing/duplicate definitions reject. Even if a caller supplies credentials to the descriptor role, it must refuse the execution-only input and may never open control IPC.

### Honest identity subject

Extend the existing identity subject/locator contract with this finite shape:

```ts
subject: { kind: 'sdk-helper', helperId: 'agent-memory' }
entry: 'agent-memory-describe' | 'agent-memory-mcp'
// Actual command/args/launch are device-resolved and physically verified,
// not values received from the Host preparation request.
```

No new general plugin/provider registry is introduced. Resolver output uses the current attested install-record representation; its SDK validator checks the entry's exact argv and measurements. In self-executable form the two fixed suffixes are `__byok_sdk_helper agent-memory-describe` and `__byok_sdk_helper agent-memory-mcp`. In dist-script form each entry is a separately measured SDK bundle. Neither form may stand in for the other by inference.

The private, daemon-authored launch binding carries the exact SDK helper subject, role, physically resolved identity and launch attestation. Its config digest and typed parser bind them together; a Host-supplied subject label cannot select this branch. Re-measure the helper closure and interpreter immediately before each descriptor or execution spawn, including after claim.

Current attestation explicitly excludes SDK memory context from its supported gated-child vocabulary (`packages/implementation-identity/src/identity.ts:665`). This amendment extends that vocabulary **only for the attested `sdk-helper/agent-memory-mcp` role**: `BYOK_STORE_DIR`, `BYOK_PRODUCT_ID`, `BYOK_AGENT_MEMORY_CONTEXT`, `BYOK_PREPARED_AGENT_MEMORY_MODE` are exact late-bound lifecycle names. The last field carries the sealed `read|read-write` operation selection and must match the execution spawn binding. The finite role declaration is bound in the helper identity; values remain in the private task configuration, excluded from digest/artifact/Host output. All four are prohibited for descriptor mode; the memory context name remains forbidden for Host MCP and other roles. Do not broaden the generic lifecycle allowlist or permit a `BYOK_*` wildcard. Existing private config/environment delivery is retained; no new stdin credential protocol or second transport is introduced.

Descriptor and execution identities are both resolved before preparation is marked ready. Their canonical identity pair, descriptor schema digest and runtime identity determine each memory executor fingerprint. A missing/unattested component keeps the receipt unready or produces a typed refusal; a descriptor process successfully answering tools/list is not implementation attestation.

The authenticated daemon's memory service is the local authorization authority, as it is today. The capability must be bound to that exact live daemon instance and supported SDK contract version; token routing cannot select an arbitrary endpoint. The helper identity attests the executable transport/handler, not a claim that its fingerprint independently attests all service code. Existing daemon trust and secure-filesystem admission remain explicit parts of the trusted computing base. No new remotely asserted service digest is invented.

On macOS the configured secure-filesystem helper must pass its existing admission; on Linux use the existing secure backend; unsupported platforms reject. Preparation may verify configured availability without opening or reading an Agent home. The real home-bound filesystem check occurs during execution admission/binding and on operations; descriptor success never waives it.

## C4: one binding, observation and persistence chain

Both shared digest functions in `packages/client/src/input-preparation.ts` advance their domain tag from `v:1` to **`v:2`** in the version-8 cut. Do not keep an old-digest branch.

- Binding digest includes existing launch/Host registry revisions/server identities plus required `agentMemory` and a memory implementation pair (descriptor entry identity and execution entry identity). For `none`, the pair is explicitly null. Environment credential **values** are never included; current environment-name/loader measurement rules still apply.
- Observation digest includes that same selection/pair, existing Host tools/executors, the complete SDK descriptor digest and selected model-visible memory tools/executor fingerprints. `none` has null descriptor data and no selected memory tools.
- Full descriptor schema identity includes name, description, complete inputSchema and every supported model-visible schema attribute. A changed description or constrained-sampling attribute must not evade drift detection. The exact canonical serialization is defined once in the shared source, consumed at preparation, admission and launch.
- Canonical model-visible order is current Host MCP projection order followed by selected memory tools in `[memory_recall, memory_save]` order. Name collisions reject before compilation; memory retains bare names and Host MCP retains qualified names.
- Memory-only still resolves the same trusted launch attestation for descriptor/helper processes. Empty Host server/revision maps are honest empty maps, not fake MCP observations and not null/guessed cwd. Both assembler sides permit an empty Host projection only when selected memory tools make the combined surface nonempty.

The compiler receives the **combined** tools/executors once. Existing request bytes, projection, optional provider counter, accounting-policy applicability, artifact envelope and summary digest fields are reused. No mandatory counter is added; absent counter continues to use exact request-byte evidence. The stored binding gains `agentMemory`; the artifact format and Pi envelope version need no new memory-content field. Durable record schema moves from 7 to **8** because its binding changes; wire/artifact version derives from the single `INPUT_PREPARATION_WIRE_VERSION` authority, not another constant.

Replay of a requestId compares the new request identity and spawn-free binding facts without a second descriptor probe. A changed mode, helper identity, registry definition or launch binding is a conflict/refusal; never recount under the same key. Compiler/runtime identity changes retain existing fail-closed semantics.

## P2: execution trace and lifecycle

1. **Prepare:** authenticate and resolve exact scope/profile/source plus memory ceiling; validate mode/policy/availability, reserve request identity, resolve both helper identities, obtain bounded descriptor observation without a task credential, assemble combined tools, compile and persist ordinary artifact/accounting evidence.
2. **Offer admission:** authenticate the ordinary offer; re-present record/digests/memory mode; re-resolve current local ceiling, effective policy, Agent/home/lease and helper implementation pair. Observe the SDK descriptor and Host servers through their separate authorities. Compare each named fact and both shared digests against the local record. No context token is minted yet.
3. **Seal → pin → claim:** freeze selection and credential-free identity in the execution manifest. The existing pin CAS remains before claim. A pin loser claims nothing and obtains no credential. Claim cancellation/failure releases resources through the existing lifecycle.
4. **Bind and launch:** after successful claim and active execution creation, mint a fresh task token carrying its exact mode. Pass it only through the existing private task-scoped helper configuration to the memory helper, never to Host servers. Resolve/verify the execution helper through its sealed SDK identity, handshake and compare full descriptor, register only the selected tools. This is an explicit prepared registration, not `resolveReservedMcpToolGrants` or the live extension's blanket reserved grants.
5. **Call:** selected closure routes to the existing helper and control API; daemon checks mode plus active identity/lease before `AgentMemoryService`. `save` uses caller-stated expected revision and existing CAS, without retries that change intent. Runtime must verify exact manifest names/identities before its first provider request. Later tool results remain subject to existing per-call budget/usage checks.
6. **Close/fail:** any post-claim handshake/schema/identity/availability failure emits the existing truthful task failure and revokes context; no provider call or memory operation is allowed before validation. Cleanup follows existing cancellation/quiescence rules; in-flight memory operations settle before snapshot/close, then token is revoked and filesystem/lease resources released. Never release a pin while an execution might still consume the artifact. Daemon restart follows existing task recovery; no memory token is serialized for reuse.

Frozen schemas and initial request do **not** freeze memory bytes. Recall reads current authorized local state; this contract introduces neither auto snapshot nor next-turn-only visibility. Host approval-to-device writes, proposal idempotency, retention/forget beyond local CAS and UI governance remain WP2-I.

## C5: typed failure contract

Reuse existing channels and add only these stable semantic details to their finite validators:

| Failure | Required outcome |
| --- | --- |
| Missing/unknown mode | Existing strict request/offer parse failure |
| Request above local ceiling | `scope_denied`, detail `agent_memory_denied` |
| Policy conflicts with selected tools | `permission_mode_denied`, detail `agent_memory_policy_conflict`; offer nonretryable decline |
| Secure platform/helper unavailable | `unsupported_input`, detail `agent_memory_unavailable` |
| Descriptor probe unavailable/malformed | `toolsets_unobservable`, detail `agent_memory_descriptor_unobservable`; never silently drop memory |
| Descriptor or identity changes | Existing binding/observation drift refusal, identify memory component in metadata-only detail |
| Offer mode differs from record | New prepared admission reason `agent_memory_mismatch`, before pin/claim |
| Direct forbidden control operation | `AgentMemoryError` with stable `agent_memory_operation_denied`, zero service side effect |

Diagnostics must contain no path contents, token, raw memory or credential. Post-claim failures use existing task failure envelopes; they are not reclassified as a preparation success or retried with memory disabled.

## C6: one-shot version and consumer cut

Implementation must update these together: wire version 7→8, derived capability token, local request parser, remote message/parser/HTTP relay, receipt schemas, durable binding/record version, offer schemas, task manifest/config serialization, both digest producers/consumers, installation-identity consumers, tests/goldens and Host request/offer/receipt builders. Existing Host-only callers must state `agentMemory:'none'`; missing is rejected, never filled by SDK defaults.

Named first consumer: Salesko's prepared candidate `salesko-new-wt-c07-host` (research base `5670f5d12537b12636df896bccf7bbbe25f02e69`), especially `apps/api/src/private-agent-chat-preparation-request.ts` and `apps/api/src/private-agent-chat-preparation-lane.ts`. Its current consumer must explicitly author `none` until it intentionally requests memory; a SDK default is not an adoption. The SDK cloud request/receipt facts in `packages/cloud/src/input-preparations.ts`, handler in `packages/cloud/src/handlers/input-preparations.ts` and protocol HTTP schemas in `packages/protocol/src/http-api.ts` are part of the strict consumer audit. Recheck candidate HEAD/WIP at implementation; these references grant no cross-repo write permission in this docs task.

No change to global `PermissionPolicySchema` is needed. This Owner-approved amendment extends the existing **scoped input-preparation cut** in `docs/protocol.md:54`: the outer envelope stays `PROTOCOL_VERSION=1`, while the entire strict preparation/prepared-execution lane moves to `agent-input-preparation-v8`. This is a paired-upgrade exception, not an additive rolling change. It does not authorize strict changes to unrelated messages. The admission gate must reject peers that do not support version 8 before enqueue.

Operational prerequisite: stop new preparation/offer admission, drain in-flight version-7 work, ensure no live pin/claim, and retire retained version-7 records/artifacts through a bounded operator-invoked maintenance action before paired activation. Old records are never auto-converted or read forward. Maintenance must list/count/version-check its exact namespace, refuse any live pin, retain the required audit/tombstone evidence, and never touch Agent memory. Its concrete command and authorization belong to the implementation/release package, not this docs change. Existing strict old-record startup refusal is not waived.

Activation, publication, deployment and destructive retirement require their own existing release authorization. Source checks, packed candidate, Host adoption, registry and live runtime evidence remain separate.

## P3: tradeoff and 10x pressure

The separate descriptor role costs one bounded helper observation per new preparation and admission, but it avoids issuing task credentials to count tools and prevents two independent schema definitions. Replay stays spawn-free. At 10x preparation volume, process/probe concurrency and artifact limits are the first pressure points; use the existing timeout/size/concurrency/cancellation controls and refuse capacity exhaustion. Do not add a cache with a second freshness authority in this slice.

An alternative in-process descriptor import avoids a helper probe but does not prove what a separately shipped helper advertises. Treating the helper as Host MCP conflates authoring and authorization. Both are rejected here. If the installed identity authority cannot attest both SDK helper roles, return unready/refusal; do not substitute the Pi runtime identity or an unverified package version.

## Implementation ownership and sufficient acceptance

Root assigns one sequential SDK implementation owner; parallel Host work must not write SDK files. The paths below are the bounded candidate change surface, not product edits made by this contract task.

| Slice | Exact existing entrypoints |
| --- | --- |
| Protocol/control/types | `packages/protocol/src/input-preparation.ts`, `packages/protocol/src/messages.ts`, `packages/client/src/input-preparation.ts`, `packages/client/src/daemon/control-protocol.ts`, `packages/client/src/daemon/input-preparation-remote.ts`, `packages/client/src/types.ts` |
| Authority/preparation/admission/storage | `packages/client/src/daemon/input-preparation-service.ts`, `packages/client/src/daemon/prepared-tool-surface.ts`, `packages/client/src/daemon/prepared-offer-admission.ts`, `packages/client/src/daemon/input-preparation-store.ts`, `packages/client/src/daemon/task-runner.ts` |
| SDK identity and descriptor role | `packages/implementation-identity/src/identity.ts`, `packages/implementation-identity/src/index.ts`, `packages/client/src/sdk-reserved-helper-host.ts`, `packages/client/src/bin/sdk-reserved-helper-runners.ts`, `packages/client/src/bin/agent-memory-mcp-server.ts`, `packages/client/src/daemon/resolve-agent-memory-mcp-bin.ts`, `packages/client/tsup.config.ts` |
| Pi transport/registration | `packages/client/src/adapters/pi/input-preparation.ts`, `packages/client/src/adapters/pi/prepared-tools.ts`, `packages/client/src/adapters/pi/prepared-session.ts`, `packages/client/src/adapters/pi/mcp-server-pool.ts`, `packages/client/src/adapters/pi/pi-adapter.ts`, `packages/client/src/bin/pi-prepared-host.ts` |
| Local operation denial | `packages/client/src/daemon/agent-memory.ts`; content/path/CAS semantics otherwise retained |

The dist entry is `packages/client/src/bin/byok-agent-memory-describe.ts` (new); its fixed script output is `byok-agent-memory-describe.js`, mapped by the existing SDK helper host and included by tsup. Shared SDK-only observation/selection logic may live in `packages/client/src/agent-memory/prepared-capability.ts` (new), serving preparation/admission/runtime; it imports the single definition table rather than redefining schemas. Installer declarations and exact Host files must be named in the implementation contract before writing them. This is not permission for a wildcard edit. SDK tests must include the following observable cases rather than mirror a switch statement:

1. Version-8 memory-only read and read-write produce exactly the counted schemas/fingerprints, same persisted request bytes and runtime names; mixed Host MCP keeps its existing authority and canonical order.
2. Task-free descriptor tools/call always refuses without control connection, home access or token; timeout/cancellation cannot leave its child alive.
3. Read mode tries save via registered tool and direct control API: both reject without audit falsely claiming a successful save or changed file revision.
4. Cross Agent/profile/device/session/lease token use and stale/closing tokens reject; a failed post-claim launch revokes credentials and completes truthful failure cleanup.
5. Schema/description/implementation/launch change at each boundary rejects before provider request or memory side effect; replay does not probe again; two offers race one pin and only one receives a token.
6. readonly + read-write, any confirm/plan, selected-name denyTools and local ceiling decrease reject without silently narrowing the manifest; `none` never launches a memory process.
7. Version-7/missing-field inputs fail strict admission; no old capability token, old record read or dual digest path. Operator retirement refuses live pins and never touches Agent home.

Run focused protocol/preparation/identity/memory tests first, then the repository's required checks on the frozen implementation. Current contract-only validation is limited to source-grounded design consistency, scope/links/format and strict workflow. **No runtime/product PASS is claimed by this document.**
