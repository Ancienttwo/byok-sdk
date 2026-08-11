# ADR-025: Device、Agent、placement 与 runtime session 分权

- **Status:** Accepted
- **Date:** 2026-08-10
- **Deciders:** Ancienttwo
- **Scope:** BYOK multi-device / future multi-Agent fleet authority boundary

## Context

BYOK 当前已经支持多个配对 `DeviceRecord`，每台 Device 可上报多个
runtime capability。`ConnectionHub.dispatch()` 把任务路由到显式
`deviceId`，未指定时才选择 first-connected Device；`TaskStore` 保存的是
`taskId + deviceId + runtime`，Device 最终启动临时 runtime process、session
与 workspace。这条路径足以支撑 AiphaBee Local Agent CLI，但没有创建一个
持久、可命名、可独立启停或重新 placement 的 Agent resource。

对 RAFT Computer 1.0.15 hash-matched SEA artifact 的静态审计显示另一层
拓扑：一个物理 Computer service 可持有多个 server-scoped attachment，每个
attachment 有 runner，而 runner 以稳定 `agentId` 管理多个独立 workspace、
runtime process、session 与 lifecycle。该证据证明 Device/Computer 与 Agent
不是同一身份；它不证明 RAFT server-side storage、scheduler fairness 或
cross-Computer migration correctness。

BYOK 必须避免三种语义碰撞：执行宿主不是 Agent，runtime adapter/capability
不是 Agent，task/session 也不是稳定 Agent identity。Protocol v1 已冻结，且
AiphaBee 当前没有要求一个 local CLI 同时 attach 多个独立 control plane。

## Decision

BYOK 保留 `Device` 作为已配对执行宿主、device-key 与 presence/capability
authority。若产品以后引入 first-class multi-Agent fleet，必须新增独立稳定的
`Agent` authority，并用 generation/lease fenced `AgentPlacement` 把某个
Agent generation 唯一绑定到一台 Device。具体 runtime process、session 与
workspace 只是该 placement 之下的临时执行实例；`AgentObservation` 只投影
实际状态，不能反向成为 placement authority。

```text
Tenant / Product
  Device                         paired execution host + device-key authority
    deviceId
    presence + runtime capabilities

  Agent                          stable logical resource
    agentId
    name + runtime/model/policy spec

  AgentPlacement                 single assignment authority
    agentId + deviceId + generation
    desiredState + lease/expiry

  AgentObservation               non-authoritative runtime projection
    agentId + deviceId + generation
    observedState + process/session metadata

  RuntimeSession                 ephemeral process/session/workspace
```

本 ADR 不增加当前产品承诺，也不修改 protocol v1。AiphaBee 继续使用
adapter-only SDK 与既有 device/task path 产出 Local Agent CLI。Agent 的创建、
命名、desired placement 与 scheduling policy 属于宿主 control plane；BYOK
只有在另行批准的 fleet slice 中才提供可复用 identity、placement、observation
与 local supervision contract。

任何未来实现都必须保持以下 invariant：

1. `deviceId`、`agentId`、`taskId` 与 runtime ID 是不同 branded identity。
2. 一个 Agent generation 最多只有一个 authoritative Device placement。
3. Device 只有在 placement generation/lease 匹配时才能接受 Agent lifecycle；
   stale command 必须 fail closed。
4. Presence 与 `AgentObservation` 只是 hint，不是 assignment authority。
5. Runtime discovery 不得创建、重命名、迁移或复活 Agent。
6. Task/session terminal state 不得隐式改变 persistent Agent lifecycle。
7. 显式 placement 不可用时，不得 fallback 到另一台 first-connected Device。
8. Scheduling policy 属于宿主；BYOK 不从 hostname、display name、runtime
   列表或连接顺序推导 placement。
9. Protocol v1 保持 byte-for-byte frozen；fleet control 只能走新的
   HTTP/control-plane contract 或另行批准的 additive/versioned surface。
10. Multi-control-plane attachment 不进入设计，除非独立产品需求证明必要。

## Alternatives Considered

### 1. 把 `conn.hello.runtimes[]` 条目当作 Agent — rejected

Runtime entry 是 Device capability snapshot，没有稳定 identity、desired
state、workspace ownership 或 placement generation，也无法表达同一 Device
上两个使用相同 runtime 的 Agent。

### 2. 把 task 或 runtime session 当作 Agent — rejected

Task 是有限 execution request，session 只是连续执行 hint；两者都不拥有长期
name、policy、placement 或 lifecycle。复用会让 task terminal state 错误成为
Agent lifecycle authority。

### 3. 复制 RAFT multi-server Computer attachment — rejected

这会引入 per-server credentials、runner fan-out 与跨 control-plane identity
reconciliation，但 AiphaBee 没有这个需求。RAFT 证明模式可行，不证明 BYOK
需要同样的产品边界。

### 4. Device 自选 Agent placement — rejected

Opportunistic self-selection 在 reconnect/retry 下会产生 split-brain，并把
first-connected order 变成隐藏 scheduling policy。Placement 必须由单一
control-plane authority 以 generation/lease fencing 裁决。

## Consequences

### Positive

- 当前 Local Agent CLI 路径不需要重构。
- 未来可在一台 Device 上运行多个 Agent，或在不改变 `agentId` 的情况下重新
  placement 到另一台 Device。
- Device security、Agent lifecycle、Task state 与 runtime process state 各自
  拥有明确、可审计的 authority。
- BYOK 可复用 RAFT 已证明的拓扑思想，而不继承其 multi-server 产品语义。

### Negative and residual risk

- 真正的 fleet slice 仍需新 store/API、本机 supervisor、bounded start queue、
  generation/lease handling 与 conformance tests。
- `pickFirstConnectedDevice()` 不能充当 persistent placement scheduler。
- Agent migration 仍需独立 workspace/session transfer 决策；identity 分离本身
  不保证 migration safety。
- Presence-driven recovery 容易被误实现为 placement；review 必须继续检查
  observation 与 assignment 的单向依赖。

## Implementation Trigger and First Slice

本 ADR 本身不授权 production code、schema、route 或 protocol 变更。只有当
AiphaBee 或第二个宿主批准具体 fleet workflow 与 acceptance scenarios 后，
才能开始实现。

第一实现 slice 只冻结 contract：

1. protocol-free core types：`AgentId`、`AgentSpec`、`AgentPlacement`、
   `AgentObservation`；
2. generation-fenced compare-and-set 的 InMemory reference store；
3. composition-parameterized conformance tests；
4. 不加入 daemon supervisor、hosted migration 或 scheduling policy。

这样先验证最难逆转的 authority boundary，再决定 process management。

## Evidence Basis

- 当前 BYOK Device authority：`packages/server/src/auth.ts` 的
  `DeviceRecord` / `DeviceRegistry`。
- 当前 dispatch 路径：`packages/server/src/hub.ts` 的 `dispatch()` 与
  `pickFirstConnectedDevice()`。
- 当前 capability contract：`packages/protocol/src/messages.ts` 的
  `conn.hello.runtimes[]`。
- RAFT 参考边界：`docs/researches/raft-architecture-reference.md`；本决定只
  采用已从 shipped client artifact 证明的 Computer/runner/Agent 分层，不把
  未验证的 server enforcement 当成事实。

## Supersede Conditions

只有新的已批准 ADR 可以改变以下任一边界：复用 task/runtime identity 作为
Agent、允许多 placement authority、允许 presence 自动重建 placement、把
fleet control 塞入 frozen protocol v1，或引入 multi-control-plane attachment。
