# Architecture Index

> Umbrella architecture ledger for current boundaries, drift requests, snapshots, and diagrams.

## Decision Records

- 领域模型与权威边界 ADR-026 – ADR-034（2026-09-03）：[`adr-2026-09-03-domain-model-and-authority.md`](adr-2026-09-03-domain-model-and-authority.md)；帐本行见 `sdk-architecture.md` 附录 A
- 云端 Generic Agent ADR-036（2026-10-03）：[`adr-2026-10-03-cloud-generic-agent.md`](adr-2026-10-03-cloud-generic-agent.md)；研究稿 [`../researches/2026-10-03_pi-harness-cf-gap-and-cloud-generic-agent.md`](../researches/2026-10-03_pi-harness-cf-gap-and-cloud-generic-agent.md)
- 最小 guardrail ADR-037（2026-10-07）：[`adr-2026-10-07-minimal-guardrails.md`](adr-2026-10-07-minimal-guardrails.md)；取代 `sdk-architecture.md` §9.2、ADR-011 与 ADR-015

## Current Snapshot

- Latest snapshot: `snapshots/20260816-0420-cloud-dataplane-runtime-subpath.md`
- Semantic diagram source: (none yet)
- Latest human diagram: (none yet)

## Pending Requests

<!-- BEGIN ARCHITECTURE PENDING REQUESTS -->
- (none)
<!-- END ARCHITECTURE PENDING REQUESTS -->

<!-- BEGIN ARCHCONTEXT:generated target="projection_target.architecture.index" sourceDigest="sha256:2cd62242ce412b870563ddf9b283ff287abf32f92a3b1aa065a78c4a289da691" rendererVersion="archcontext.docs-renderer/v4" outputDigest="sha256:09e39b870a5e7002a47e18f7c415fc08c29d631fb932dff054fe40b56fae9ef1" -->
# Architecture Index

Generated: 1970-01-01T00:00:00.000Z

## Entities

- [SDK Root](modules/sdk/sdk-root.md) — capability / active

## Relations

- module.sdk.task-runner -> component.sdk.offer-validation — calls
- module.sdk.task-runner -> module.sdk.runtime-start — calls

## Projections

- [Mermaid](diagrams/architecture.mmd)
- [Structurizr JSON](diagrams/architecture.structurizr.json)
- [LikeC4](diagrams/architecture.likec4)
- [Decision index](decisions/index.md)
- [Architecture changelog](changelog.md)
<!-- END ARCHCONTEXT:generated target="projection_target.architecture.index" -->
