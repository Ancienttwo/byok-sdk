# Plan: S7-a Deterministic Fleet Health

> **Status**: Executing
> **Created**: 20260809-0520
> **Slug**: s7a-fleet-health
> **Artifact Level**: work-package
> **Promotion Reason**: S7 的 reconnect fleet peak 与 crash-budget RC 闸跨越 transport、daemon lifecycle、持久化 read model 与 status contract；它们必须先成为独立可回滚的可靠性 authority，doctor/support bundle 才有可信数据可读。
> **Verification Boundary**: deterministic jitter unit/fleet simulation、WS/long-poll/maintenance retry behavior、health-window/crash-marker recovery、status/control projection、client full suite、workspace hard dataplane gates、protocol/schema/migration zero diff。
> **Rollback Surface**: revert client-only reliability modules/wiring；保留旧 transport/state API，不改 wire、cloud、database migration 或 package identity。
> **Spec**: `docs/spec.md`
> **Research**: `docs/architecture/sdk-architecture.md` §14.3、`docs/researches/raft-architecture-reference.md` §6.4
> **Task Contract**: `tasks/contracts/20260809-0520-s7a-fleet-health.contract.md`
> **Task Review**: `tasks/reviews/20260809-0520-s7a-fleet-health.review.md`
> **Implementation Notes**: `tasks/notes/20260809-0520-s7a-fleet-health.notes.md`

## Agentic Routing

- Selected route: main-thread code-change；Claude review 暂停，不调用。
- Routing reason: reconnect 与 crash marker 都是 fail-closed reliability boundary；以独立 Codex exact-SHA review 验收。
- Due diligence:
  - P1 map: `WsTransport` 目前在 `ws-transport.ts:249-253` 用 `Math.random()` 做唯一 jitter；`LongPollClient`、outbox retry 与 long-poll→WS probe 使用固定 delay/interval。`createDaemon.start()` 在 device row 已加载后构造 `ConnectionManager`，因此 `productId + deviceId` 是稳定 fleet seed。现有 `DaemonStatus.degraded` 只是 transport fallback，control/status 没有独立 operational health 或跨重启 crash evidence。
  - P2 trace: stored device row → `createDaemon.start()` → `ConnectionManager` → WS/long-poll automatic retry；failure/success → local health tracker → atomic health state + run marker → control `status` → CLI persisted/live status。显式 operator retry 走 `connect({auto:false})`，不额外加 jitter。
  - P3 decision rationale: 一个纯 deterministic jitter primitive 按 `reconnect`/`upload`/`maintenance` domain 派生；transport 只消费 delay，不各造算法。一个 local operational health tracker 持 60s sliding window、3 failures degraded、成功恢复态与 unclean-run marker；它不复用 wire presence/connection enum，也不把普通 task domain failure冒充 daemon crash。

## Workflow Inventory

- Active plan: `plans/plan-20260809-0520-s7a-fleet-health.md`
- Sprint contract: `tasks/contracts/20260809-0520-s7a-fleet-health.contract.md`
- Sprint review: `tasks/reviews/20260809-0520-s7a-fleet-health.review.md`
- Implementation notes: `tasks/notes/20260809-0520-s7a-fleet-health.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: contract `allowed_paths`。
- Execution isolation: branch/worktree allocated after the docs-only S6 closeout lands。

## Approach

1. Add a stateless deterministic jitter calculator with stable seed, explicit domain and attempt/cycle input; preserve bounded ±20% reconnect behavior and expose fleet simulation as test-only aggregation over the production function.
2. Thread the same authority through automatic WS reconnect、long-poll failure/stall retry、outbox retry、periodic WS probe and storage maintenance. Explicit operator retry remains immediate.
3. Add an atomic local health state: bounded events, 60s/3-failure default budget, `healthy/degraded/recovering`, previous-run unclean marker and bounded crash history. Corrupt health state is reported as unavailable; it is not silently synthesized or deleted in this slice.
4. Project health into daemon/control/CLI status without changing wire presence or connection state.

## Detailed Design

### File Changes

| File | Action | Description |
| --- | --- | --- |
| `packages/client/src/daemon/deterministic-jitter.ts` | Add | production delay authority with domain separation |
| `packages/client/src/daemon/operational-health.ts` | Add | sliding window、run marker、crash history、atomic persistence |
| `packages/client/src/daemon/{ws-transport,long-poll-transport,connection-manager}.ts` | Modify | consume injected/domain-scoped deterministic delays |
| `packages/client/src/daemon/create-daemon.ts` | Modify | seed from loaded identity、record lifecycle/connection health、project status |
| `packages/client/src/daemon/control-protocol.ts` + CLI status/format | Modify | explicit operational health read model |
| client tests | Add/Modify | exact delays、fleet peak、state transitions、crash restart、redaction-safe status |

### Data Flow

`device.json.deviceId + productId` → domain-separated jitter → automatic retry timers；transport/lifecycle outcome → health window + atomic state/run marker → daemon status/control socket → `byok-agent status`。

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| deterministic seeds synchronize instead of spread | Medium | High | fleet simulation over thousands of device ids asserts bounded bucket peak |
| jitter changes operator-triggered recovery latency | Medium | Medium | only automatic paths consume jitter；manual `auto:false` remains immediate |
| stale run marker records clean shutdown as crash | Medium | High | one ownership point; clean marker committed after shutdown sequence and tested with injected exits |
| health enum leaks into wire/presence semantics | Low | High | separate type/module/status fields; protocol zero-diff gate |
| health state corruption silently resets evidence | Medium | High | typed unavailable result; no delete/rebuild fallback |

## Promotion Gate

- **Merge/PR unit**: one S7-a PR containing jitter + health/crash authority and their status projection。
- **Rollback surface**: client-only revert；existing transport API and wire remain compatible。
- **Verification boundary**: targeted deterministic/fleet/crash tests、client suite、hard-env workspace gates、strict workflow、protocol/schema/migration zero diff。
- **Review/acceptance boundary**: independent Codex exact-SHA reliability/security review；Claude remains paused。
- **High-risk surface**: timer distribution、unclean-exit classification、atomic health persistence、status honesty。
- **Why not checklist row**: reconnect fleet behavior and crash evidence are independent cross-restart contracts with their own falsifiers and rollback。

## Evidence Contract

- **State/progress path**: this plan Task Breakdown、contract、notes、review and sprint S7 row。
- **Verification evidence**: production-function fleet simulation、fake-clock health tests、unclean/clean restart probes、client/full workspace gates、PR CI。
- **Evaluator rubric**: same seed/domain/attempt is byte-for-byte deterministic；different domains do not alias；fleet peak is bounded；three failures in 60s degrade；successful recovery passes through recovering；clean stop is never a crash；no secret/prompt body reaches status。
- **Stop condition**: any `Math.random()` remains in automatic retry paths、manual retry gains delay、health reuses wire state、or corrupt state is auto-deleted/rebuilt。
- **Rollback surface**: revert S7-a files/wiring；no durable domain data or migration rollback。

## Task Breakdown

- [ ] Implement and freeze domain-separated deterministic jitter。
- [ ] Replace automatic WS/long-poll/outbox/maintenance retry timing and prove manual retry remains immediate。
- [ ] Implement atomic health window、crash budget、run marker and bounded crash history。
- [ ] Project operational health through daemon/control/CLI status。
- [ ] Run fleet/crash drills、hard gates、independent Codex acceptance、PR CI and merge/readback。
