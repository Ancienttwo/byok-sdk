# BYOK SDK

BYOK SDK lets a SaaS product dispatch work to coding-agent runtimes already
authenticated on an end user's machine. It includes a local daemon, a
self-hosted server façade over the cloud kernel, and a hosted multi-tenant
composition over Postgres and R2.

## Release status

This branch prepares **0.18.0**, with independent keys **0.5.0**.
These are unpublished release candidates; use verified local tarballs
until a separately authorized publication. See the [release handoff](docs/releases/v0.18.0-handoff.md). The package install examples
below target that future candidate, not the current npm registry.

The previous stable release is **0.17.0**, with keys **0.4.3**.
See the [release notes](docs/releases/v0.17.0.md) for durable SQLite receipts,
caller task identity/read/cancel and the breaking schema-v3 migration boundary.
Publication, exact-source CI and registry verification are complete. See
[0.17.0 publication record](docs/releases/v0.17.0-publication.md).
The previous verified release is [0.16.0](docs/releases/v0.16.0-publication.md).

The bundled Pi runtime is pinned to the SDK's own fork,
`@byok-sdk/pi-coding-agent@0.85.1006` (upstream base 0.85.1 at `d981de1`),
installed through an npm alias so the import specifier and the installed path
stay `@earendil-works/pi-coding-agent`. Release SemVer is observability only;
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

Install this release with:

```sh
npm install byok-sdk@0.18.0
```

```ts
import { client, cloud, cloudDataplane, core, protocol, server, uiRuntime } from 'byok-sdk';
```

The umbrella uses namespaces so each contract keeps its package owner. The
same modules are also directly installable as `@byok-sdk/client`,
`@byok-sdk/server`, `@byok-sdk/cloud`, `@byok-sdk/cloud-dataplane`,
`@byok-sdk/core`, `@byok-sdk/protocol`, and `@byok-sdk/ui-runtime`.

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

Both profiles share the frozen v1 protocol, tenant isolation, durable device
proof, truth CAS, explicit capabilities, and fail-closed policy handling.

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
Metadata/status activity is the safe default; contentful trajectory is an
explicit capability-gated opt-in. Reliable evidence is fsynced under the
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

Status rows, each bound to a source SHA, artifact, or CI evidence; 未验收
means not accepted, and no overall percentage is defined:

| Dimension | Status | Bound to |
|---|---|---|
| main implementation | Merged | `main` @ `26945c8a` (2026-09-19): recurring input, exact message disposition and fresh egress per the spec section above; #193 C07 Pi runtime launch (`d882aef4`), #198 Windows CI elimination (`49ec7477`), #199 custody five-edge enablement (`e0423d84`), #200 N1 external-CLI admission gate (`ec1cea36`); 2026-09-19 batch — #201 reserved agent-message grants, #202 Pi fork pin 1006 / S2 clipboard tripwire, #203 WP5 S2 CI flip (strict bun + real-chain monitor control), #204 #196 durable recurring smoke (embedded roundtrip + crash window), #205 docs authority navigation (#197), #206 WinSW uninstall image-lock retry, #207 Windows link-first cleanup + out-of-tree canary |
| Open candidates | Unmerged | #191 (draft: MCP launch-cwd boundary); Salesko draft PR #241 |
| Published packages | 0.17.0 stable published | [0.17.0 publication record](docs/releases/v0.17.0-publication.md) (SDK 0.17.0, keys 0.4.3); 0.18.0 / keys 0.5.0 remain unpublished release candidates ([handoff](docs/releases/v0.18.0-handoff.md)); Pi fork pin `@byok-sdk/pi-coding-agent@0.85.1006` in `packages/client/package.json` (pi-ai / agent-core remain at 0.85.1005 in that partial release) |
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
It is intentionally outside `byok-sdk` and the entire dispatch dependency
graph. Install it explicitly when that security model is required:

```sh
npm install @byok-sdk/keys@0.5.0
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

The dispatch SDK and the independently installable `@byok-sdk/keys@0.5.0`
require Node.js 22.22.0 or newer. MIT licensed.
