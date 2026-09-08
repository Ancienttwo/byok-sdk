# SDK 独立升级责任核验回传

日期：2026-09-08。输入：Salesko `docs/researches/byok-sdk-independent-upgrade-handoff-20260908.md`。

交付已完成：修复 commit `9049b01`；artifact source `6bcf659874be14ed27378d6dcb635a8a9a23a258`。本地required checks全部通过（3890 passed / 135 skipped），标准10包pack及isolated npm install smoke通过；实际解包后的protocol/cloud版本拒绝探针也通过。完整[交付receipt](evidence/independent-upgrade-20260908/delivery.json)、[candidate manifest](evidence/independent-upgrade-20260908/candidate-release-manifest.json)、[本地exact-pin消费清单](evidence/independent-upgrade-20260908/exact-pins.json)。本candidate未push、未跑远端CI、未merge、未发布；沿用prepared 0.15.0/keys0.4.1 metadata，不能用这些SemVer替代source/hash选择产物。

## 结论与 Gate

**不能给出整体 `SALESKO_ONLY`。** 已证明 SDK 的 unsupported wire major admission 缺陷；本候选修复该缺陷。Salesko 消费的旧 SDK source 还缺少已经合并的 R7/R9 等持久化修复，本候选从包含这些修复的 main 开始，未重复实现。

`private_agent_chat_rollout_paused`、历史聊天与 proposal/read 权限耦合仍属于 Salesko。SDK 缺陷不构成该 HTTP 503 的根因证据，也不改变聊天 schema 的 owner。

已有版本提供 `await daemon.stop()`、持久化恢复与 exact ACK API；不需要为了满足这份清单额外发明 drain/reopen wrapper。成功 stop 是本地 teardown 完成的 Promise receipt，**不是 cloud ACK 全部到达的证明**。

旧 Local Agent/SDK artifact 未在输入中指定。因此“某个实际旧 release → 新 release，在完整 host/cloud 组合中独立升级”仍为 `INCONCLUSIVE`。当前证据不能解除该具体升级验收项，也不应阻止 Salesko 修复已明确属于自己的历史读取/准入耦合。

## P1：固定主体和责任边界

| 主体 | 固定值 / 证据 |
|---|---|
| Salesko release checkout | `f6359f63049a8fb0b2dcf5a98658683ca59678c2`；本轮只读 HEAD 与 manifest，与 Handoff 相符 |
| Salesko 0.1.19 binary build source | Handoff 提供 `aed7bc0cfeb50a726ce19ea1964621ffbc85f07a`；本轮未运行其二进制，不重作 live/生产声明 |
| 实际消费的 SDK source | `2752ffe86c4b222e2a23e75176dd2dd3a75901bb`，client/core/protocol/cloud 0.15.0，keys 0.4.1 |
| SDK 当前 main 基线 | live `git ls-remote`：`62e83ae9ac76e38b5448307fec02850f780d7347`；push CI `34195326650` completed/success，23 jobs success |
| 修复候选 | `codex/independent-upgrade-version-gate`，基于上述 main；最终 source/hash、检查和 package manifest 见同目录 evidence 的交付 receipt |
| 固定 server/adapter | 新增故障回归用本候选的真实 `createByokServer`、paired `ConnectionManager`；只改网络响应 envelope 的 `v`。不调用 LLM，不启动 Salesko adapter，不触碰生产 |
| 实际旧 client | 未指定；`clientVersion: '0.5.0'` 的 fake peer 测试仅证明 release label 不参与门禁，不能冒充旧二进制 |

协议 owner 是 `packages/protocol`；client 拥有 runtime、Agent-home lease、SQLite journal、outbox/spool、receive cursor；cloud 拥有设备认证、入站 admission、task lifecycle 与 receipt；server 是同一 cloud kernel 的高层 dispatch composition。Salesko 拥有业务 contract、required tools、Profile/Placement、聊天持久化、updater 和部署决策。

## 逐项核验矩阵

| 核验项 | 分类 | 已证明的范围与剩余边界 |
|---|---|---|
| 固定云端，旧→新 client | `INCONCLUSIVE`；wire bypass 为 `SDK_DEFECT_CONFIRMED` | 只支持 wire v1；package release label 不决定 admission。真实旧 artifact 缺失，不能声称完整跨 release 验收通过。新增 guard 证明 v2 已知 offer 在修前被接收/ACK，修后不进入 handler且cursor保留；恢复v1同一offer后可接收。入口 `client/src/__tests__/protocol-version-admission.test.ts`。 |
| 固定 client，云端升级 | `SDK_DEFECT_CONFIRMED`，本候选修复；refusal 原因表达有 `SDK_CONTRACT_GAP` | `EnvelopeSchema` 过去允许任意整数 v；`MessagesSendRequestSchema` 和 exported `handleInboundEnvelope` 都可接受 v2 claim。修后 HTTP 400、direct `rejected`、task 保持 offered，同id v1可接受。HTTP仍是现有通用错误/计数协议，未新增专门的 unsupported-version wire refusal union。 |
| capability 演进 | 受审路径为现有 SDK 契约；产品 required-tools 变化属 `SALESKO_ONLY` | 高层 `server/src/index.ts:dispatch` 在 enqueue 前校验 flags/toolsets；Agent offer 由 `cloud/src/cloud.ts:assertAgentHomeAdmission` 等 gate。低层 `enqueueToolsetOffer` 明确要求 host 先选 advertise `toolset-selection` 的设备，见 `packages/cloud/README.md` 的 enqueue 示例后说明；client 逐个解析 required IDs，不能补弱任务。新增可选 toolset 配置本身不改已有 offer.requiredToolsets。 |
| 原 journal/outbox 升级 | R7 为 `SDK_DEFECT_CONFIRMED`，main 已修；完整旧release为 `INCONCLUSIVE` | 真实2752ffe source写出的有效outbox由main同文件实现读回，identity/body保留、wrong ACK不退休、exact ACK后重开为空。旧writer自然compaction后append会破坏JSONL，新writer同序列通过。新reader拒绝已坏文件且逐字节保留。SQLite hash-only predecessor 明确拒绝，无隐式migration：`daemon/journal/sqlite-journal.ts` constructor。该旧格式没有本次授权迁移。 |
| 在途与 terminal 恢复 | 旧artifact R9/#158–#163 为 `SDK_DEFECT_CONFIRMED`，main 已修 | `TaskRunner` 管 admission/start/disposal，`TerminalCommitQueue` 保留首次terminal bytes；`create-daemon.ts` startup journal recovery 不重跑已接收runtime，合成明确 interrupted terminal或重送已存terminal。`confirmTerminal` 只在exact接受回调后确认。R9拒绝不再永久park completion。已有 `execution-recovery-kill`/`journal-integration`/`terminal-boundaries` 覆盖崩溃与ACK异步边界，不保证任意外部side effect exactly-once。 |
| 身份/isolation | 现有契约；跨指定旧release为 `INCONCLUSIVE` | canonical Agent home、symlink containment、execution lease、journal enrollment binding，以及 `AgentMessageOutbox.recover` 的tenant/Agent校验。升级应保留原storeDir、hostStorageRoot、device enrollment和AgentRef；不得unpair后假称恢复。测试入口 `agent-home-contract`、`journal-sqlite`、`agent-message-outbox`。跨source outbox探针验证identity不变，但不是整个旧设备home的升级验收。 |
| lifecycle API | 现有 SDK API 足够表达本地安全停止；旧artifact disposal修复需消费 | `Daemon.stop(): Promise<void>` 汇合停止admission、active teardown、terminal commit tail、bounded transport drain、owned journal close和owner release。失败拒绝并保留未闭合owner；不得catch后启动第二实例。`Session.close(): Promise<void>` 是adapter-owned资源quiescence receipt。普通stop无undelivered计数；control shutdown的`shutdown-complete`事件可观测该计数，但不替代exact ACK。 |

“未知 executable type”与“unsupported major 上的已知 type”不同：前者现有 `LongPollClient.loop` 已冻结 cursor；本次修的是后者绕过 schema 的路径。不恢复旧的 skip-and-ACK 行为。

## P2：完整 trace 与 Root Cause Evidence

### 本次新增修复：unsupported wire major

- **root_cause**：`packages/protocol/src/envelope.ts:envelopeShape` 把 v 定义为任意 integer。hello 的 protocolVersions gate 不约束后续每个 envelope。公开 `cloud/src/inbound.ts:handleInboundEnvelope` 也无独立版本检查。
- **repro**：pair → real server dispatch v1 task.offer → 网络仅将v改为2 → `LongPollClient.loop` → `parseMessage` → `ConnectionManager.onEnvelope` → cursor落盘；另一方向 v2 task.claim → authenticated `POST /byok/messages` → `MessagesSendRequestSchema` → `handleInboundEnvelope` → lifecycle claim → accepted。修前观察 `receivedV=2,cursor=1,acceptedV2=true,cloudTaskState=Claimed`。
- **regression_guard**：client真实连接guard以“下一次poll请求已到达”证明上一页完成处理，无固定sleep；cloud HTTP/direct gate各有guard，同id v1 positive control证明拒绝不占用身份。protocol另测0/-1/2/99，decode/schema/HTTP batch共用拒绝。
- **pre_fix_failure_artifact**：[version-pre-fix.log](evidence/independent-upgrade-20260908/version-pre-fix.log)，两consumer guard真实失败；修后结果及最终subject见交付receipt。

### 已有修复，不重做

| 问题 | trigger / trace | 修前 / 修后证据 | 已合并 source |
|---|---|---|---|
| R7 JSONL framing | retained draft + 256 append/disposition循环触发512条自然compaction；随后append拼接末行；重开失败 | 本轮 [outbox-cross-source.json](evidence/independent-upgrade-20260908/outbox-cross-source.json) 复现旧writer失败、新writer通过、旧坏文件保留。两个writer的已有回归：`agent-message-outbox.test.ts` / `agent-egress-spool.test.ts` | `786b2cbb88780156fdc0dd832a72ebf6865fde2e`，merge `0b307202d98daad1dc00e67f983a6532e806ade3` |
| R9 required refusal | turn_end停在required-message completion gate；refused持久化后旧handler只revoke，未fail/close | main `task-runner.ts:handleAgentMessageDisposition` active identity guard + existing fail authority；`agent-message-completion-gate.test.ts` 拒绝/取消/terminal唯一性回归 | `ad3af9f9073157fb6b4f98b4adc1eca212425d19`，merge `afbb02262afbcea1b933d2784be6f640c287b62a` |
| #158–#163 / R10–R13 | admission/start owner、terminal落盘失败、uncertain append、cursor/compaction fsync及cancel/revoke竞态 | 已有四字段/回归与限制见 `2026-09-07-execution-receipts-and-harness-identity.md`、`2026-09-08-r10-r13-durability.md`；本轮live main CI通过，不重跑旧subject整套验收 | 包含于基线 `62e83ae`；#175 head `60321aefcbdea5f51c2771b0ed4c74226b8e8a68`，其packages tree与main相同 |

本地draft尚未cloud admission；accepted offer/runtime-start/terminal durable/terminal ACK是五个不同边界。timeout不是进程退出证明；recovery终态不是原生session继续成功；cloud已接受也不代表本地confirmTerminal已fsync。报告不将这些合并。

## P3：修复决策与最小 host 调用

仅在既有envelope version字段加入对 `PROTOCOL_VERSION` 的语义校验，并保护可绕过HTTP schema的exported inbound入口。TypeScript `v: number`、v1 golden bytes和payload/capability含义不变，不新增v2、不改字段、不猜测协议、不加产品wrapper。拒绝从未声明支持的major不是改变v1契约。10倍异常输入首先增加既有backoff/阻塞队列压力，不应通过ACK不认识的work缓解。

```ts
import { createDaemonWithAdapters, type Daemon, type DaemonConfig,
  type RuntimeAdapter } from '@byok-sdk/client';

// 此函数在由host提供的新代码环境中重建daemon；跨进程updater应分两阶段。
async function reopenAfterStop(
  running: Daemon, config: DaemonConfig, adapters: RuntimeAdapter[],
) {
  await running.stop(); // reject就停止升级，不吞错、不以presence或sleep替代
  const reopened = createDaemonWithAdapters(config, adapters);
  await reopened.start();
  return reopened;
}
```

`config` 保留原serverUrl/productId/storeDir、Agent hostStorageRoot和凭据存储；只把新distribution identity明确注入 `localAgentRelease`。保持 `hostedJournal: { mode: 'sqlite', storagePolicy: { maxStoreBytes, minFreeBytes } }`。使用 injected journal override 的host自己在daemon stop成功后close该journal；owned SQLite由SDK close。普通更新不得调用 `unpair()`，也不得删 `.byok`、daemon.db或credential store。

跨进程替换还需要 updater 等待旧host进程自己的exit/launchd完成证据。SDK `stop`证明所拥有的资源停止，不证明host自己其他线程/资源已退出。网络不可用时本地durable terminal可以留待新进程replay；不能把stop成功写成“全部云端ACK”。

根据Handoff已确认违反组合层边界的是：以最新proposal/read要求重解析历史execution/terminal；把新增可选能力变成所有旧任务的新权限前提。仅从版本号推capability、stop失败后启动第二实例、用presence/sleep代替退出、用unpair/删库作为升级步骤也违反上述契约；本轮**未证明Salesko实际执行了后四种用法**。

## 产物、测试与复现

消费端5个tgz本轮通过curl实际下载并逐一匹配原CI manifest SHA-256：[artifact-readback.json](evidence/independent-upgrade-20260908/artifact-readback.json)。URL均在 `https://downloads.salesko.ai/byok-sdk/2752ffe86c4b222e2a23e75176dd2dd3a75901bb/`；该事实不是npm registry publication证明。

依赖图：client → core/protocol；cloud → core/protocol；keys → core；旧artifact内部SDK edges均exact `0.15.0`，keys自身`0.4.1`。不能仅替换client而让内部边指向另一个同版本source。新candidate的完整10包图、hash及exact-pin文件由本仓标准 `scripts/release/pack-and-smoke.mjs` 产物/交付receipt说明。Pi仍固定0.85.1。

本轮baseline2752ffe定向测试：Node22.22.3，client journal-sqlite/outbox/spool/release-identity/stop-parity共79通过；server integration12通过/2 skipped；cloud Agent-home admission12通过。合计103通过/2 skipped。跨source outbox probe使用Bun1.4.2，是文件/源码探针，不冒充Node native SQLite或Salesko binary证据。新候选最终required checks及artifact smoke记录在交付receipt，来源与baseline分开。

复现入口：

```sh
bun run --cwd packages/protocol test -- src/__tests__/validation.test.ts src/__tests__/freeze-guard.test.ts
bun run --cwd packages/client test -- src/__tests__/protocol-version-admission.test.ts
bun run --cwd packages/cloud test -- src/__tests__/protocol-version-admission.test.ts
bun docs/researches/evidence/independent-upgrade-20260908/outbox-cross-source.ts OLD_SOURCE FIXED_SOURCE
```

跨source probe的OLD_SOURCE固定2752ffe；FIXED_SOURCE中的outbox及其依赖必须是main62e83ae对应源码。所有状态为临时目录；不需要生产token、已有device home或Salesko部署。

## 未闭合项与有界开工条件

1. 指定一个升级前Local Agent/SDK artifact以及固定host/cloud adapter subject，在disposable home完成旧writer→新reader的五个生命周期切点。只补这个组合，不扩展任意历史版本矩阵。
2. unsupported wire的安全拒绝已可独立修复；如产品必须显示专门的`unsupported_protocol_version`机器原因，再给现有HTTP refusal建明确返回契约。当前通用400/rejected不能被描述成已经提供该专用wire enum。
3. Salesko产品层修复可以基于已明确责任开工；受SDK恢复缺陷影响的升级放行须消费验收过的candidate产物并补上述旧→新组合。候选artifact/source acceptance不等于已merge、已publish、已部署或Salesko release通过。

本轮不修改Salesko文件、生产、registry、凭据或用户已有数据。已损坏的旧JSONL、hash-only predecessor和外部业务数据migration仍需各自明确operator contract，禁止自动删除重建。


## 后续实际 artifact 演练

用户批准的旧→新生命周期补证已完成：固定旧 cloud，实际 packed client 从 2752ffe → 6bcf659，五个 journal/执行切点及独立 message draft 场景 6/6 PASS。见 [完整组合、结果与限制](2026-09-08-packed-upgrade-rehearsal.md)。该结果补齐 exact 组合的跨进程运行证据，不扩展为任意旧版本、Salesko binary updater 或生产验收。
