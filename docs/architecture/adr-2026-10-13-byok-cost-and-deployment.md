# ADR-038：BYOK 成本模型、部署目标与 routine 时钟

> **来源**：owner 2026-10-13 的决定，整理在 [PRD：BYOK Bot routine、成本模型与部署目标](../researches/2026-10-13_bot-routines-cost-deployment-prd.md) §2。决策 1、2、3、5 对应 PRD 的 O1–O4。决策 4、6 对应 PRD 的 O5–O8，由同一个 PR 提出。
> **取代**：[ADR-036](adr-2026-10-03-cloud-generic-agent.md) D7 中"Cloudflare 优先（DO / DO SQLite）；Node + Postgres 仅预留接口、不实现"对真相层的约束。D7 的其余内容不变。
> **范围**：只记录决策。不授权实现、发布、issue 修改或下游迁移。实现切片见 PRD §11。

## Context

- ADR-036 D2–D4 已定：云端只用平台 key，BYOK key 只在本地。所以 BYOK 工作只能在设备上执行。
- 下游 Host 需要定期运行的 Bot 工作（routine）。SDK 没有设备端定时能力，Host 各自写调度循环。
- SDK 已有存储 entitlement 和额度准入（`TenantStorageEntitlement`、`QuotaStore`）。spec 把推理用量定义为遥测，不作为 billing、quota 或 entitlement 的依据。
- 真相层已经能在 Node 和 Workers 上运行：`@byok-sdk/cloud` 两边都能加载；`@byok-sdk/cloud-dataplane` 的根入口在 Node 上运行，`runtime` 入口在 Workers 上运行。D7 却写着 Node + Postgres 仅预留。
- 设备空闲时，events hold 每 250 ms 读一次 mailbox（#410）。Workers 按请求和 CPU 计费，流量大时成本高。

## Decision

1. **不计量执行**：BYOK 不按 token、流量或执行次数计费。SDK 不提供执行计量 API。推理用量只作遥测。
2. **存储是收费单位**：收费单位是超出 `TenantStorageEntitlement` 的存储。价格和额度由产品决定。存储用量只有一个权威。
3. **部署目标**：真相层（`@byok-sdk/cloud`、`@byok-sdk/cloud-dataplane`）以 VPS 为优化和主测试目标，即 Node + Postgres + S3 兼容对象存储。Workers（Hyperdrive + R2）继续支持。新端口先做 Node 实现；Workers 实现可以晚一些，或者明确降级。
4. **`cloud-do` 范围**：`@byok-sdk/cloud-do` 保持只在 Cloudflare 上运行，不做 Node 版本。它只用平台 key，BYOK 产品不走它。
5. **执行与时钟在设备上**：BYOK routine 不需要官方 key。执行和时钟都在设备上，用用户自己的 key 或 runtime。云端只保存定义、结果投影和可见性状态。
6. **hosted 真相层不为 routine 计时**：没有 cron，没有 DO alarm，没有服务端定时器。设备端时钟由 `@byok-sdk/server` 的 wake 队列提供（PRD §7）。周期规则留在 Host。设备上没有 Host 进程的 Host 可以用自己服务端的定时器提交 recurring 执行，执行仍在设备上（PRD O8）。

## Consequences

- ADR-036 D7 只约束 `cloud-do` 的 backend。
- #410 决定空闲设备的服务器成本，建议优先级从 P3 提到 P1。
- #411 和 #412 在收费路径上：mailbox 字节必须记账，保留清理必须能在有流量的租户上提交。
- 下游 Host 的设计要算出每台空闲设备的服务器调用数（PRD §8.2）。
- 下游的执行计费与决策 1 冲突。例如 Aiphabee 对本地操作收 credits，需要删除。
- 设备在线时 routine 才运行。离线和错过由服务端在读取时推导，不用 watchdog。

## Status

决策 1、2、3、5：**Accepted（owner，2026-10-13）**。决策 4、6：**Proposed（2026-10-13）**，PR 合并即视为 owner 接受。仅记录决策；实现未开始。
