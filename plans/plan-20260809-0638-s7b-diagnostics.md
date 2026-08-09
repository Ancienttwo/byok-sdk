# Plan: S7-b Diagnostics and Operations

> **Status**: Executing
> **Created**: 20260809-0638
> **Slug**: s7b-diagnostics
> **Artifact Level**: work-package
> **Promotion Reason**: S7 RC 需要把 S7-a health authority、SQLite/quarantine evidence、runtime probe 与 control socket 汇成可执行的 operator contract；diagnostics 的 redaction 与显式修复边界必须独立审查，不能等到 package publish 才发现会泄密或删证据。
> **Verification Boundary**: doctor/report-only、`doctor --fix --yes` quarantine、support-bundle redaction/bounds、hosted/self-hosted runbooks、load/retention drills、client/full workspace gates、protocol/schema/migration/package identity zero diff。
> **Rollback Surface**: revert client diagnostics/CLI、daemon ownership lease and docs；不改变 wire、database migration、package identity 或 quarantine auto-cleanup policy。
> **Spec**: `docs/spec.md`
> **Research**: `docs/architecture/sdk-architecture.md` §14.3.3、§15.3；sprint S7.3/S7.4
> **Task Contract**: `tasks/contracts/20260809-0638-s7b-diagnostics.contract.md`
> **Task Review**: `tasks/reviews/20260809-0638-s7b-diagnostics.review.md`
> **Implementation Notes**: `tasks/notes/20260809-0638-s7b-diagnostics.notes.md`

## Agentic Routing

- Selected route: main-thread code-change；Claude review 暂停，不调用。
- Routing reason: 本刀涉及 local evidence preservation 与 support-bundle privacy；以 independent Codex exact-SHA review 验收。
- Due diligence:
  - P1 map: operator 入口是 `packages/client/src/bin/byok-agent.ts`；live truth 经 authenticated control socket，persisted truth 来自 `device.json`、redacted `audit.jsonl`、`operational-health.json`、`daemon.db` 与 `quarantine/`。runtime probe 已由 `bin/runtime-probe.ts` 单一实现；journal corruption 已有 `JournalCorruptError` 与 timestamped quarantine，但 health corruption 只投影 unavailable。
  - P2 trace: config → storeDir → read-only doctor collectors（config/runtime/control/files/health/quarantine）→ plain/JSON report；SQLite 从 bounded pathname-bound open handles 复制 temp snapshot；`support-bundle` 只消费同一 typed diagnostics snapshot + closed bounded audit projection并 atomic write；pair/start/auth shutdown/unpair 与 `doctor --fix --yes` 争用同一 ownership lease，daemon lifecycle queue 覆盖 pair/start/stop/control shutdown/unpair 的完整调用，pair/renew 再经同一进程内 credential mutation queue；fix 对 ≤1 MiB 的 confirmed-corrupt open inode 在 cwd-pinned quarantine directory inode 内同步复核 source state、复制 bytes 到独立 evidence inode并以该 copy 计算 digest，先发布 evidence/manifest、最后 source-unlink，绝不删除 quarantine evidence；read-only quarantine inventory 同样 pin directory、path-bind bounded manifest/evidence，并验证 health digest 或 journal manifest binding。
  - P3 decision rationale: doctor 与 bundle 共用一个 typed collector，避免两套诊断真相；fix 是窄而显式的 evidence-preserving operation，不修数据库、不重建 state。host updater/signing 继续留在 host，SDK 只写 responsibility/runbook contract。

## Workflow Inventory

- Active plan: `plans/plan-20260809-0638-s7b-diagnostics.md`
- Sprint contract: `tasks/contracts/20260809-0638-s7b-diagnostics.contract.md`
- Sprint review: `tasks/reviews/20260809-0638-s7b-diagnostics.review.md`
- Implementation notes: `tasks/notes/20260809-0638-s7b-diagnostics.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: contract `allowed_paths`。
- Execution isolation: branch/worktree owned by this contract after S7-a closeout lands。

## Approach

1. Add a side-effect-free diagnostics collector with closed check/result shapes for config summary、versions、runtime detection、control reachability、health、journal/store metadata and quarantine inventory。
2. Add `doctor` plain/JSON output. Default and `--json` never mutate. `--fix` refuses without `--yes`; the only initial fix quarantines a confirmed corrupt `operational-health.json` with SHA-256/source/size/reason manifest, never deletes or synthesizes healthy state。
3. Add `support-bundle --output <path>` as one bounded atomic JSON artifact containing diagnostics、bounded recent already-redacted audit facts、hash/size metadata and an explicit redaction manifest；no config secret、token、prompt/tool body or raw local path。
4. Add hosted/self-hosted operations and host-owned updater/signing runbooks；run load/reconnect/retention tests over production collectors and existing S7-a production jitter。

## Detailed Design

### File Changes

| File | Action | Description |
| --- | --- | --- |
| `packages/client/src/diagnostics/**` | Add | typed collector、temp SQLite snapshot、health quarantine fix、support bundle projection |
| `packages/client/src/daemon/daemon-owner.ts` / `create-daemon.ts` | Add/Modify | daemon lifetime vs doctor fix cross-process mutation authority |
| `packages/client/src/bin/commands/{doctor,support-bundle}.ts` | Add | headless CLI commands、JSON/plain output、explicit fix/output flags |
| `packages/client/src/bin/byok-agent.ts` | Modify | register commands without changing existing command semantics |
| `packages/client/src/__tests__/*diagnostic*` | Add | report-only、corruption/quarantine、redaction、bounds、load/retention tests |
| `deploy/runbooks/{hosted-operations,self-hosted-operations,release-responsibility}.md` | Add | production operations and host-owned signing/updater contract |
| architecture/sprint/plan/contract/notes/review | Modify | current/target and acceptance evidence |

### Data Flow

`config + storeDir artifacts + bounded runtime probe + optional live control` → typed diagnostics snapshot（SQLite 仅从 pathname-bound bounded open handles temp-copy quick_check；quarantine manifest/evidence 在 pinned directory 中 bounded/path-bound 验证 binding）→ `doctor` renderer or bounded/closed support-bundle projection → atomic output。`doctor --fix --yes` additionally performs `exclusive daemon-owner lease → pathname-bound bounded health inspection → pin checked quarantine directory inode → copy exact bytes to a separate evidence inode + hash → exclusive digest manifest → revalidate/remove source name`。

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| bundle leaks secrets/prompts/paths | Medium | High | allowlist projection only；redaction manifest；fixture with sentinel secrets must be absent byte-for-byte |
| doctor mutates during report | Medium | High | SQLite source is opened read-only/pathname-bound and copied by bounded positional reads；POSIX adds no-follow/non-blocking and Windows binds pre/post-open identity；temp snapshot source identities are rechecked；fix dependency constructed only for `--fix --yes` |
| fix destroys or misattributes corruption evidence | Low | High | daemon/doctor cross-process owner lease；pathname-bound regular-file/size gate；cwd-pinned checked directory inode；exact bounded copy/digest plus manifest publication and source state revalidation before final unlink；no quarantine delete/rebuild |
| large audit/quarantine makes command unbounded | Medium | Medium | count/byte caps and truncation counters；load test at cap+1 |
| runbook implies SDK updater ownership | Low | High | explicit host-owned signing/channel/updater/rollback boundary |

## Promotion Gate

- **Merge/PR unit**: one S7-b PR containing diagnostics、explicit health quarantine fix、support bundle、runbooks and drills。
- **Rollback surface**: client diagnostics、daemon ownership lease and docs；wire/schema/package identity remain intact。
- **Verification boundary**: targeted privacy/corruption/load tests、client/full workspace gates、strict workflow、frozen surfaces zero diff、cross-platform CI。
- **Review/acceptance boundary**: independent Codex exact-SHA operations/security review；Claude remains paused。
- **High-risk surface**: local evidence mutation and support-bundle redaction。
- **Why not checklist row**: operator repair and export are security/data-loss interfaces with independent falsifiers and rollback。

## Evidence Contract

- **State/progress path**: plan Task Breakdown、contract、notes、review、sprint S7 row。
- **Verification evidence**: sentinel-secret absence、report-only byte identity、quarantine hash/manifest、bundle cap/load matrix、existing fleet simulation、runbook checks、PR CI。
- **Evaluator rubric**: plain doctor never writes；fix without `--yes` fails closed；fix preserves bytes and records matching digest；bundle contains no sentinel secrets/paths/raw bodies and declares every redaction class；large inputs remain bounded。
- **Stop condition**: any default doctor path mutates、any fix deletes/rebuilds state、bundle serializes raw config/audit objects、or change requires protocol/migration/package identity edits。
- **Rollback surface**: revert S7-b files；quarantined evidence remains operator-owned and is never auto-restored/deleted。

## Task Breakdown

- [x] Implement typed read-only diagnostics collector and doctor plain/JSON views。
- [x] Implement explicit health-state quarantine fix with digest-bearing manifest and no deletion。
- [x] Implement bounded/redacted support bundle and sentinel/load/retention tests。
- [x] Add hosted/self-hosted/release-responsibility runbooks and architecture sync。
- [ ] Run hard gates、independent Codex acceptance、PR CI and merge/readback。
