# BYOK SDK

BYOK SDK lets a SaaS product dispatch work to coding-agent runtimes already
authenticated on an end user's machine. It includes a local daemon, a
self-hosted server façade over the cloud kernel, and a hosted multi-tenant
composition over Postgres and R2.

## Release status

The current stable release is **0.31.0** for all nine packages, published on
2026-10-29 (UTC). From 0.28.2, keys uses the release train version instead of
its own version line. See the [release notes](docs/releases/v0.31.0.md) and
[release process](docs/releases/README.md). It moves the wire to v4. A Host
that moves to 0.31.0 from 0.30.2 follows the
[Host upgrade checklist](docs/releases/host-upgrade-0.31.0.md). The notes do
not say that 0.31.0, or a Host on it, is ready for production.

The previous stable release is **0.30.2** for all nine packages. See the
[release notes](docs/releases/v0.30.2.md). A Host that moves to 0.30.2 from
0.29.x, 0.30.0 or 0.30.1 follows the
[Host upgrade checklist](docs/releases/host-upgrade-0.30.2.md). The release
notes do not say that 0.30.2, or a Host on it, is ready for production; the
product loop gate (#977) is evaluated after release.

The 0.31.0 registry readback passed for all nine packages with `latest`
**0.31.0**. The registry lists 0.30.2 (2026-10-26, UTC), 0.30.1 and 0.30.0
(2026-10-24, UTC), 0.29.0 (2026-10-23, UTC), 0.28.3 and 0.28.2 (2026-10-22, UTC),
0.28.1 / keys 0.13.1 (2026-10-21, UTC) and 0.28.0 / keys 0.13.0 (2026-10-20,
UTC) as the earlier published versions. This read confirms registry
availability, not isolated-install qualification.

Historically, all nine **0.27.0** / keys **0.12.0** packages were published from
`v0.27.0` (`cd977261`), and complete registry readback and isolated installation
passed. See the [publication record](docs/releases/v0.27.0-publication.md).
The owner directed publication while #195 remained open. This does not
establish Host acceptance or production rollout.

0.27.0 was the first stable wire-v3 train. A v2 daemon and a v3 server do not
interoperate. Devices and the Host must upgrade together. The train also
changes server, cloud, client and keys APIs.
[Release notes](docs/releases/v0.27.0.md) describe the changes since 0.26.1
and the Host upgrade and migration steps.

Versioned install examples below name the current stable release, 0.31.0.
The historical `rc` publication is **0.27.0-rc.2** / keys **0.12.0-rc.2**; see its
[publication record](docs/releases/v0.27.0-rc.2-publication.md).

An earlier `latest` release was **0.26.1** for the eight aligned packages,
with independent keys **0.11.1**, published on npm on 2026-10-12 from
`v0.26.1` (`e7f3edf2`, PR #381). The
[publication record](docs/releases/v0.26.1-publication.md) confirms all nine
packages, exact CI artifact hashes, registry readback and an isolated install.
[Release notes](docs/releases/v0.26.1.md) cover the client corrections since
0.26.0. This PATCH release adds no public API or schema migration.

The earlier `latest` release was **0.26.0** for the eight aligned packages,
with independent keys **0.11.0**, published on npm `latest` on 2026-10-11 from
`v0.26.0` (`34c0e504`, PR #350). The
[publication record](docs/releases/v0.26.0-publication.md) verifies the frozen
artifact identity and registry readback. The public set is nine packages; `@byok-sdk/implementation-identity`
stays retired. The owner chose stable before the end-to-end run that the rc
route named. 0.26.0 also adds three client changes that no RC carried: the
`models.json` `apiKey` probe for pi `authPresent` (#345), OAR 0.54.3 (#348)
and the non-retryable Codex resume of a missing thread (#349).
[Release notes](docs/releases/v0.26.0.md) describe the additions since 0.25.0,
the client and keys breaking cuts and the upgrade steps.

The earlier published **0.26.0-rc.4** / keys 0.11.0-rc.4 (see its
[publication record](docs/releases/v0.26.0-rc.4-publication.md)) is superseded
on the `rc` channel by 0.27.0-rc.2. rc.3 is also superseded. 0.26.0-rc.1 and rc.2 were only partially published and are also superseded.
Live Host acceptance remains separate.

Before it, `latest` was **0.25.0** for eight aligned packages, with
independent keys **0.10.0**, published on npm `latest` on 2026-10-09 from
`v0.25.0` (`3278b834`, PR #320). The
[publication record](docs/releases/v0.25.0-publication.md) verifies accepted
CI bytes, registry integrities, dependency edges and a clean npm install.
[Stable release notes](docs/releases/v0.25.0-stable.md) cover the release and
upgrade steps. The earlier 0.25.0-rc.2 is superseded on the `rc` channel; its [notes](docs/releases/v0.25.0-rc.2.md) and the
[rc.1 breaking-change record](docs/releases/v0.25.0.md) remain historical evidence.

Before 0.25.0, `latest` was **0.24.0**, with independent keys **0.9.0**.
npm shows all ten 0.24.0 / keys 0.9.0 packages published on 2026-10-06; their
registry integrities equal the push CI `release-pack` artifact of `756eb921`.
The repository has no `v0.24.0` tag and no publication record for it. The
[0.24 release notes](docs/releases/v0.24.0.md) describe its Node, adapter,
identity and SQLite changes and the Host upgrade/rollback steps from 0.23.

The previous publication with a record here is **0.23.0**, with independent keys
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
the current source pins 1.4.0; 1.3.0 ships in stable 0.28.x, 0.29.0 and 0.30.0; 1.2.0 ships in stable 0.27.0 and its published RCs; 1.1.0 ships in stable 0.25.0, 0.26.x and their published RCs.
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

## Install sets

Install the scoped packages your composition uses and import each one under
its own name. Pick one of the three sets below. Each set lists its direct
packages; npm installs the rest of the `@byok-sdk` graph through runtime
dependencies. `scripts/release/install-matrix.test.mjs` checks each set's
versions and its "Also installed" list against the package manifests. It
checks the Worker set against the Worker consumer that the
`check:release-pack` smoke installs. The Self-hosted and Hosted sets are
fixed by the #535 ruling.

<!-- BEGIN install-matrix -->

### Self-hosted

Use it for a self-hosted deployment, such as Aiphabee: `server` is the
Hono/HTTP façade over the shared `cloud` kernel, `client` is the local
daemon, and `keys` keeps provider credentials on the device.

```sh
npm install @byok-sdk/client@0.31.0 @byok-sdk/server@0.31.0 @byok-sdk/keys@0.31.0
```

Also installed: `@byok-sdk/cloud`, `@byok-sdk/core`, `@byok-sdk/protocol`.

```ts
import { createByokServer } from '@byok-sdk/server';
```

### Hosted / Cloudflare

Use it for a hosted service: `cloud` for the device routes, `cloud-dataplane`
for the Postgres + R2 data plane (`@byok-sdk/cloud-dataplane/runtime` on
Workers through Hyperdrive), `cloud-do` for Agent sessions in Cloudflare
Durable Objects, and `ui-runtime` for the Live Activity Timeline. On a
Node/VPS host without Durable Objects, leave out `@byok-sdk/cloud-do`.

```sh
npm install @byok-sdk/cloud@0.31.0 @byok-sdk/cloud-dataplane@0.31.0 @byok-sdk/cloud-do@0.31.0 @byok-sdk/ui-runtime@0.31.0
```

Also installed: `@byok-sdk/core`, `@byok-sdk/protocol`.

### Worker

Use it for a Cloudflare Worker that only hosts Agent sessions in Durable
Objects (no `nodejs_compat`): `cloud-do` for the session runtime and
`protocol` for the shared outcome validator. See
[the cloud-do README](packages/cloud-do/README.md) for the subclass and binding.

```sh
npm install @byok-sdk/cloud-do@0.31.0 @byok-sdk/protocol@0.31.0
npm install --save-dev @cloudflare/workers-types
```

Also installed: none.

<!-- END install-matrix -->

The public dispatch packages are `@byok-sdk/client`, `@byok-sdk/server`,
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

The SDK meters no execution. Storage above the tenant storage entitlement is
the paid unit. The hosted profile is optimized for VPS deployment (Node,
Postgres and S3-compatible object storage) and stays supported on Cloudflare
Workers. See
[ADR-038](docs/architecture/adr-2026-10-13-bot-platform.md).
The planned work for Bot routines, Bot collaboration, storage accounting and
idle cost is in the
[Bot platform PRD](docs/researches/2026-10-13_bot-platform-prd.md). It
includes three breaking cuts. The first has landed: fresh Agent submission
uses `executions.submit` with a Host-persisted `AgentExecutionInput`, and
`messageEgress` is optional. The planned cuts give home-busy declines a typed
`code` and replace the device-side result-document extractor with the reserved
`submit_result` tool. That last cut moves the wire to protocol v3 with no v2
reader, so servers and daemons drain first and upgrade together.

## Agent-first local homes and egress

The additive Agent execution path treats a task as one run of a durable Agent.
The host supplies an absolute branded `hostStorageRoot` plus an exact
`AgentRef`; the SDK alone composes `<hostStorageRoot>/agents/<agentId>`,
initializes and preserves `MEMORY.md`/`notes/`, enforces one writer, and seals
that canonical home as the Pi/Claude/Codex cwd. An Agent dispatch requires the
target daemon's durable `agent-home-contract` capability. Since wire v4 the
Agent home is the only task cwd.

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

For fresh user, routine and Bot work, see the [Host execution core guide](docs/host-execution-core.md)
and its [copy-and-own reference](examples/host-execution-core/README.md).
For single Bot actions, see the [Bot collaboration reference](examples/bot-collaboration/README.md).
It supports self continuations. 跨 Bot 委派推迟到 K8b（#530 和 #531 合入后的第一张 K8b 工单）。

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
| SDK product truth | [`docs/spec.md`](docs/spec.md) — [Durable Agent homes](docs/spec.md#durable-agent-homes), [Fresh Agent egress versus exact resume](docs/spec.md#fresh-agent-egress-versus-exact-resume), [Host exact Agent message disposition readback](docs/spec.md#host-exact-agent-message-disposition-readback), [Fresh Agent execution Host composition requirements](docs/spec.md#fresh-agent-execution-host-composition-requirements) |
| Host composition requirements (approved) | [Conversation-turn Fresh MVP PRD](docs/researches/2026-09-09_conversation-turn-fresh-mvp-prd.md) and the [Host Reliability Addendum](docs/researches/2026-09-09_conversation-turn-mode-host-reliability-addendum.md) |
| Design history | [Original design draft](docs/researches/2026-09-09_conversation-turn-mode-design.md) — historical draft; its open questions, hybrid/resume outlook, and simplified completion bridge are superseded (see the qualifier at its top) |
| Sole acceptance ledger | [Salesko Host reliability Sprint plan](https://github.com/Ancienttwo/salesko-new/blob/codex/recurring-sdk-adoption-test/plans/plan-20260909-private-agent-chat-host-reliability-sprints.md) (external repo, draft branch), with the internal SDK-first plan (`plans/plan-20260910-conversation-turn-sdk-first.md`, not tracked in this repository) as the stage entry |
| Active PRs | byok-sdk: none (#191 was closed without merging); Salesko integration: draft PR #241 (external, not re-checked here) |

Historical adoption checkpoints below are bound to their recorded source SHA,
artifact or CI evidence; they are not a live main/PR/registry status report. See
the release status above for the current stable release. 未验收 means not
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
npm install @byok-sdk/keys@0.31.0
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

The dispatch SDK and the independently installable `@byok-sdk/keys@0.31.0`
require Node.js 24.22.1 or newer. MIT licensed.

## Entry dependencies

`api-surface/entries.json` is the manual policy and generated-fact authority for
all published exports, bins and private imports. `bun run check:api-surface`
checks coverage, policies, measured workspace bytes, facts and this table.
`--update` rewrites facts and the table only; policies must pass first.
`--package` retains the declaration-only golden view.

The budget counts workspace static JavaScript closures, not third-party bytes,
sourcemaps or literal lazy edges. `nodeBuiltins` separately controls workspace
and third-party edges. The Worker dataplane forbids first-party Node-only code
while reporting pg's existing Node compatibility requirements. Literal CJS
requires in getters/functions stay lazy; top-level, guarded, static-block and
IIFE calls are traversed. UMD factories passed as arguments are not inferred as
immediate. Computed imports, unresolved third-party references and absent
optional packages remain explicit facts; strict safety policies reject
unexamined sources. This report is a dependency tripwire, not a sandbox proof.

<!-- BEGIN generated: api-surface/entries.json -->

Workspace static closure budgets exclude third-party bytes, sourcemaps and literal lazy imports.
Third-party dependencies and code-generation evidence follow static dependency edges; these are build facts, not a CSP sandbox guarantee.

| Import / command | Purpose | Third-party dependencies | Zod | Budget |
| --- | --- | --- | --- | ---: |
| `@byok-sdk/client` | Local daemon composition | `@cfworker/json-schema`, `@modelcontextprotocol/client`, `@modelcontextprotocol/core`, `eventsource`, `eventsource-parser`, `pkce-challenge`, `zod` | allowed | 1806463 B |
| `@byok-sdk/client/adapters` | Runtime adapters; private hosts load lazily | — | forbidden | 337661 B |
| `@byok-sdk/client/agent-memory` | Embedded Agent memory service | — | forbidden | 62414 B |
| `@byok-sdk/client/assertion-client` | Task/device assertions; core includes protected Zod probes | `zod` | allowed | 121378 B |
| `@byok-sdk/client/mcp-server` | Tools-only MCP server | — | forbidden | 13135 B |
| `@byok-sdk/client/mcp-server/http` | Tools-only MCP Streamable HTTP framing | — | forbidden | 28384 B |
| `@byok-sdk/client/package.json` | Package metadata | — | forbidden | 4943 B |
| `@byok-sdk/client/testing` | Runtime adapter test doubles; no daemon | — | forbidden | 323116 B |
| `@byok-sdk/client#byok-acp-runtime` | Private ACP runtime stack (Grok) | `@agentclientprotocol/sdk`, `zod` | allowed | 75757 B |
| `@byok-sdk/client#byok-hermes-session` | Private Hermes session runtime; loaded only when starting an execution | — | forbidden | 14606 B |
| `@byok-sdk/client#byok-pi-runtime-host` | Private Pi runtime host | `@cfworker/json-schema`, `@earendil-works/chord`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-codemode`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-durable`, `@earendil-works/pi-mcp`, `@earendil-works/pi-telemetry`, `@earendil-works/pi-tui`, `@modelcontextprotocol/client`, `@modelcontextprotocol/core`, `balanced-match`, `brace-expansion`, `chalk`, `cross-spawn`, `diff`, `eventsource`, `eventsource-parser`, `get-east-asian-width`, `graceful-fs`, `grok-mermaid`, `highlight.js`, `hosted-git-info`, `ignore`, `isexe`, `lru-cache`, `marked`, `marked-cjk-friendly`, `minimatch`, `openai`, `p-limit`, `partial-json`, `path-key`, `pi-web-access`, `pkce-challenge`, `proper-lockfile`, `retry`, `semver`, `shebang-command`, `shebang-regex`, `signal-exit`, `typebox`, `undici`, `which`, `yaml`, `yocto-queue`, `zod` | allowed | 4176933 B |
| `@byok-sdk/client#byok-pi-runtime-host-sealed` | Private sealed Pi runtime host | `@cfworker/json-schema`, `@earendil-works/chord`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-codemode`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-durable`, `@earendil-works/pi-mcp`, `@earendil-works/pi-telemetry`, `@earendil-works/pi-tui`, `@modelcontextprotocol/client`, `@modelcontextprotocol/core`, `balanced-match`, `brace-expansion`, `chalk`, `cross-spawn`, `diff`, `eventsource`, `eventsource-parser`, `get-east-asian-width`, `graceful-fs`, `grok-mermaid`, `highlight.js`, `hosted-git-info`, `ignore`, `isexe`, `lru-cache`, `marked`, `marked-cjk-friendly`, `minimatch`, `openai`, `p-limit`, `partial-json`, `path-key`, `pi-web-access`, `pkce-challenge`, `proper-lockfile`, `retry`, `semver`, `shebang-command`, `shebang-regex`, `signal-exit`, `typebox`, `undici`, `which`, `yaml`, `yocto-queue`, `zod` | allowed | 4133064 B |
| `@byok-sdk/client#byok-pi-todo-runtime` | Private pure todo runtime | — | forbidden | 398402 B |
| `@byok-sdk/cloud` | Cloud coordination and HTTP handlers | `@cfworker/json-schema`, `hono`, `zod` | allowed | 496442 B |
| `@byok-sdk/cloud-dataplane` | Postgres stores and Node operations | `@cfworker/json-schema`, `@nodable/entities`, `anynum`, `aws4fetch`, `fast-xml-builder`, `fast-xml-parser`, `hono`, `is-unsafe`, `path-expression-matcher`, `pg`, `pg-connection-string`, `pg-int8`, `pg-pool`, `pg-protocol`, `pg-types`, `postgres-array`, `postgres-bytea`, `postgres-date`, `postgres-interval`, `strnum`, `xml-naming`, `xtend`, `zod` | allowed | 721521 B |
| `@byok-sdk/cloud-dataplane/package.json` | Package metadata | — | forbidden | 1794 B |
| `@byok-sdk/cloud-dataplane/runtime` | Worker online stores; pg requires nodejs_compat | `@cfworker/json-schema`, `@nodable/entities`, `anynum`, `aws4fetch`, `fast-xml-builder`, `fast-xml-parser`, `hono`, `is-unsafe`, `path-expression-matcher`, `pg`, `pg-connection-string`, `pg-int8`, `pg-pool`, `pg-protocol`, `pg-types`, `postgres-array`, `postgres-bytea`, `postgres-date`, `postgres-interval`, `strnum`, `xml-naming`, `xtend`, `zod` | allowed | 685996 B |
| `@byok-sdk/cloud-do` | Durable Object session runtime | `@earendil-works/chord`, `@earendil-works/pi-ai`, `@earendil-works/pi-durable`, `@earendil-works/pi-telemetry`, `typebox` | forbidden | 140140 B |
| `@byok-sdk/cloud-do/package.json` | Package metadata | — | forbidden | 1631 B |
| `@byok-sdk/cloud/package.json` | Package metadata | — | forbidden | 1272 B |
| `@byok-sdk/core` | Shared contracts and validation | `zod` | allowed | 101449 B |
| `@byok-sdk/core/package.json` | Package metadata | — | forbidden | 1403 B |
| `@byok-sdk/core/sealed-payload` | Sealed payload v1 byte rules | `zod` | allowed | 161625 B |
| `@byok-sdk/keys` | Local provider credential custody | `zod` | allowed | 235002 B |
| `@byok-sdk/keys/model-route` | Headless Pi model route: choices, linkage, field errors and submission | `zod` | allowed | 309769 B |
| `@byok-sdk/keys/package.json` | Package metadata | — | forbidden | 1553 B |
| `@byok-sdk/keys/pi-catalog` | Pinned pi-ai catalog lookup for pi_model | `zod` | allowed | 282849 B |
| `@byok-sdk/protocol` | Wire schemas and codecs; codegen negative control | `@cfworker/json-schema`, `zod` | allowed | 123545 B |
| `@byok-sdk/protocol/constants` | Schema-free protocol values | — | forbidden | 4946 B |
| `@byok-sdk/protocol/package.json` | Package metadata | — | forbidden | 1417 B |
| `@byok-sdk/server` | Resident Node server | `@cfworker/json-schema`, `@hono/node-server`, `hono`, `zod` | allowed | 632348 B |
| `@byok-sdk/server/package.json` | Package metadata | — | forbidden | 1455 B |
| `@byok-sdk/ui-runtime` | UI folds; current cloud/Hono/Zod closure | `@cfworker/json-schema`, `hono`, `zod` | allowed | 519896 B |
| `@byok-sdk/ui-runtime/package.json` | Package metadata | — | forbidden | 1215 B |
| `bin:byok-agent` | Device daemon CLI | `@cfworker/json-schema`, `@modelcontextprotocol/client`, `@modelcontextprotocol/core`, `eventsource`, `eventsource-parser`, `pkce-challenge`, `zod` | allowed | 1751214 B |
| `bin:byok-agent-memory-mcp` | Agent memory MCP helper | — | forbidden | 41586 B |
| `bin:byok-agent-message-mcp` | Agent message MCP helper | — | forbidden | 41590 B |
| `bin:byok-agent-result-mcp` | Task-bound structured outcome MCP helper | — | forbidden | 41586 B |
| `bin:byok-agent-team-mcp` | Agent team MCP helper | — | forbidden | 41578 B |
| `bin:byok-pi-durable` | Pi durable launcher; host loads lazily | — | forbidden | 405 B |
| `bin:byok-pi-prepared` | Pi prepared launcher; host loads lazily | — | forbidden | 470 B |
| `bin:byok-pi-provider-launcher` | Provider credential custody launcher | `zod` | allowed | 177052 B |
| `bin:byok-pi-rpc` | Pi RPC launcher; host loads lazily | — | forbidden | 450 B |

<!-- END generated: api-surface/entries.json -->
