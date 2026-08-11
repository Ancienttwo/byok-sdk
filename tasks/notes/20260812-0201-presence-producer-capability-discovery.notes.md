# Implementation Notes: presence-producer-capability-discovery

> **Status**: Active
> **Plan**: plans/plan-20260812-0201-presence-producer-capability-discovery.md
> **Contract**: tasks/contracts/20260812-0201-presence-producer-capability-discovery.contract.md
> **Review**: tasks/reviews/20260812-0201-presence-producer-capability-discovery.review.md
> **Last Updated**: 2026-08-12 02:07
> **Lifecycle**: notes

## Design Decisions

- Falsifier 先跑：`packages/client/src/__tests__/capabilities-client.test.ts` 第一条用例先对真实 cloud composition 断言 `GET /byok/capabilities` 返回可被 `CapabilityDeclarationSchema` 校验且含 `presence.hints` 的 declaration。前提成立后才动 daemon 代码。
- `capabilities-client.ts` 只做 fetch + fail-closed parse：非 200 / 非 JSON / schema 不过一律抛 `CapabilityDiscoveryError`，没有 404 语义分支，也没有"猜常见能力"回退。route 是 public，不带 bearer。
- `presence-publisher.ts` 自调度 `setTimeout` 而非 `setInterval`：慢发布延后下一拍，不排队第二拍。只发 `online`；停机不发 `offline`，靠 TTL 过期表达缺席。
- 心跳节奏断言抽成 `assertPresenceHeartbeatCadence`，被 publisher 构造函数与 `createDaemonWithAdapters` 的同步 config 校验共用——一个权威、两个调用点，配置错在构造期就炸（与 `maxTaskOutputBytes` 同一纪律）。
- 401/revoked 复用现成的 `authedFetch` + `AuthManager`：续签一次重试一次是它已有的语义，publisher 只负责把 `DeviceRevokedError`（或续签后仍 401）转成永久停止 + 降级记录。
- discovery 不被 `startUnderLease` await，只在连接 ack 后 fire-and-forget；shutdown 用 `AbortController` 取消在途请求，publisher 在 `runShutdownSequence` 内停（单序列纪律，不新增第二条 teardown 路径）。
- **重连再发现（gatekeeper F1，按 contract Goal「启动/重连后」定稿）**：每次连接重新 settle（`onStateChange` 进入 `open`/`degraded`）重跑一次 discovery，`presenceDiscoveryInFlight` 防重连风暴叠加请求。新 declaration 含 `presence.hints` 且 publisher 未跑且未永久停止 → 启动；不再含 → clean stop（非永久，后续 rollout 重新宣称可再起）。revoked/永久停止 latch 不被任何一次再发现复活——publisher 每个 `start()` 只建一个实例，latch 是设备级事实。**不加定时重试**：启动时 discovery 失败只在下一次重连自愈，因为重连是唯一「对面可能已不是我上次读过的那个部署」的信号，多一条 timer 就是第二套重试策略。
- 可观测降级沿用本文件既有的 `console.warn('[byok/client] ...')` 约定；publisher 通过 `onDegraded` 回调把原因交出去，测试直接读回调而不刮 stdout。
- 测试 seam 跟随 client 既有约定：换 `globalThis.fetch`（`real-server-outbox-*.test.ts` 的做法）+ `vi.useFakeTimers()`，生产代码不新增 `fetchImpl` 注入点。

## Deviations From Plan Or Spec

- 无功能性偏离。两处计划未明写的实现选择：(1) `real-cloud.ts` fixture 新增 `omitCapabilities` / `presenceTtlMs` / `presenceMinimumIntervalMs` / `listPresence()`，用来构造"未声明 presence.hints 的真实部署"与观察 hint 过期；(2) `DaemonConfig` 新增 `presence` 配置段（interval/ttl/minimumInterval，全可选）。
- 计划 Task Breakdown 最后一项（salesko dogfood 集成证据落账）属能力宣称前置条件，不在本 slice 的 allowed paths 与代码面内，未执行；已按 gatekeeper F5 移入 `tasks/todos.md` 延期账本，plan 内该项保留未勾并指向账本条目。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| publisher 用 `fetchImpl` 注入 seam | 拒绝 | client 既有测试约定是换 `globalThis.fetch`；多一个生产参数只为测试服务 |
| discovery 加超时 | 拒绝 | 不 await discovery 后超时无意义；hang 只让 publisher 不启动，shutdown 由 abort 收口 |
| 续签后仍 401 视为可重试 | 拒绝 | 无法靠重试自愈，等同 revoked；永久停止避免 retry spin |
| 停机显式发 `offline` | 拒绝（沿用计划裁定） | expiry = absence 已是 core 语义；崩溃路径本来也发不出，双通道只会两种停机表现不一致 |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
