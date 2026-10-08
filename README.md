# BYOK SDK

BYOK SDK lets a SaaS product dispatch work to coding-agent runtimes already
authenticated on an end user's machine. It includes a local daemon, a
self-hosted server façade over the cloud kernel, and a hosted multi-tenant
composition over Postgres and R2.

## Release status

The current source candidate is the prerelease **0.25.0-rc.1** for the eight
aligned packages, with independent keys **0.10.0-rc.1**. The release owner
approved it on 2026-10-09. It is not published. Publication will use the npm
dist-tag `rc`, so `latest` stays 0.24.0 / keys 0.9.0. The public set is nine
packages; `@byok-sdk/implementation-identity` is retired.
[Release notes](docs/releases/v0.25.0.md) describe the breaking changes since
0.24.0 (protocol v2, minimal guardrails per ADR-037, removed configuration keys
and APIs, the keys launcher grammar, Pi 1.1.0 and OAR 0.44.0) and the upgrade
steps.

Versioned install examples below describe the current source manifests. They
are usable only after publication and exact registry readback. Before
publication, a Host can test verified accepted CI tarballs from one exact SHA;
that does not establish production or live-runtime acceptance.

The current `latest` release is **0.24.0**, with independent keys **0.9.0**.
npm shows all ten 0.24.0 / keys 0.9.0 packages published on 2026-10-06; their
registry integrities equal the push CI `release-pack` artifact of `756eb921`.
The repository has no `v0.24.0` tag and no publication record for it. The
[0.24 release notes](docs/releases/v0.24.0.md) describe its Node, adapter,
identity and SQLite changes and the Host upgrade/rollback steps from 0.23.

The last publication with a record here is **0.23.0**, with independent keys
**0.8.0**, published on 2026-09-28 from `v0.23.0` (`bcf65a3f`, PR #237).
Its [publication record](docs/releases/v0.23.0-publication.md) records `latest`
at that time; query the registry before relying on current tags. The
[0.23 release notes](docs/releases/v0.23.0.md) describe sealed provider
provisioning, its breaking keys store/request changes and the input-preparation
v8 cut, which still applies to Hosts upgrading from 0.22.

The preceding release is **0.22.0** with keys **0.7.0**, published on 2026-09-25
from the `v0.22.0` tag (`0962f14f`, the PR #234 merge); see its
[publication record](docs/releases/v0.22.0-publication.md) and the
[Salesko / Owner handoff](docs/releases/v0.22.0-handoff.md), which describes the
official Pi cutover.

Before it came **0.21.0** with keys **0.6.2**, published on 2026-09-24/25
from the `v0.21.0` tag (`8b7a2121`, the PR #227 merge); see its
[publication record](docs/releases/v0.21.0-publication.md). Earlier came
**0.20.0** with keys **0.6.1**, published on 2026-09-23
from the `v0.20.0` tag (`48605554`, the PR #224 merge); see its
[publication record](docs/releases/v0.20.0-publication.md), then
**0.19.0** with keys **0.6.0**, published on 2026-09-22
from the `v0.19.0` tag (`9408ed7b`, the PR #221 merge; see its
[publication record](docs/releases/v0.19.0-publication.md)), then
**0.18.0** with keys **0.5.0**, published on 2026-09-10
from the `v0.18.0` tag (`7b26ef5f`, the PR #181 merge); see its
[release notes](docs/releases/v0.18.0.md) for the breaking custom-store boundary
and the keys SQLite profile schema; then **0.17.0** with keys **0.4.3**
([publication record](docs/releases/v0.17.0-publication.md)) and
[0.16.0](docs/releases/v0.16.0-publication.md).

The published 0.23.0 train, like 0.22.0, uses unmodified official
`@earendil-works/pi-coding-agent@0.87.1` and its attested sibling closure;
the current source pins 1.1.0 (unreleased).
The maintained fork is retired from this train; 0.21.0 remains the historical
fork-based release. Release SemVer is observability only;
protocol intersection and advertised capabilities remain the execution gates.
Publishing an SDK release does not perform a host's production migration or
deployment.

## 0.4.0 custom RuntimeAdapter migration

0.4.0 intentionally removes the old `id`, `capabilities()`, optional
`environmentRequirements()`, `supportsDispatchSelection`, and direct `start()`
adapter shape. Custom adapters must expose one frozen `descriptor` and a
required, side-effect-free `prepare()` method that returns either `{ kind:
'reject', ... }` or `{ kind: 'prepared', operation }`. The operation's
`start({ manifest, instruction, env, ... })` runs only after the daemon has
sealed its credential-free manifest and claimed the offer. Do not ship an
adapter that supports both shapes or allocates process/temp/workspace/session
resources during `prepare()`; reject unsupported input before claim instead.

Install the scoped packages your composition uses and import each one under
its own name. For example, a self-hosted composition:

```sh
npm install @byok-sdk/server@0.25.0-rc.1 @byok-sdk/client@0.25.0-rc.1
```

```ts
import { createByokServer } from '@byok-sdk/server';
```

The Worker-only cloud-do package is published from 0.24.0. The example below
names the 0.25.0-rc.1 candidate; it becomes usable only after publication and
exact registry readback.
See [the cloud-do README](packages/cloud-do/README.md) for the subclass and binding.

~~~sh
# Release candidate source version; publication is pending.
npm install @byok-sdk/cloud-do@0.25.0-rc.1
npm install --save-dev @cloudflare/workers-types
~~~

The public candidate dispatch packages are `@byok-sdk/client`, `@byok-sdk/server`,
`@byok-sdk/cloud`, `@byok-sdk/cloud-dataplane`, `@byok-sdk/cloud-do`, `@byok-sdk/core`,
`@byok-sdk/protocol`, and `@byok-sdk/ui-runtime`, all on the same train.
`@byok-sdk/implementation-identity` is retired and no later train publishes it.
Starting with 0.21.0, the `byok-sdk` namespace
umbrella and `@byok-sdk/testkit` are no longer published. Their existing
versions stay on npm; see
[Packages no longer published](docs/releases/v0.21.0.md#packages-no-longer-published).

## Choose a composition

- Self-hosted: use `server` as the Hono/HTTP façade over the shared `cloud`
  domain kernel, and `client` for the local daemon. The daemon uses the
  authenticated long-poll HTTP path for both receive and send. This is the
  smallest complete deployment and does not require Postgres or object
  storage.
- Hosted: use `cloud` for stateless device routes and `cloudDataplane` for the
  durable Postgres + R2 data plane. The host owns authentication, scheduling,
  migration execution, deployment, signing, updater channels, and operations.
  The same data plane also hosts on Cloudflare Workers via Hyperdrive through
  the `@byok-sdk/cloud-dataplane/runtime` subpath — see
  [`@byok-sdk/cloud-dataplane`'s deployment compositions](packages/cloud-dataplane#deployment-compositions).
- Timeline projection: use `uiRuntime` to fold a typed cloud activity tail into
  a deterministic, React-free Live Activity Timeline view model. Browser auth,
  redaction, transport, and presentation remain host responsibilities.

Both profiles share the frozen v2 protocol, tenant isolation, durable device
proof, truth CAS, and explicit capabilities.

Sessions run YOLO in the user-specified workspace. The user's own Claude Code,
Codex and Pi configuration and guardrails apply; the SDK keeps only the
invariants it owns. See
[ADR-037](docs/architecture/adr-2026-10-07-minimal-guardrails.md) and
[the security model](docs/security.md).

## Agent-first local homes and egress

The additive Agent execution path treats a task as one run of a durable Agent.
The host supplies an absolute branded `hostStorageRoot` plus an exact
`AgentRef`; the SDK alone composes `<hostStorageRoot>/agents/<agentId>`,
initializes and preserves `MEMORY.md`/`notes/`, enforces one writer, and seals
that canonical home as the Pi/Claude/Codex cwd. An Agent dispatch requires the
target daemon's durable `agent-home-contract` capability and never falls back
to `workspaceRoot/<taskId>`.

Profile projection content and every non-`.byok` Agent file remain downstream
owned and opaque. In particular, `artifacts` is not an SDK schema or a required
directory. See [the host local-storage contract](docs/host-local-storage-layout.md).

The Agent egress contract adds one consumed `AgentEgressPolicy`.
Agent egress goes to the Host as the runtime produced it. The SDK does not
filter, redact or omit it; the policy sets only transport limits and the
content-read surfaces. Reliable evidence is fsynced under the
canonical Agent home and retried with stable cursors until an exact ack, while
latest-value activity remains replaceable and reports typed drop reasons.
The daemon's tenant binding comes only from the authenticated pair response
atomically persisted in its local `DeviceRecord`; Agent egress has no
host-authored `tenantId` setting and never parses the access token. Workspace,
transcript, and artifact reads are separately disabled/enabled,
path/MIME/size checked locally, audited per Agent, and represented to cloud by
content-free receipts plus authenticated `BlobRef`s. Salesko supplies tenant
authorization and pairing authority, stable Agent/Profile identity, policy and retention; it does
not compose Agent paths, implement SDK journals, or mirror the full local
transcript as shared history.

## Agent diagnostics and recovery integration

The SDK maintains the [downstream integration guide](docs/agent-diagnostics-integration.md)
for diagnostic UI, local CLI wiring, bounded health repair, support bundles,
and acceptance scenarios. It distinguishes device diagnostics from Agent
readiness and identifies SDK capabilities still needed by embedded hosts.

## Conversation-turn mode: current status and authoritative path

Continuous multi-agent conversation ("conversation-turn", a "Grok Bot"-style
experience) is a Host composition over the SDK's fresh-execution and reliable
message primitives. The Grok Bot reference describes the target experience
only; no third party's internal storage, lifecycle, or exactly-once behavior
has been independently verified.

Read the layers in order; each has exactly one authority, and there is no
second acceptance ledger:

| Layer | Authority |
|---|---|
| SDK product truth | [`docs/spec.md`](docs/spec.md) — [Durable Agent homes](docs/spec.md#durable-agent-homes), [Fresh Agent egress versus exact resume](docs/spec.md#fresh-agent-egress-versus-exact-resume), [Host exact Agent message disposition readback](docs/spec.md#host-exact-agent-message-disposition-readback), [Recurring Host composition requirements](docs/spec.md#recurring-host-composition-requirements) |
| Host composition requirements (approved) | [Conversation-turn Fresh MVP PRD](docs/researches/2026-09-09_conversation-turn-fresh-mvp-prd.md) and the [Host Reliability Addendum](docs/researches/2026-09-09_conversation-turn-mode-host-reliability-addendum.md) |
| Design history | [Original design draft](docs/researches/2026-09-09_conversation-turn-mode-design.md) — historical draft; its open questions, hybrid/resume outlook, and simplified completion bridge are superseded (see the qualifier at its top) |
| Sole acceptance ledger | [Salesko Host reliability Sprint plan](https://github.com/Ancienttwo/salesko-new/blob/codex/recurring-sdk-adoption-test/plans/plan-20260909-private-agent-chat-host-reliability-sprints.md) (external repo, draft branch), with the [SDK-first plan](plans/plan-20260910-conversation-turn-sdk-first.md) as the in-repo stage entry |
| Active PRs | byok-sdk: #191 (open, unmerged); Salesko integration: draft PR #241 |

Historical adoption checkpoints below are bound to their recorded source SHA,
artifact or CI evidence; they are not a live main/PR/registry status report. See
the release status above for the current source candidate. 未验收 means not
accepted, and no overall percentage is defined:

| Dimension | Status | Bound to |
|---|---|---|
| main implementation | Merged | Sealed remote provider provisioning #237 merged at `bcf65a3f` (2026-09-28), with the prepared Agent memory / input-preparation v8 cut #236 (`0a47d4e7`); released as 0.23.0 / keys 0.8.0 from `bcf65a3f`. Earlier: official Pi migration #233 merged at `9fe732e6` (2026-09-25): wire/record 7, Host systemPrompt, envelope v4, M4 regression and M5 calibration complete; released as 0.22.0 through #234 (`0962f14f`). Earlier: `main` @ `8b7a2121` (2026-09-24): #226 P0 prepared message egress (`644f8473`; BREAKING input-preparation wire version 6, capability token `agent-input-preparation-v6`, `TaskOfferPreparedPayload` requires `egressPolicy`, fresh-lane Pi `allowTools: []` means zero native tools), released as 0.21.0 through #227 (`8b7a2121`), which also cut the published set to nine packages (eight aligned plus keys; `byok-sdk` and `@byok-sdk/testkit` retired). Before it, as of `48605554` (2026-09-23): #223 bounded admission — byte evidence replaces the live-tokenizer readiness gate (`c61615f8`; BREAKING input-preparation wire version 5, record schema version 6), released as 0.20.0 through #224. Earlier, as of `26945c8a` (2026-09-19): recurring input, exact message disposition and fresh egress per the spec section above; #193 C07 Pi runtime launch (`d882aef4`), #198 Windows CI elimination (`49ec7477`), #199 custody five-edge enablement (`e0423d84`), #200 N1 external-CLI admission gate (`ec1cea36`); 2026-09-19 batch — #201 reserved agent-message grants, #202 Pi fork pin 1006 / S2 clipboard tripwire, #203 WP5 S2 CI flip (strict bun + real-chain monitor control), #204 #196 durable recurring smoke (embedded roundtrip + crash window), #205 docs authority navigation (#197), #206 WinSW uninstall image-lock retry, #207 Windows link-first cleanup + out-of-tree canary |
| Open candidates | Unmerged | #191 (draft: MCP launch-cwd boundary); Salesko draft PR #241 — both still open drafts on 2026-09-25. #233 (official Pi migration) and #234 (0.22.0 preparation) are merged |
| Published packages | 0.23.0 / keys 0.8.0 published | SDK 0.23.0 and keys 0.8.0 were published to npm on 2026-09-28 from the `v0.23.0` tag target (`bcf65a3f`, the PR #237 merge) and were read back as the registry's `latest` on that date; verify current tags with `npm view @byok-sdk/core version` / `npm view @byok-sdk/keys version`, receipt in the [0.23.0 publication record](docs/releases/v0.23.0-publication.md), notes in [0.23.0](docs/releases/v0.23.0.md). The annotated `v0.23.0` tag is on origin at `bcf65a3f`. The published set is nine packages: `@byok-sdk/core`, `implementation-identity`, `protocol`, `client`, `cloud`, `cloud-dataplane`, `server` and `ui-runtime` at 0.23.0, plus `@byok-sdk/keys` at 0.8.0; `byok-sdk` and `@byok-sdk/testkit` are no longer published. The previous train is 0.22.0 / keys 0.7.0 (2026-09-25, `0962f14f`, [publication record](docs/releases/v0.22.0-publication.md)), before it 0.21.0 / keys 0.6.2 (2026-09-24/25, `8b7a2121`, [publication record](docs/releases/v0.21.0-publication.md)). 0.23.0 and 0.22.0 pin the unmodified official Pi 0.87.1 closure; the historical 0.21.0 train pinned Pi fork 0.86.1001 |
| Real Host integration | In progress, not accepted | Salesko Sprint ledger: K5 in progress, K7 incomplete; A01–A29 at 24 LOCAL_PASS / 5 BLOCKED at the latest recorded checkpoint. Host-side subjects and evidence live in that ledger, not here |
| Native / production acceptance | 未验收 | Target-runtime S9 not executed; aiphabee (K6) paused by owner decision; no production migration, deployment, or paid-runtime acceptance |

Frozen decisions — do not re-ask: capacity `maxUnsettledTurnsPerConversation = 8`;
settled no-reply Turns stay in history with truthful outcome metadata and no
renewed execution authority; internal Summary runs as a same-home strict fresh
result-document task before the dependent user Execution; a message becomes
`accepted` only AFTER the Host atomically commits body, exact message identity
and verdict in one transaction — the early draft's
`accepted → host appends body` arrow is a simplified sketch and must not be
used as implementation guidance.

Still open, tracked separately (not "pending freeze"): first-request token
accounting and the enablement gate (#194), Host ContextPack → same-home
Summary → fresh reply integration acceptance (#195), budget/disclosure/
quality/storage inputs (PRD §9.3–§9.5), and native runtime acceptance (S9).
#196 closed via #204; #180/#201 merged 2026-09-19.

Reading reused evidence: a historical run counts only for its original
subject, verified by SHA before reuse. For example, the SDK artifact
checkpoint `38e238049977…` reports 4004 PASS / 135 SKIP — the SKIP lanes lack
the canonical Postgres/S3 substrate and are never counted green, and the C07
detection gate 7/7 @ `d4dcf961` covers that sub-slice only. Expected
tripwires, SKIP, and BLOCKED rows are never counted as passing, and a PR
sub-slice PASS never closes the full MVP (K7).

## Downstream issues and requests

Found a bug, missing SDK capability, or documentation gap during integration?
Submit a [downstream integration issue](https://github.com/Ancienttwo/byok-sdk/issues/new?template=downstream-integration.yml).
Include exact SDK versions, a minimal reproduction or use case, downstream
impact, and acceptance criteria. See the [submission guide](docs/upstream-requests.md)
for browser/CLI submission and follow-up expectations.

## Key management is separate

`@byok-sdk/keys` stores provider credentials and makes direct provider calls.
It is intentionally outside the dispatch packages and their entire dependency
graph. Install it explicitly when that security model is required:

```sh
npm install @byok-sdk/keys@0.10.0-rc.1
```

## Host connector composition

[`examples/salesko-connector-broker`](examples/salesko-connector-broker) is a
private reference composition for a Salesko-style local connector. It combines
device-local OS credential custody, exact correspondent-domain policy, a
real desktop Google OAuth + read-only Gmail metadata adapter, and a
metadata-only stdio MCP projection with the daemon's logical toolset injection.
It is integration guidance, not a published connector catalogue; Google
verification/assessment, LinkedIn, social-media, and browser connectors are not
included.

## Runtime and license

The dispatch SDK and the independently installable `@byok-sdk/keys@0.10.0-rc.1`
require Node.js 24.15.0 or newer. MIT licensed.
