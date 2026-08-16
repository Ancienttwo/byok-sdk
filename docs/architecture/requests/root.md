# Architecture Queue Card: root

> **Status**: Resolved
> **Detected**: 2026-08-15T15:36:38+0800
> **Updated**: 2026-08-16T04:14:42+0800
> **Severity**: medium
> **Change Type**: boundary-or-config
> **File**: `package.json`
> **Functional Block**: `root`
> **Capability ID**: `root`
> **Matched Prefix**: `root`
> **Architecture Domain**: `root`
> **Architecture Capability**: `_root`
> **Architecture Module**: `docs/architecture/index.md`
> **Workstream Directory**: `tasks/workstreams/root/_root`
> **Contract Files**: `none`, `none`
> **Contract Sync Required**: false
> **Spawn Recommended**: false
> **Open Edits**: 1

## Adjudication (2026-08-16)

- **Drift**: two events, one substance. Both are root `package.json` `boundary-or-config` touches from the v0.4.1 release-archive window and its 2026-08-16 04:14 content-identical re-fire (same event key `sha256:34e78abd…`): nothing committed (`git show 7b6ed4d -- package.json` is empty) and the root manifest is byte-identical to HEAD — transient archive bookkeeping, twice.
- **Ruling**: no architecture change from the card's own events; closed by adjudication. The substantial packaging-boundary change that landed uncommitted while the card was pending — `@byok-sdk/cloud-dataplane` gaining the `./runtime` Worker-loadable subpath — is a real entrypoint change, recorded in the ruling snapshot below and not re-stated here (the event hook rewrites this card; prose durability lives in snapshots — this regeneration, which wiped the earlier adjudication section, is that mechanism working as documented).
- **Status value**: `Resolved` is the canonical closed status; the queue drains any card whose status is not literally `Pending`.
- **Ruling snapshot**: `docs/architecture/snapshots/20260816-0420-cloud-dataplane-runtime-subpath.md`.
- **Slice**: executed under the lite workflow profile (no plan/contract artifacts by design); three `fast-worker` dispatches; combined-tree acceptance rides the 0.4.2 release gate.

### Required Follow-up Disposition

| Follow-up item | Disposition |
| --- | --- |
| Read root `AGENTS.md` / `CLAUDE.md` | done — root context loaded at session start |
| Read local block context if not `root` | not applicable — functional block is `root` |
| Decide whether the change affects boundaries/entrypoints/dependency rules/runtime paths/verification commands | done — it does; the `./runtime` entrypoint change and its build-time neutral-platform gate are recorded in the snapshot |
| Write a snapshot under `docs/architecture/snapshots/` | done — `20260816-0420-cloud-dataplane-runtime-subpath.md` |
| Add an evidence-backed Mermaid fenced block when a visual materially improves the explanation | done — the snapshot carries a small entry-graph Mermaid showing the root/runtime split over the shared online modules |
| Mermaid Markdown is the only diagram artifact; no standalone HTML | complied — fenced block in the snapshot only; no external `mermaid` skill needed for authoring |
| Run `workstream-sync ensure` if this starts or advances durable execution | not applicable — this closure is adjudication + documentation, not durable execution |
| Run `context-contract-sync sync-latest` after the snapshot lands | done — run; root scope has no local block contract file to rewrite |

## Required Follow-up

- Read root `AGENTS.md` / `CLAUDE.md`.
- If functional block is not `root`, read its local `AGENTS.md` / `CLAUDE.md`.
- Decide whether this change affects module boundaries, entrypoints, dependency rules, runtime paths, or verification commands.
- For substantial changes, write a snapshot under `docs/architecture/snapshots/`.
- When a visual materially improves the explanation, add an evidence-backed Mermaid fenced block to the architecture module or snapshot Markdown.
- Mermaid Markdown is the only architecture diagram artifact. Do not generate standalone HTML; use the external `mermaid` skill only for authoring and review.
- If this starts or advances durable execution, run `repo-harness run workstream-sync ensure --block "root" --request "docs/architecture/requests/root.md"`.
- After the snapshot or diagram is produced, run `repo-harness run context-contract-sync sync-latest` so the local architecture contract block links to the latest artifacts.

## Touched Files

| Last Event | Severity | Change Type | File | Event Key |
| --- | --- | --- | --- | --- |
| 2026-08-16T04:14:42+0800 | medium | boundary-or-config | `package.json` | `sha256:34e78abdd687424fc2fad5c2930fcb83295968f0a7047b9dc47d60d9bddb9c8d` |

## Event Fields

```json
{
  "ts": "2026-08-16T04:14:42+0800",
  "file_path": "package.json",
  "severity": "medium",
  "functional_block": "root",
  "capability_id": "root",
  "matched_prefix": "root",
  "architecture_domain": "root",
  "architecture_capability": "_root",
  "architecture_module": "docs/architecture/index.md",
  "workstream_dir": "tasks/workstreams/root/_root",
  "contract_agents": "",
  "contract_claude": "",
  "change_type": "boundary-or-config",
  "request_file": "docs/architecture/requests/root.md",
  "spawn_recommended": false,
  "contract_sync_required": false,
  "event_key": "sha256:34e78abdd687424fc2fad5c2930fcb83295968f0a7047b9dc47d60d9bddb9c8d"
}
```

## Event Records

```json
[
  {
    "ts": "2026-08-16T04:14:42+0800",
    "file_path": "package.json",
    "severity": "medium",
    "functional_block": "root",
    "capability_id": "root",
    "matched_prefix": "root",
    "architecture_domain": "root",
    "architecture_capability": "_root",
    "architecture_module": "docs/architecture/index.md",
    "workstream_dir": "tasks/workstreams/root/_root",
    "contract_agents": "",
    "contract_claude": "",
    "change_type": "boundary-or-config",
    "request_file": "docs/architecture/requests/root.md",
    "spawn_recommended": false,
    "contract_sync_required": false,
    "event_key": "sha256:34e78abdd687424fc2fad5c2930fcb83295968f0a7047b9dc47d60d9bddb9c8d"
  }
]
```
