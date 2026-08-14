# Architecture Queue Card: root

> **Status**: Pending
> **Detected**: 2026-08-05T17:31:51+0800
> **Updated**: 2026-08-15T01:43:36+0800
> **Severity**: medium
> **Change Type**: boundary-or-config
> **File**: `packages/client/package.json`
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
> **Open Edits**: 6

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

| Last Event | Severity | Change Type | File |
| --- | --- | --- | --- |
| 2026-08-15T01:43:36+0800 | medium | boundary-or-config | `packages/client/package.json` |
| 2026-08-13T23:42:07+0800 | medium | boundary-or-config | `packages/cloud-postgres/package.json` |
| 2026-08-07T14:02:03+0800 | medium | boundary-or-config | `packages/keys/package.json` |
| 2026-08-07T14:01:52+0800 | medium | boundary-or-config | `packages/server/package.json` |
| 2026-08-07T14:01:48+0800 | medium | boundary-or-config | `packages/protocol/package.json` |
| 2026-08-05T17:38:39+0800 | medium | boundary-or-config | `packages/keys/tsconfig.json` |

## Event Fields

```json
{
  "ts": "2026-08-15T01:43:36+0800",
  "file_path": "packages/client/package.json",
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
  "contract_sync_required": false
}
```
