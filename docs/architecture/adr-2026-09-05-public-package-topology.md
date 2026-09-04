# ADR-035：保留 self-hosted server，退出无独立能力的 umbrella package

> **来源**：owner 于 2026-09-05 追问 WP3B 为何没有减少 package，并批准独立的 `public package topology` 裁决；事实基线为 `main@f1eed3d3227c20f057111e27c459d2dda2175879`。
> **关联**：ADR-032、`docs/researches/2026-09-03_architecture-review.md` §6/§8、`docs/researches/evidence/2026-09-03-architecture-review/track-opus.md` O1、`docs/researches/2026-09-03_wp3b-coordination-kernel-design-packet.md`。
> **范围**：本 ADR 只决定 steady-state public package topology；不授权删除目录、改 manifest/lockfile、发布、下游迁移或 npm registry mutation。

## Context

WP3B 的 “fold `server` into cloud” 折叠的是协调语义与实现权威，不是 npm package：`@byok-sdk/server` 仍提供 Node/Hono self-hosted composition，而 `@byok-sdk/cloud` 保持环境无关的 domain kernel。当前 self-hosted 路径是：

`host -> createByokServer -> server deployment composition -> createByokCloud -> core stores`

当前仓库有 15 个 workspace manifest：10 个 public npm artifacts、private `@byok-sdk/conformance` 和 4 个 private examples。两个可能的减包目标并不等价：

- `@byok-sdk/server` 有独立部署职责，并被 `examples/basic`、client real-server integration tests 与 umbrella 消费；它把 `@hono/node-server`、embedded storage、rate limiting、health/lifecycle 与 bounded live relay 留在 Node 边界。
- `byok-sdk` 的生产源码只有 namespace re-exports；它依赖全部 7 个 dispatch ownership packages。已检查的 byok-sdk 与 Salesko 产品代码没有使用该入口；仓内引用仅是 README/package docs 与 pack/registry smoke。未检查的外部 npm consumers 仍为 unknown，不能声称不存在。

## Decision

1. **retain @byok-sdk/server**。它继续是 `@byok-sdk/cloud` 上的 self-hosted Node/Hono façade；依赖方向保持 `server -> cloud/core/protocol`，`cloud` 不得依赖 `server`。不得为了减少 package 数量把 Node deployment policy 塞进 cloud kernel，也不得换名制造一个等价 adapter package。
2. **retire byok-sdk**。无独立 capability 的 unscoped umbrella 不属于 steady state；在一个另行批准的 SemVer-breaking release 中一次性删除 `packages/sdk` 的 workspace/publication authority，消费者改为只安装并 import 实际拥有能力的 scoped packages。
3. 该 cutover 实施完成后，public artifacts 数量从 **10 -> 9**。在 manifest、lockfile、release pack/readback、README 与 API surface 同一变更单元完成前，当前事实仍是 10；本 ADR 不把未来目标冒充为已实现状态。
4. cutover 后不得发布空 umbrella、alias package、dual export 或 shape translator。registry 中既有 immutable `byok-sdk` versions 只是历史 artifacts，不是继续维护的 compatibility path。
5. 因外部 consumer 数量 unknown，实施必须作为明确的 breaking change 写入 release notes，并以 direct-package clean install/import、single-version closure 和 repository/downstream exact-import inventory 验证；不得用未知 consumer 风险反向引入长期兼容层。

## Rationale

一项独立部署能力足以形成 package 边界；`server` 正好承担这个边界。umbrella 则没有独立输入、输出、policy、runtime 或 persistence contract，只复制其他 package 的入口并强制安装完整依赖扇出。

在 10 倍 package 数量下，umbrella 首先放大的是 release ordering、exact-version edge、pack/readback matrix 与无关依赖安装成本；这些成本随 package 数线性增长，但 capability 不增加。删除 `server` 则会先破坏 Node/Worker runtime boundary，或立即要求新建同义 adapter，不能达到真正减包。

## Consequences

- 当前 `@byok-sdk/server` package 与行为不变；ADR-032 的 single coordination authority 继续成立。
- 后续实现是独立、一次性的 public distribution cutover，不与 WP3B closeout 混称为已完成。
- 后续 work package 至少覆盖 `packages/sdk/**`、workspace lock record、release package inventories/readback、root/package README install imports、API surface inventory、version authority wording与 downstream import audit；具体版本与发布时间由 release contract 决定。
- `@byok-sdk/keys` 的独立安全与版本边界、public `@byok-sdk/testkit` 的测试工具边界、private `@byok-sdk/conformance` 均不受本裁决影响。

## Status

**Accepted (owner-approved 2026-09-05; implementation deferred and separately gated).**
