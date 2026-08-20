# Hosted Live Activity Pilot Closure

> **Status**: Proposed；这是 research proposal，不是 active plan、release 或 deployment 授权。
>
> **Date**: 2026-08-20
>
> **Upstream**: `Ancienttwo/byok-sdk`
>
> **First consumer**: `Ancienttwo/salesko-new`
>
> **Review provenance**: Codex 对当前 `main` 的源码核对 + Codex Browser 中 GPT Pro 的方案复核。所有 downstream 路径和部署事实在执行前仍须对目标 commit 做 live recheck。

## 结论

原定 BYOK Live Activity V1 已交付。它交付的是 bounded、lossy、read-only 的 activity data plane、typed read model、approval projection、React-free deterministic fold 与安全 BFF reference；它从未承诺 browser polling client 或 React presentation。

下一阶段不应被描述为“补完 V1”，也不应立即创建 `@byok-sdk/ui-react`。正确目标是：

1. 独立关闭 daemon batching 与 hosted Cloud byte budget 不对称；
2. 在第一个真实消费方 Salesko 内完成 user-authorized、redacted、ETag polling 的 hosted UI 纵向闭环；
3. 用跨 daemon、Cloud、BFF 和 browser presentation 的证据验收；
4. 第二个真实前端消费者出现前，不抽公共 React package。

## P1：架构地图

| 层 | 当前 authority | 本阶段职责 |
|---|---|---|
| Runtime adapter | Pi / Claude / Codex native event → `AgentEvent` | 保持现有 observation contract，不扩 transcript 语义 |
| Daemon | `ProgressBatcher`、`TaskRunner`、WS/long-poll outbox | 增加 deployment-injected byte-aware batching |
| Hosted Cloud | typed `ActivityTail`、approval tail、Postgres/InMemory stores | 继续作为 bounded read-model authority |
| UI runtime | `@byok-sdk/ui-runtime@0.4.2` | 保持 React-free，只 fold activity/approval |
| Host BFF | auth、tenant/task authorization、redaction、ETag | 在 Salesko 落真实 composition |
| Presentation | host-owned browser client/UI | 第一版只在 Salesko 内实现 |
| Terminal | task attempt/result authority | 与 activity 并列返回，不从 `turn_end` 推断 |
| Artifact | observation 与 bytes/availability 分离 | 本阶段只显示 observation，不提供下载 |
| Approval mutation | 尚无 hosted Web mutation authority | 本阶段只读，不显示 approve/reject 操作 |

明确非目标：

- 不创建 `@byok-sdk/ui-react`；
- 不新增 canonical transcript；
- 不把 activity、approval、terminal、artifact 强拼为一个 total order；
- 不新增 SDK-level SSE/WebSocket browser transport；
- 不增加 artifact download 或 hosted approval mutation；
- 不通过截断、regex、payload 内容或 provider heuristic 补语义。

## P2：当前链路与真实断点

当前已成立：

```text
Runtime native events
  → adapter AgentEvent
  → TaskRunner / task.progress
  → WS or long-poll
  → hosted inbound validation
  → ActivityStore / ApprovalTimelineStore
  → readActivity / readApprovals
  → host reference redaction
  → @byok-sdk/ui-runtime fold
```

尚未闭合的是：

```text
真实 daemon observation
  → hosted stores
  → Salesko user/task authorization
  → mandatory redaction
  → browser-safe parallel-authority response
  → ETag polling hook
  → Salesko-local React timeline
```

另有一个独立可靠性缺口：daemon 默认只按 event count 与时间 flush；hosted Cloud 默认限制每个 activity batch 最多 50 events、序列化 `events[]` 最大 64 KiB。一个 count-valid、byte-oversized batch，或一个 oversized single event，会被 Cloud 整批拒绝。

## P3：设计裁决

### 1. Byte budget 属部署策略，不属于 frozen protocol v1

SDK 提供 byte-aware batching 能力；具体 host 显式注入 budget。禁止让 `@byok-sdk/client` 依赖 `@byok-sdk/cloud`，也禁止把 Cloud 当前默认 64 KiB 静默升级成 wire 常量。

### 2. Oversized single event fail closed

单 event 超限时：

- 不截断；
- 不发送；
- 不静默丢弃；
- 以 typed local policy error 终止 task；
- flush 之前已合法缓冲的 activity；
- 只发送一次 non-retryable terminal failure；
- 复用现有 quiescent teardown。

### 3. Presentation 先由真实产品拥有

Salesko 是当前唯一明确消费者。browser hook、polling cadence、React component、terminal renderer 都先留在 Salesko；只有第二个独立前端实质重复相同 API 与组件时，才评估 presentation primitives 或 `@byok-sdk/ui-react`。

### 4. 多 authority 并列，不虚构顺序

Salesko BFF 可以在一个 response 中并列返回 task、activity 和 approvals，但必须保持：

- task result 才是 terminal authority；
- `turn_end` 只是 runtime boundary；
- approval 与 activity 不承诺跨流排序；
- artifact item 只表示 runtime observation；
- missing/expired activity 不等于 task 不存在。

## Work package U1：BYOK byte-aware progress batching

### Goal

保证 daemon 在配置了 host byte budget 时，不会构造一个注定被 hosted Cloud 拒绝的 `task.progress` batch。

### Contract

扩展现有 `ProgressBatcherOptions`：

```ts
interface ProgressBatcherOptions {
  maxBatchSize?: number
  flushIntervalMs?: number
  maxBatchBytes?: number
}
```

并从当前 test/internal `DaemonOverrides.batch` seam 提升出唯一 public `DaemonConfig` 注入点。最终字段名由 API review 决定，但不得保留两份产品配置 authority。

字节计量与 Cloud 当前 validator 对齐：

```ts
new TextEncoder().encode(JSON.stringify(events)).length
```

最直接的实现会在每次 `push` 对 `buffer + event` 重新序列化，单 batch 内为 O(n²)。当前默认 batch 上限 10、Cloud 默认上限 50，这个成本可作为首版的 deliberate bounded trade-off；实现评审必须显式确认该上界。若改为缓存前缀字节数，缓存只能是上述 exact serialization authority 的等价优化，并用数组括号、逗号、UTF-8 multibyte 与 mutation-safety 测试证明一致，禁止引入近似计数的第二 authority。

Push algorithm：

1. 先测 `[event]`；单 event 超限，抛 typed `ProgressEventTooLargeError`。
2. 若 `buffer + event` 超限且 buffer 非空，先 flush 合法前缀。
3. 再把 event 放入空 buffer。
4. 继续应用 count/timer/manual flush 规则。
5. `seq` 只对真正 emit 的 batch 递增。

`TaskRunner` 捕获 typed error 后：

- flush 之前的合法事件；
- oversized event 永不进入 outbox；
- 发出恰好一个 `task.fail`；
- `retryable: false`；
- 使用稳定 reason prefix；
- 走既有 session disposal / process-tree quiescence。

### Expected upstream surfaces

- `packages/client/src/daemon/progress-batcher.ts`
- `packages/client/src/__tests__/progress-batcher.test.ts`
- `packages/client/src/daemon/task-runner.ts`
- task-runner resource-limit tests
- `packages/client/src/daemon/create-daemon.ts`
- public client docs / release verification surface

### Acceptance

- exact-limit batch 可发送；
- 追加一个 event 跨界时先发送合法前缀，再建立新 batch；
- UTF-8 multibyte 以 bytes 计量；
- single oversized event 抛 typed error，不消耗 seq；
- count、timer、manual flush、pending count 语义不回归；
- 非法 `maxBatchBytes` 在 construction fail closed；
- 已合法 activity 在 terminal failure 前 flush；
- oversized event 不会触发 Cloud 400 retry loop；
- 无 client→cloud production dependency；
- 无 protocol schema/golden change；
- WS/long-poll transport 语义不变。

### Release boundary

这不是“重新发布 Live Activity”。D1–D3 使用 immutable SDK candidate artifact。最终可选择从 `0.4.2` 线 backport 为 patch，或进入已经裁定的下一 release；semver 与 publish 另行授权。

## Work package D1：Salesko hosted observation BFF

### Goal

提供 narrow、read-only、browser-safe 的 Salesko host surface。浏览器不得获得或提交：

- `BYOK_CONTROL_ADMIN_TOKEN`；
- device bearer token；
- tenant selection；
- raw database rows；
- raw tool input/output；
- approval mutation；
- fabricated artifact download URL。

### Authorization composition

Salesko API 提供 authenticated grant endpoint，例如：

```text
POST /api/byok/tasks/:taskId/activity-grant
```

API 负责 user auth、tenant resolution、task/job ownership authorization，然后签发独立的短期 observation grant：

```ts
{
  iss: "salesko-api",
  aud: "salesko-byok-live-activity",
  tenantId,
  userId,
  taskId,
  scopes: ["byok:activity:read"],
  iat,
  exp
}
```

约束：TTL 60–300 秒、exact audience、exact task/tenant、read-only scope、无 wildcard、无 admin/device credential。可以复用既有 HMAC/WebCrypto primitive，但必须使用独立 prefix/schema/audience/scope。

`byok-control` 提供单一窄路由，例如：

```text
GET /host/tasks/:taskId/activity
Authorization: Bearer <observation-grant>
If-None-Match: "<etag>"
```

路由必须：

1. 验证 signature、audience、scope、expiry；
2. path taskId exact-match grant taskId；
3. tenant 只从 grant 推导；
4. 读取 attempt/result、activity、approval；
5. 先 redaction，再分别 fold；
6. 返回 Salesko-owned response；
7. auth/read 完成后才允许 304。

### Response contract

```ts
interface SaleskoHostedLiveActivityV1 {
  schema: "salesko.byok_live_activity.v1"
  taskId: string
  representationRevision: string
  generatedAt: string
  task: {
    attempt: TaskAttempt
    result?: TerminalResult
  }
  activity: {
    available: boolean
    snapshot: TaskTimelineSnapshot
  }
  approvals: {
    available: boolean
    snapshot: TaskApprovalSnapshot
  }
}
```

### Redaction V1

- 保留 task/envelope identity、batch/revision order、event type、tool name、native toolCallId、`isError`、approval identity/decision/timestamps；
- tool input/output 默认替换为 bounded redaction marker；
- unknown event 不把 opaque payload 送到 browser；
- progress/error 按明确 byte limit 做投影；
- credential/header/cookie/token/password/API key/refresh token/secret 不得进入 browser JSON 或日志；
- redaction/presentation 行为变化必须 bump `representationRevision`。

### Shared deployment budget

Salesko 在自己的 contract/config 定义一份 byte budget，并显式注入 local-agent 的 progress batcher 与 byok-control 的 `activityMaxBytes`。不能依赖两个默认值碰巧相同。

### Acceptance

- browser 不发送 tenantId；
- grant 只能读取 exact task；
- expired/malformed/wrong-audience/wrong-scope/bad-signature 均拒绝；
- unauthorized 与 nonexistent task 在需要处不可区分；
- admin/device credential 不进入 bundle、input、output、log；
- attempt/result、activity、approval 保持独立 authority；
- missing activity 不隐藏已存在 task；
- artifact 无下载语义，approval 无 mutation；
- secret sentinel 不进入 response/log；
- redaction 不能改 identity/order/correlation/outcome；
- ETag 对 activity cursor、approval cursor、terminal/result、representation revision 的变化敏感；
- cache private，并按 authorization/cookie 正确 `Vary`。

## Work package D2：Salesko-local polling 与 React presentation

### Goal

在 Salesko 内实现最小可用 UI，不在 SDK 建公共 React package。

建议 feature boundary：

```text
apps/web/src/features/byok-live-activity/
  api.ts
  query.ts
  types.ts
  live-activity-panel.tsx
  activity-loss-notice.tsx
  text-activity.tsx
  tool-activity-row.tsx
  approval-status-row.tsx
  artifact-observation-row.tsx
  usage-row.tsx
  error-row.tsx
  terminal-summary.tsx
```

实际路径以执行时 Salesko Web architecture 为准。

### Hook contract

```ts
useHostedLiveActivity(taskId)
```

负责：

- 获取 observation grant；
- 用 `If-None-Match` polling BFF；
- 304 保持 state identity；
- 每次 request 遇到可归因于 grant expiry 的 401 时，最多 refresh grant 一次并 replay 该 request 一次；replay 仍失败则 fail closed。这个上限按单次失败事件计算，不是整个长任务生命周期只能续一次；
- terminal 后停止；
- transient failure bounded backoff；
- authorization failure 不无限重试；
- hidden tab 暂停或降低频率；
- taskId change/unmount 取消旧请求。

建议 cadence（Salesko policy，不是 SDK contract）：

- Offered/Claimed：1.5–2 秒；
- Running/AwaitApproval：750–1000ms；
- transient failure：退避至最多 5 秒；
- terminal：停止；
- hidden tab：暂停或降至 5 秒。

### Presentation semantics

- text fragments 可视觉合组，但不冒充 canonical message；
- tool 只按 native ID 配对；
- `output-unknown` 不显示为成功；
- dropped/gap/expiry 必须可见；
- unknown event 只显示中性占位，不显示 opaque payload；
- boundary 不是 completed；
- terminal 来自 task authority；
- artifact 只显示“观察到文件活动”，无下载按钮；
- approval read-only，无不可工作的操作按钮；
- 新 activity 的 `aria-live` 必须节制，不能逐 token 播报；
- 状态不能只依赖颜色，遵守 reduced motion。

### Acceptance

- hook 不发送 tenantId；
- 304 不替换 state object；
- 单次 expiry failure 最多触发一次 grant refresh 和一次 request replay；长任务后续新的 grant expiry 可以进入新的 bounded refresh cycle；
- terminal 停止 polling；
- task change/unmount 正确 cancel；
- tool 所有 output state 可区分；
- dropped/gap/expiry warning 可见；
- unknown payload、secret sentinel 不进入 DOM；
- artifact 无 download affordance；
- approval 无 mutation affordance；
- 单独 `turn_end` 不显示 Complete。

## Work package D3：纵向 E2E 与 pilot evidence

### Tier 1：deterministic CI

测试必须从 daemon emission 前开始，并结束于 browser-facing component state：

```text
test runtime/device
  → daemon byte-aware batching
  → real hosted HTTP surface
  → PostgreSQL activity/approval stores
  → observation grant
  → redaction
  → ui-runtime fold
  → browser JSON
  → hook/component state
```

至少覆盖：

- text fragments；
- 两个同名并行 tool calls；
- success/error/unknown outcome；
- usage；
- artifact observation；
- approval request/resolution；
- unknown future event；
- turn boundary；
- terminal complete/fail；
- ETag 304；
- dropped/gap；
- redaction sentinel；
- byte split；
- single-event oversize fail closed。

禁止测试手工构造最终 `ActivityTail` 或最终 UI snapshot。

### Tier 2：real Salesko pilot

使用真实 `apps/byok-control`、`apps/local-agent`、至少一个真实 runtime、immutable candidate/published SDK artifacts、真实 observation grant 与真实 BFF response。

Evidence receipt 记录：

- byok-sdk commit/tag 与 package integrity；
- Salesko commit；
- exact dependency versions；
- migration ledger；
- runtime；
- task ID；
- activity/approval cursors；
- terminal result；
- ETag behavior；
- redaction assertion；
- byte-budget assertion；
- no-secret log scan；
- rollback instructions。

## 执行顺序与回滚面

```text
U1 contract/tests
  → immutable SDK candidate
  → D1 response/auth/redaction contract freeze
  → D2 fixtures + real D1 route
  → D3 deterministic E2E
  → D3 live pilot
  → separate release/deploy decision
```

- U1 rollback：撤销 additive daemon config 和 batching 行为；无 wire/DB migration。
- D1 rollback：移除 observation grant 和窄 host route；现有 device/admin surface 与 stored activity 不变。
- D2 rollback：移除 Salesko feature/hook；无 SDK/protocol/DB rollback。
- D3 只生产 evidence，不改变 authority。

D2 可以在 D1 schema freeze 后用 fixture 并行开发，但不能在真实 D1 route 验证前宣称完成。U1、D1、D2、D3 不合并为一个 PR。

## Phase Definition of Done

- 原定 headless V1 scope 与 claims 保持不变；
- explicit deployment budget 下，daemon 不产生 Cloud-rejected oversized batch；
- single oversized event 本地 fail closed，不截断、不静默丢弃；
- Salesko 有 user-authorized、tenant-bound、redacted、read-only route；
- Salesko 有 ETag polling hook 与最小 local timeline；
- terminal 不从 activity 推断；
- artifact observation 不冒充 availability；
- approval 不冒充 actionable mutation；
- 一条 deterministic E2E 穿过 daemon → Cloud → BFF → browser UI；
- 一条 live pilot 使用 immutable SDK artifact；
- 没有创建公共 React package。

## 后续触发条件

- **Artifact availability**：只有出现真实下载需求时，另建 durable metadata、availability、hash/size/type、authorization、presigned URL、expiry 与 missing/deleted/upload-failed contract。
- **Hosted approval mutation**：只有出现真实 Web approve/reject 需求时，另建 exact approvalId、mutation grant、stale rejection、audit、CSRF/replay/rate-limit/race contract。
- **Push transport**：只有 ETag polling 实测无法满足 latency/cost 时，才评估 SSE/WebSocket/change notification，且不得创建第二 activity authority。
- **Public React package**：第二个独立前端实质重复相同组件/API 后再评估。
- **Canonical transcript**：只有产品需要 conversation history 时，新增 message ID、role、text mode、message boundary、retention 与 privacy contract；不得从 `progress.text` 推断。

## 执行前必须重新验证的事实

1. byok-sdk candidate commit 的 `DaemonConfig` / `DaemonOverrides.batch` 实际形状；
2. Cloud activity byte validator 的计量方式与 deployment override；同时核对 WS、long-poll HTTP/body 与任何 proxy 的 message-size 上限，区分 `events[]` budget 和完整 envelope/transport overhead；
3. Salesko 当前 package pins、API/auth primitive、byok-control ingress topology；
4. Salesko user→tenant→task ownership authority；
5. production DB migration ledger 与 deployment version；
6. target worktree、active plan、allowed paths 与并行 WIP。
