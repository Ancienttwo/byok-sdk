# Bot PRD v3：来源摘录

日期：2026-10-19。对应 PR #524 的只读验收意见。本文只保存原文摘录，不新增决定。

原始 WO 报告不全在 main 或远端。下文保存本 PR 用到的段落。commit、原路径和行号用于核对来源；读者无需访问本地 `_ops/` 或未推送分支。省略段落不在引用中。提议值和未批准修订稿保留原状态。

## R0

以下为本次使用的本地裁定输入。原路径只记录来源，引用正文已包含在本 PR 中。

来源：`_ops/bot-wo/PRD-revisions.md:5`–`15`。

> ## 已定决策（写进 §12，标「已定（Aimpact，2026-10-18）」）
> - P5 拆 P5a（整文件替换 + 删笔记）/ P5b（edit-view 投影）。来源：WO-01 M0.2 裁定。
> - 记忆页 intent：沿用 `agent.memory.intent`，不加 wire `sourceRevision`；完整文件 revision = sha256(展示正文)；incomplete 文件只读。来源：WO-01 v2 §修订稿。
> - 上限表为 v1 提议值（WO-03 §2.5），不标已定。
> - routine schedule 用结构化字段 `{ minute, hour, daysOfWeek? | dayOfMonth? (+month?), tz }`，不用 cron。§5.2、§5.5、§8、§9 K8-S 行、§10 M0.5/P3、§11 按 WO-03 §10 改。
> - server wake 上限 368 天（`MAX_FUTURE_MS` + `wakes.test.ts:48/:58`），实现 PR 逐条说明。
> - `tasks.cancel` 返回 attempt：不做。
> - WO-05 未认领 offer 到期：cancel → `tasks.attempt` 读回；`tasks.attempt`/`tasks.get` 进 K4 允许 API 列表（§5.1 第 2 条）。
> - §14.1 服务端各行以平台 PRD 为准（K2、A2 之后，下游实现）；§9 K4 行改为「平台 PRD §13.1 K4 行；§14.1 Topology L 各行在 SDK 仓库合成 Host 跑通；服务端各行归下游」；§10 P1 范围同步。
> - §5.8 归属：聊天轮次进 K4（WO-05 v3）；routine、崩溃已在 K4；委派、`confirmable_action` 归 K8a；记忆页归 P2/P5。§10 P1 范围写清。
> - 同 routine id 版本切换（current/pending、generation、在途上限）归 K8a；K4 定义不可变。§5.5、§10 P3 写明。

来源：`_ops/bot-wo/PRD-revisions.md:17`–`26`。

> ## 事实修正
> - §5.3.3 Linux 行：新 home/`.byok` 目录持久化缺口三端共享（`agent-home.ts:280` 之后无父目录 sync），不写「差距：无」。来源：WO-02 v2 §2.2。
> - §5.3.3 / P2-mac：helper 作为 SDK 发布物，SDK 解析路径并按部署 digest 比对；产品重签（notarization/Authenticode）策略为 P2 前置。来源：WO-02 v2 §4.3。
> - P2-win / §11：NTFS 故障模型 spec 决策稿与矩阵并行；Host applied vs 设备回退已开 #522；helper 超时 lease 竞态已开 #521。
> - §2.1 Aiphabee：「bot 聊天跑在 Pi BYOK 上」改「没选 runtime 时用 Pi BYOK」；#512/#513 描述按 WO-04 v3 第 6 项。
> - §5.2 K7 子集：没有 `pattern`、`format`、`uniqueItems`、`$ref`；`maxLength` 数码点；`number` 25 / `integer` 24 字节保守上界。来源：WO-03 §2.1/§2.4。
> - §5.5 `dedupKey = "<routineId>:<version>:<t>"` 从右往左解析；WO-05 已对齐。
> - §11「outcome 总上限 64 KiB…M0.4 定每项上限」改为已定提议值，引用 WO-03 §2.5。
> - §8 非目标：「SDK 解析 cron」改为「SDK 运行时组件不解释周期规则；core 纯函数是 Host 调用的库」。
> - 平台 PRD §9.3 动作表补 `confirmable_action`、routine 三动作四行（WO-03 v4 §9）；§12.4 第 1 条 occurrence 身份 `(routineId, version, t)`，trigger 不进身份。

来源：`_ops/bot-wo/batch-2.md:13`–`17`。

> ## WO-07 K8-S SDK 切片（代码）
> - 目标：outcome 片段和 routine 纯函数进 SDK。
> - 范围：`@byok-sdk/protocol` 片段（WO-03 v4 §5，checked-oneOf 写法，§2.6 预算政策的组合函数）；`@byok-sdk/core` `routine-schedule`（`nextRoutineOccurrence`、`checkRoutineSchedule`、`ROUTINE_*` 常量，§6）；`@byok-sdk/server` `MAX_FUTURE_MS` 368 天 + `wakes.test.ts:48/:58` 两处断言（PR 逐条说明）；spec 新节（§4）；api-surface goldens；core 约束测试清单；定向测试：DST gap/overlap、Lord Howe、Samoa、月末、闰年、number 25/integer 24、三个变体 ≤ 65 536、workerd 定向样例（cloud-do）。
> - 依赖：WO-03 v4（已关）。
> - 验收：PRD §9 K8-S 行；五项必检。

来源：`_ops/bot-wo/batch-2.md:38`–`49`。

> ## WO-10 K8a 参考实现（代码，等 WO-07）
> - 目标：单 Bot 全部动作在 `examples/bot-collaboration` 跑通。
> - 范围：建在 K4 上；委派（`to` = 自己走续作预算）、`ask_user`、`confirmable_action` 四态、routine 三动作（`create_routine` → wake → 执行 → 结果回 owner；`cancel_routine` 后无新 occurrence；`update_routine` 的 current/pending、generation、在途上限按 WO-03 v4 §3.7）；被拒动作写进 ContextPack；长任务规则进示例 system prompt；合成端到端加委派和 `confirmable_action`。
> - 依赖：WO-05（K4）、WO-07。
> - 验收：PRD §9 K8a 第一行。`submit_result` 成功率在 Pi 上测量是单独 WO-10b（付费调用另行授权）。
> - 分支：`codex/k8a-bot-collaboration`。
>
> ## WO-11 P5a 记忆页（代码）
> - 目标：用户能整文件替换 MEMORY.md、删笔记；常驻档案进 ContextPack。
> - 范围：`examples/host-execution-core` 加 `agentMemoryIntents` transport、intent 账本、baseRevision 探测（WO-01 v2 修订稿里不需要新 wire 字段的部分）、投影进 ContextPack、8 KiB 上限阻塞；合成端到端的记忆页 replace/delete（Linux runner）。P5b（edit-view、`contentComplete`）等 WO-08/09 后另开。
> - 依赖：WO-01 v2（已关）、WO-05。
> - 验收：PRD §9 记忆页行（Linux 先跑，三端在 P2 后补）。

来源：`_ops/bot-wo/WO-05-v3.md:1`–`7`。

> v2 我核过：7 笔 commit，diff --check 干净，typecheck、api-surface、示例 37/37 通过。Aimpact 对范围做了裁定（2026-10-18），请在第二轮交叉审之前追加 v3，同分支小步 commit（不加 AI 署名），不 push，不改 packages/：
>
> 1. 加一个合成端到端测试：「一轮聊天」—— Host 用 `executions.submit` 提交一个 Bot 聊天执行（source: bot，不是 routine），fake runtime 走 `messageEgress`，断言消息被接受（spec「Host exact Agent message disposition readback」的 disposition），然后成功 terminal 被读回并结算。它和现有 routine 用例走同一条 FIFO 和同一个 outcome 事务，证明 PRD §5.8 的第一项在 K4 上成立。用现有 test-support 的 embedded server + daemon + fake runtime，不新建 Host 目录。
> 2. docs/host-execution-core.md 和 examples/host-execution-core/README.md 写明两条范围边界（各一段，不改代码）：
>    - 平台 PRD §14.1 的服务端各行（浏览器关闭时创建 routine 的同步、`sync_failed`、409、`device_offline`、`missed`、安全、成本）按平台 PRD 在 K2 和 A2 之后由下游 Host 服务实现；本参考实现只覆盖 Topology L 各行。
>    - 同一 routine id 的版本切换（current/pending、调度 generation、在途上限）归 K8a 随 `update_routine` 实现；本参考实现保持定义不可变，改定义换新 id（指南 :225–235 已有基础，补一句归属）。
> 3. VALIDATION.md 补这两条裁定和新测试；五项必检加示例测试重跑并记录 exit code。

## R1

原报告 commit：`fae93b803f8eff13b396bbd63888efc8ab9480e8`。以下内容从该 commit 读取。

来源：`docs/researches/2026-10-18-bot-mode-m0-memory-intent.md:250`–`262`。

> ### P3：为什么现设计存在，以及编辑裁定
>
> 原设计支持显式授权的整文件写入。§B 明确要求用户知道「absent-or-empty」，并知道重提可能覆盖 Host 看不到的内容：`CAS:263`。
> 这不是普通编辑器的读取契约。现实现正确保留了 CAS 和 at-most-once 不变量。
>
> 普通「用户改」应绑定用户实际看到的那份文件。设页面来自 A，设备现为 B，用户草稿为 A′。
> bootstrap 得到 hash(B) 后，把 A′ 配上 hash(B) 可以成功覆盖 B。CAS 没有失败，但用户没有看过 B。
> 如果 A 本身已经脱敏，A′ 还会丢失未展示的内容。新增一个孤立的 raw hash 也不能解决后一个问题。
>
> 裁定：保留现 intent apply 边。普通编辑需要**与同一次 snapshot 绑定的 path 和设备完整性证明**。
> 完整文件的 `sha256(utf8(display))` 就是 baseRevision，不必另加 wire revision。incomplete 文件不导出原文 hash。
> 对不能完整展示的文件，默认禁止把脱敏全文回写。显式整文件替换可以保留为另一个清楚标明范围的动作。
> 这不恢复 Bot 审批门。用户保存就是 Host 授权来源；变更 base 或 body 后仍需新的用户决定和新 intent。

来源：`docs/researches/2026-10-18-bot-mode-m0-memory-intent.md:272`–`279`。

> ## protocol/spec 修订稿：绑定展示内容的编辑基线
>
> **状态：第二版建议稿，未实现，未批准。** 改动只写在本节。现有 `docs/protocol.md`、`docs/spec.md` 和 `packages/` 均不修改。
>
> 选择：为现有 projection 定义一个明确授权的 edit-view profile。继续使用现有 intent 写入。
> 第二版不新增 wire `sourceRevision`。设备证明展示正文完整后，Host 直接计算 `sha256(utf8(content))` 作为该视图的 revision。
> 这个选择避免给 incomplete 文件附带可用于猜测隐藏片段的原文 hash。
> 它也沿用现有 `redactedHash`、mutation ordering、receipt 和 latest-value 存储。

来源：`docs/researches/2026-10-18-bot-mode-m0-memory-intent.md:298`–`305`。

> | 新字段或派生值 | 位置 | 谁写 | 谁读及用途 |
> | --- | --- | --- | --- |
> | `format` | decoded `snapshot.redactedBytes` 根对象 | device SDK | Host 校验 profile。未知 profile 不能开启编辑。 |
> | `files[].path` | 同一 JSON 的文件项 | device SDK，只取自本次 snapshot 的 `file.path` | Host 绑定展示文件及 intent.path。仅允许 memory 相对路径。 |
> | `files[].content` | 同一文件项 | embedder redactor 产出展示文本；SDK 校验后封装 | 记忆页展示。只能携带 policy 允许的内容。 |
> | `files[].contentComplete` | 同一文件项 | device SDK 在本次 snapshot 上进行 hash 比较 | Host 仅在 true 时计算编辑基线并允许普通全文编辑。redactor 不能自报 true。 |
> | `editViewFormat` | 本地 `AgentMemoryProjectionGrant` 及 Host 对应的授权记录 | Host 授权方 | device SDK 与 hosted receiver 确认允许该 profile，包括相对路径及可能的完整原文披露。缺省为未授权。 |
> | 编辑基线 `baseRevision` | Host/UI 的视图元数据；不是新增 wire 字段 | Host 对 complete 文件的 `utf8(content)` 求 sha256 | Host 用它生成 intent。incomplete 文件不生成编辑基线。 |

来源：`docs/researches/2026-10-18-bot-mode-m0-memory-intent.md:315`–`322`。

> 1. **同一采集。** SDK 在现有 home lease 下捕获文件。redactor 输入、展示内容关联和 complete 判定来自同一份 snapshot。不得为判定重新读取磁盘。否则可能把旧内容配上新文件状态。
> 2. **权威不变。** device 仍是内容权威。complete 文件的 Host 基线等于 `sha256(utf8(display))`，也等于本次 snapshot 的 `file.revision`。Host 必须把该值绑定到用户实际看到的内容。最终是否可写仍由 live CAS 判定。
> 3. **正文与证明一起校验。** `redactedHash` 覆盖整个 profile JSON，包括 path、content 和 complete 标记。hosted store 必须先校验 hash，再校验 profile。相同 mutationId 不能替换任一字段。receipt 继续绑定同一个 redactedHash。incomplete 文件不含 sourceRevision 或其他原文 hash。
> 4. **比较点固定。** 在 `snapshotAndProjectAgentMemory` 内，`captureAgentMemorySnapshot` 返回后、`outbox.append` 前计算 complete：`packages/client/src/daemon/agent-memory.ts:947-948`。输入为同次 `snapshot.files[]` 的 path/revision、redactor 按 path 关联的展示文本、grant 的 `editViewFormat`。SDK 先拒绝未知 path、重复 path 和非 well-formed Unicode 文本；再从 snapshot 取 `file.path`，判定 `sha256(utf8(display)) === file.revision`。redactor 的 path 仅用于查找，不是输出 path 的权威。该判定依赖既有 sha256 revision 契约，不依赖 native 原始 buffer，因此适用于 native 与 helper 的同一 snapshot 接口。缺少展示项就不导出该文件。
> 5. **默认只读。** false、缺少字段、旧 profile、缺少 grant 或未知 format 均不能开启普通全文 replace。Host 不把 `[redacted]` 一类占位符拼回原文。incomplete 文件的显式整文件替换仍可走 CAS §B，但用户必须知道可能覆盖隐藏内容。该动作的 conflict receipt 仍可返回 observed；这不是向 projection 增加 hash，也不能变成普通编辑器的自动 rebase。
> 6. **不自动 rebase。** conflict 只结束旧 intent。Host 不把 observed 套到用户旧草稿上。用户需取得新视图后重新编辑；或明确发起覆盖未展示内容的整文件替换。两种路径均生成新 intent 和新 digest。
> 7. **存在性明确。** 每个文件项代表采集时存在的文件。完整空文件由 Host 算出 EMPTY。文件不在列表不代表它不存在。新建 note 仍需显式选择 absent-or-empty 语义。缺失 note 的 delete conflict 不能记作 applied。
> 8. **披露是显式例外。** `contentComplete=true` 意味着原文全文出站。它证明完整性，不授予披露权限。grant 与 embedder policy 必须先允许这份全文发给该 Host。incomplete 文件不导出原文 hash。绝对路径、cwd 和未经 policy 允许的正文仍禁止。现有 `rawSnapshotBytes` 与 candidate 的透传比较（`agent-memory.ts:768-779`）不会命中带新 format/字段的 edit-view JSON，因此对该 profile 失效，不能作为保护。后续切片必须修订 `packages/protocol/src/agent-memory-projection.ts:53-57` 与 `packages/client/src/daemon/agent-memory.ts:85-87` 的注释，并测试新的授权边界。旧 profile 的限制不因此放宽。

来源：`docs/researches/2026-10-18-bot-mode-m0-memory-intent.md:380`–`389`。

> ### PRD 需同步修改的位置
>
> 以下只列建议，不在本轮改 PRD：
>
> - §5.3.2 的 `:212`：把 EMPTY bootstrap 限定为已授权的 absent-or-empty/整文件替换，不称为通用读取。
> - §5.3.2 Host 交付物的 `:214`：把「baseRevision 探测」改成「edit-view 完整性证明、Host 派生基线、保存后视图与显式替换」。
> - §10 P5 范围的 `:383`：同步替换「baseRevision 探测」，加入整体超限失败、ContextPack 旧投影/阻塞分支和保存后基线前移的验收。
>
> 以上行号均指 `docs/adr/ADR-039-bot-mode-product-prd.md`。
> P5 只在该契约落地后开放普通全文编辑。隐藏内容的局部修改仍需另行定义 device-side patch 或本地编辑流程；本稿没有实现或承诺该能力。

## R2

原报告 commit：`c7407c74596c7ea2475b216b56d73a8196f593da`。以下内容从该 commit 读取。

来源：`docs/researches/2026-10-18-bot-mode-m0-platform-gap.md:26`–`26`。

> **共享缺口：新 home/`.byok` 的目录项持久化尚未证明。** `packages/client/src/agent-home.ts:280` 的 mkdir 后没有父目录 sync。Linux native 声明的 `B=true` 也依赖这些目录已经持久建立。P2-mac 负责共享初始化修复，并补 Linux 回归；P2-win 接入自己的屏障实现。当前没有足以豁免 Linux 的理由。

来源：`docs/researches/2026-10-18-bot-mode-m0-platform-gap.md:45`–`53`。

> ### 2.2 三端差距表
>
> 每格描述当前实现。Linux 的“可用”仍要求 home、transport 等配置成立。平台名本身不是授权。三端都存在新目录持久化的共享缺口，不能把 Linux 写成“差距：无”。
>
> | 平台 | `memory_recall/save` 的文件写入权威 | Intent 两项证明 | `agent-memory-intent.v1` 广播 |
> |---|---|---|---|
> | Linux | 可用。要求 `O_NOFOLLOW`、`O_DIRECTORY`、`O_NONBLOCK` 和 `/proc/self/fd`。read/save 共用 descriptor backend。配置外部 helper 则被 constructor 拒绝。`packages/client/src/daemon/agent-memory.ts:176`、`:186`、`:268`、`:284`；`packages/client/src/daemon/create-daemon.ts:1322-1323`。 | native backend 声明 `C=true, B=true`。冲突检查在 rename 前；内部 strict write 不吞目录 sync 错误。普通 memory save 的目录 sync 则容忍 `EINVAL/EPERM`，不要混淆。**缺口：新 home/`.byok` 的 mkdir 没有父目录 sync；当前 `B=true` 依赖同一未证实前提。** `packages/client/src/agent-home.ts:280`。`packages/client/src/daemon/agent-memory-intent.ts:168`；`packages/client/src/daemon/agent-memory.ts:272`、`:298`、`:321`、`:353`、`:370`。 | 有条件广播：Host transport、Agent home/manager、安全 filesystem、`B=true`、实际 hostStorageRoot 目录 sync probe 成功。不是所有 Linux 自动广播。此 probe 只证明 sync 调用可用，不能补写已经遗漏的新目录父级屏障。`packages/client/src/daemon/create-daemon.ts:4157`、`:4165`、`:2167`、`:1070`。 |
> | macOS | 配置产品部署的 Go helper 后可用。没有 helper 时不提供 Node 路径 fallback。协议 2 核验 leased-root identity。`packages/client/src/daemon/agent-memory.ts:183`、`:186`；`packages/client/src/daemon/agent-memory-fs-helper.ts:40`、`:128`、`:139`。 | helper backend 固定 `C=false, B=false`。Go 源码已有 pre-rename revision checks 和 `Sync()`，但 TS 没有把任意部署产物绑定到这些实现。`packages/client/src/daemon/agent-memory-intent.ts:178`；`packages/client/native/agent-memory-fs/main.go:385`、`:414`、`:425`、`:445`、`:755`。 | 不广播。`B=false` 在 backend 选择时返回 `undefined`。真实入口拒绝 notice，发生在 fetch 前。只有人为授予 `B=true` 的现有证据测试会继续运行并把 conflict 报成 uncertain。`packages/client/src/daemon/create-daemon.ts:4164`；`packages/client/src/daemon/agent-memory-intent.ts:546`；`packages/client/src/__tests__/agent-memory-intent.test.ts:1914`。 |
> | Windows | 不可用。TS 平台门关闭；constructor 拒绝 helper；Go open 也关闭。即使删掉这些门，TS 的 Unix identity 握手仍不匹配 Windows tag。`packages/client/src/daemon/agent-memory.ts:183`；`packages/client/src/daemon/agent-memory-fs-helper.ts:40`、`:51`、`:148`；`packages/client/src/daemon/create-daemon.ts:1322-1323`；`packages/client/native/agent-memory-fs/main.go:312`。 | 没有 admitted backend。不能在 Windows 使用名字为 native 的 Linux证明常量。helper 函数仍给 `C=false, B=false`；Windows identity 实现本身不证明 CAS 或持久化。`packages/client/src/daemon/agent-memory-intent.ts:168`、`:186`；`packages/client/native/agent-memory-fs/identity_windows.go:17`。 | 不广播。安全 filesystem 门先返回 false。迟到的 notice 被 `filesystem_unavailable` 拒绝。`packages/client/src/daemon/create-daemon.ts:4160`；`packages/client/src/daemon/agent-memory-intent.ts:546`；`packages/client/src/__tests__/agent-memory-intent.test.ts:1986`。 |

来源：`docs/researches/2026-10-18-bot-mode-m0-platform-gap.md:120`–`139`。

> ### 4.3 怎样证明产品部署的二进制
>
> 推荐最小方案：helper 是 SDK 发布物。它放在 client 包内，或放在与 client 固定版本绑定的平台 optional 包内。SDK 按 OS/arch 自己解析路径，不再接受产品提供的任意 `helperBin`。加载时按 SDK 构建清单比对 digest，**只用于发现错误部署**。不扩展到同一用户恶意改写整个 SDK 的威胁模型。
>
> | 候选 | 能证明什么 | 判断 |
> |---|---|---|
> | SDK 自建并发布 helper，加载时比对构建 digest | 固定源码、toolchain、OS/arch、构建参数和测试结果可对应到 SDK 发布物；发现错版本、错架构或错误部署。 | 主方案。产品分发 SDK 包；路径与清单都由 SDK 管理。签名方案见下表。 |
> | 运行时自证 | 在实际 home 卷上探测所需 sync、handle 和文件系统能力。 | 只作环境补充。不能靠版本自报或几个 challenge 证明任意程序的全部行为。协议与根 identity 校验照旧，但不是产物证明的替代物。 |
> | 仓库对 Go 源码跑测试 | 证明该源码在固定 runner/toolchain 上的行为。 | 必需但不充分；还需测试发布及安装产物。交叉编译不代替目标 OS 执行。 |
>
> 产品重签与 whole-file SHA-256 有冲突。macOS 应用的签名/notarization 发布流程可能重签嵌入 helper；Windows 产品可能加或替换 Authenticode。这些**重签操作会改 bytes**。notarization 服务本身不等于重签。P2 开工时须选择以下方案，不得在 digest 不匹配时静默放行。
>
> | 解法 | 范围与限制 |
> |---|---|
> | A：SDK 签名，产品禁止重签 helper（推荐起点） | SDK 对签名后的最终文件生成 whole-file digest。产品打包保留这些 bytes。先验证目标产品的 `.app` / Windows 安装流程能保留嵌入签名，否则不能选择此方案。 |
> | B：允许产品重签，明确可比对范围 | Windows 比对 **Authenticode PE image hash**，不使用 whole-file hash；使用标准算法排除签名相关字段。它是部署一致性检查，不是签名信任验证。macOS 另定并审查可比对的 Mach-O 内容范围；未定前不能宣称支持重签。两端都要用真实重签前后样本证明允许的变化不误报、代码变化能被发现。 |
>
> Microsoft 说明 Authenticode PE hash 排除 checksum、Certificate Table 等签名相关内容。[Microsoft PE 签名说明](https://learn.microsoft.com/en-us/windows/win32/secbp/understanding-pe-signatures)。这提供解法 B 的 Windows 算法依据，不能推导出 macOS 的算法。
>
> 可复现构建固定 Go 1.26.5、依赖、GOOS/GOARCH、CGO 设置和其余 build flags。必用 `go build -buildvcs=false -trimpath`。从两个不同绝对路径构建未签名产物并比较 bytes；签名及时间戳另记为发布步骤，不能宣称签名产物天然可复现。构建清单显式记录源码 revision/摘要、参数、签名策略和该策略对应的 digest。

来源：`docs/researches/2026-10-18-bot-mode-m0-platform-gap.md:237`–`245`。

> 2. 固定本地 NTFS 支持域，执行 §5.3 矩阵。同时验证同卷 handle-relative replace、文件内容 flush 和上述 namespace/双槽候选。所有失败显式返回。不得把需要 admin 的 volume flush 当普通用户产品的默认方案。
> 3. 用原生故障注入和真实进程终止测试，验证 `applying → CAS → terminal → complete/readback → ackedAt` 顺序及重启不重放。这只提供 process-crash 证据。若保持 OS-crash 契约，另需对应平台依据与恢复实验。
> 4. 依据实验收敛后端及 spec。原 whole-file rename 不足时，选择有界的 ledger 修订；也要分别证明 memory 目标的持久化。不能吞目录 flush 错误，不能把未获批准的较弱实现标成严格 B。
>
> 最坏情况反例：`applying` 文件内容已经 flush，但 rename 的 namespace 未被证明持久；随后 memory CAS 已执行；OS crash 后 ledger 回到旧版本。重发时 processor 看不到记录。若内容后来又回到相同 baseRevision，则 CAS 可再次成功。只比较当前内容 hash 无法排除此情况。这就是“file flush 成功”不充分的原因。
>
> 更强的反例**不需要 ABA 或第二次 CAS**：terminal `applied` 的 rename 没有持久化，但 `complete`、Host readback、`ackedAt` 和 cursor 推进均已返回成功。OS crash 后，memory 与 ledger 一起回退到旧内容。Host 仍记着 `applied`，cursor 又阻止该 notice 重发。设备和 Host 的事实已分裂。除 ledger 外，必须证明 memory 目标在对外确认前的持久化；只防重复执行不足以保护 applied 的含义。已开 [Ancienttwo/byok-sdk#522](https://github.com/Ancienttwo/byok-sdk/issues/522) 跟踪。
>
> 不要从 spec 的另一段借用许可：`docs/spec.md:2209` 至 `:2216` 的 “Windows flushes writable file handles; Node provides no directory-flush equivalent” 描述的是 **message outbox、reliable spool、cursor save 和 log compaction**。它不是 Agent-memory intent ledger 的 Windows 后端契约。P2 要在 Durable Agent homes 的 intent 段定义自己的保证。

来源：`docs/researches/2026-10-18-bot-mode-m0-platform-gap.md:324`–`326`。

> **PLAUSIBLE，未复现：超时后 lease 可能先于 helper 退出而释放。** `agent-memory-fs-helper.ts:225-229` 的超时回调 reject 后调 `fail()`；`:280-284` 只发送 kill。`close()`（`:191-200`）也不等待退出。`agent-memory-intent.ts:590-592` 在 close 后立即释放 lease，且吞 close 错误。若旧进程仍在完成 ledger rename，下个窗口可能取得 lease 并启动新 helper。严格 full sync 延长 I/O，可能更易触发 10 秒 timeout。这是源码推断，不是实测竞争。已开 [Ancienttwo/byok-sdk#521](https://github.com/Ancienttwo/byok-sdk/issues/521) 跟踪，不挂在本单。
>
> 该发现的复现、修复和关闭以 #521 为准。本文保留超时窗口的验收依赖，不在本单指定修法。

来源：`docs/researches/2026-10-18-bot-mode-m0-platform-gap.md:448`–`456`。

> ## 9. P2 应采用的文档修订草案
>
> 以下文字是建议，不改变当前产品契约。
>
> **PRD §5.3.3 的 Linux 行：** “memory_recall/save 使用 native descriptor backend。intent 有条件广播：transport、home、安全 filesystem、strict backend 和目录 probe 都须满足。差距：新 home/`.byok` 创建后缺父目录 sync，当前 B=true 依赖未证实的共享前提；P2-mac 一并修共享初始化与 Linux 屏障，并跑 Linux 回归。不得继续标注‘差距：无’。”
>
> **PRD §5.3.3 / P2-mac：** “Go helper 已通过 `File.Sync()` 尝试 Darwin `F_FULLFSYNC`。P2 消除严格路径降级，补三端共享的新目录屏障。helper 纳入 SDK 包，由 SDK 解析路径和检查部署 digest，实际 home 卷另做能力探测。产品重签策略须先选定。只有产物、初始化、卷能力和退出/lease 边界均通过证明，backend 才能声明 intent proof。”
>
> **PRD P2-win / 风险前三条：** “Windows 开放包括 TS 平台门、TS/Go tagged identity、Go open admission、Node/Bun 空 env 启动、真实 reparse 矩阵和 NTFS ledger 后端。现有 Windows 测试只覆盖 identity 形状与关闭入口。spec 故障模型决策稿与矩阵从开工起并行；若只达到 process-crash/文件级保证，须 owner 明确接受，不能直接沿用 strictLedgerBarrier=true。断电后 Host 保留 applied、设备 memory 与 ledger 一起回退的问题，已开 [Ancienttwo/byok-sdk#522](https://github.com/Ancienttwo/byok-sdk/issues/522) 跟踪。未决或未证实仍阻塞 v1。v1 helper 目标为 darwin-arm64/x64、win32-x64/arm64。”

## R3

原报告 commit：`e5dcdd0de0ce14f888cc7e1632e0418c6837f452`。以下内容从该 commit 读取。

来源：`docs/researches/2026-10-18-bot-mode-m0-outcome-routine.md:12`–`17`。

> 已定（Aimpact，2026-10-18）：
>
> 1. 上限默认值：§2.5 的表作为 v1 的提议值。这些值仍是提议值，本文不把它们标为已定。
> 2. schedule 用结构化字段，不用 cron 字符串（§3.1）。
> 3. server 的 wake 上限改为 368 天：改 `MAX_FUTURE_MS` 和 `wakes.test.ts` 的两处断言，实现 PR 逐条说明（§7）。
> 4. 同一 routine id 的版本切换（生效版本和待切换版本、调度 generation、在途上限）归 K8a；K4 保持定义不可变（§3.7）。

来源：`docs/researches/2026-10-18-bot-mode-m0-outcome-routine.md:49`–`60`。

> - 探针直接从源码引入 `checkResultSchema`、`validateResultOutcome`（`packages/protocol/src/result-schema.ts`）和 `TerminalProjectionSelectionSchema`（`terminal-projection.ts`）。校验库是锁定的 `@cfworker/json-schema@4.1.1`。
> - `maxLength` 数码点：库里 `ucs2length` 把一个代理对算作 1（`node_modules/.bun/@cfworker+json-schema@4.1.1/.../dist/esm/ucs2-length.js`）。
> - canonical 大小是 `JSON.stringify` 的 UTF-8 字节数（`plain-json.ts:139-156`）。孤立代理被拒（`result-schema.ts` `hasLoneSurrogate`）。所以一个码点最多 6 字节：除 `\b\t\n\f\r` 外的 C0 控制字符写成 `\u00XX`。4 字节 emoji 是 4 字节。
> - 探针 `bound.ts` 按下表算子集 schema 的**保守上界**（canonical 字节数）。`worstCaseInstance` 生成见证实例：每个允许的属性都在（只列名字的 `oneOf` 分支取最大的那个），每个数组填满，每个字符串填满 U+0001。见证实例交给 `validateResultOutcome`。v4 的 schedule 写法下，群发言变体的见证实例等于上界；普通 Bot 和 Main Bot 变体的见证实例比上界小 54 字节（每份 schedule 27 字节，§2.5）。保守上界不保证有等长的合法见证。一般 schema 不保证能达到：`oneOf` 分支重叠或约束相交时，最大值可能没有合法实例。
>
> | 节点 | 最坏字节数 |
> |---|---|
> | `const` | 值的 canonical 字节数 |
> | `enum` | 最长值的 canonical 字节数 |
> | `string` 带 `maxLength` n | 2 + 6n；没有 `maxLength` 时没有有限上界 |
> | `number` | 25，不需要 `minimum`/`maximum`。有限双精度的最长表示是定点负小数，例如 `-0.0000012345678901234567`；指数形式最长 24（`-1.7976931348623157e+308`） |
> | `integer` | 24（指数形式）；定点最长 22（`-999999999999999900000`）。只有两端都存在、并且绝对值都小于 1e21 时，收紧为两端十进制长度的较大者 |

来源：`docs/researches/2026-10-18-bot-mode-m0-outcome-routine.md:304`–`310`。

> | 字符串的形状 | `pattern` | 拒绝 | 不需要。schedule 是 `integer` 字段加星期名 `enum`，范围由 `minimum`/`maximum` 当场校验；tz 是 Host 填的 `enum`。子集看不到的组合（4 月 31 日、2 月 29 日）由 Host 应用时调 core 的 `checkRoutineSchedule` |
> | 时间戳 | `format` | 拒绝 | 不需要。outcome 里没有绝对时间 |
> | 去重（`to`、`members`、选项 id、槽位、`daysOfWeek`） | `uniqueItems` | 拒绝 | Host 应用时去重或拒绝。`daysOfWeek` 的重复项不算错误：Host 存储前去重，core 也按集合处理 |
> | `update_*` 至少改一项 | `minProperties` / `anyOf` | 拒绝 | Host 把空改动当作拒绝的动作 |
> | 草稿的大小 | `maxProperties` | 拒绝；`{type:'object'}` 能准入，但没有结构上界 | 草稿 schema 要有有限上界，组合函数检查最坏 ≤ 16 384 字节。封闭对象是最小的写法；`const`、`enum` 也有有限上界 |
> | 一个数组里每种动作的个数 | `contains` / `maxContains` | 拒绝 | 每种动作一个字段，各自 `maxItems`（F4） |
> | 共享定义 | `$ref` / `$defs` | 拒绝 | 片段函数在 JS 里复用，产出展开的 schema |

来源：`docs/researches/2026-10-18-bot-mode-m0-outcome-routine.md:333`–`347`。

> | 字段 | `maxLength` | 最坏字节 | 3 字节中文约 | PRD v2 的值 | 关系 |
> |---|---|---|---|---|---|
> | `delegate[].request` | 1 000 | 6 002 | 3 000 | ≤ 8 KiB | 满足 |
> | `ask_user.question` | 400 | 2 402 | 1 200 | 未定 | 新定 |
> | `ask_user.options[]` | 2–6 项；id 24、label 80 | — | — | 未定 | 新定（clarification 先例是 2–8 项、id 100、label 500） |
> | `confirmable_action[].summary` | 300 | 1 802 | 900 | ≤ 300 字 | 相同 |
> | `confirmable_action[].draft` | Host schema | ≤ 16 384 | — | ≤ 16 KiB 对象 | 改为有有限上界的 Host schema |
> | `schedule` | `minute` 0–59、`hour` 0–23、`daysOfWeek` 1–7 项、`dayOfMonth` 1–31、`month` 1–12（`integer` 的 `minimum`/`maximum`，不是 `maxLength`） | 上界 128；最大合法实例 101（每周分支，7 个星期项，tz 取 enum 最长值 `Asia/Shanghai`） | — | — | 新定 |
> | `create/update_routine.prompt` | 500 | 3 002 | 1 500 | ≤ 4 KiB | 满足 |
> | `speech.text`（post） | 2 730 | 16 382 | 8 190 | ≤ 16 KiB | 满足 |
> | `create/update_bot.name` / `role` / `persona` | 40 / 80 / 300 | — | — | 未定 | 新定 |
> | `create/update_room.name` / `announcement` | 40 / 300 | — | — | 未定 | 新定 |
> | `team_note.text` | 300 | 1 802 | 900 | ≤ 300 字 | 相同 |
>
> 个数上限（PRD v2 没有定）：`delegate` 2、`ask_user` 1、`confirmable_action` 1、`create_routine` 1、`update_routine` 1、`cancel_routine` 2、`create_bot` 3（平台 PRD §14.2 "一次建 3 个 Bot"）、`update_bot` 1、`delete_bot` 1、`create_room` 1、`update_room` 1、`team_note` 1、`room_call.members` 4、群成员 12（平台 PRD §9.1）。

来源：`docs/researches/2026-10-18-bot-mode-m0-outcome-routine.md:367`–`385`。

> Main Bot 变体：61 709 + 12 个键共 161 字节 + 12 个冒号 + 11 个逗号 + 2 个括号 = **61 895 ≤ 65 536**，余量 3 641 字节。普通 Bot 变体 43 261。群发言变体 16 710（`speech` 16 405、`room_call` 281）。三个变体的见证实例都通过 `validateResultOutcome`，字节数是 43 207 / 61 841 / 16 710。schema 大小：6 534 / 14 665 / 1 473 字节，都在 `RESULT_SCHEMA_MAX_BYTES = 16 384` 以内。
>
> schedule 的 `integer` 字段两端都低于 1e21，所以按两端的十进制长度收紧：`minute`、`hour`、`dayOfMonth`、`month` 每个 2 字节。v4 的 schedule 把字段放在外层 `properties`，`oneOf` 分支只列名字。保守分析器按外层封闭对象计，所有字段同时出现，上界 128 字节。合法实例不能同时有 `daysOfWeek` 和 `dayOfMonth`，最大的是 `{"minute":59,"hour":23,"daysOfWeek":["mon",…7 项],"tz":"Asia/Shanghai"}`，101 字节。所以每份 schedule 的上界比最大合法实例多 27 字节，上界仍是可靠的上限。Host 草稿里有无范围的数值字段时，按 25 / 24 字节计。
>
> 上表的码点和个数上限是 v1 的**提议值**（决定 1）。本文不把它们标为已定。
>
> schedule 的三种写法（探针 §2、§2b、§2c，Main Bot 变体，2 个时区）：
>
> | 写法 | 一份 schedule 的 schema 字节 | 一份 schedule 的 outcome 上界 | Main Bot schema | Main Bot 能放的 64 字符 routine id 数 | 坏组合在哪里拒绝 |
> |---|---|---|---|---|---|
> | v3：三个封闭分支，每个分支重复全部字段（只作对照） | 1 119 | 101 | 15 027 | 18 | schema |
> | v4 `checked`：字段放外层，`oneOf` 分支只列名字（本稿采用） | 938 | 128 | 14 665 | 20 | schema，模型在执行内改正 |
> | `flat`：外层封闭对象，没有 `oneOf`（§2.6 的预算退路） | 605 | 128 | — | 25 | Host 应用时，模型下一次执行才知道 |
>
> `checked` 和 v3 写法在探针 §2c 的 12 000 个 schedule 实例上判定完全相同（36 个合法，0 个不同）。`checked` 里 tz enum 只出现一次，所以每多一个时区，Main Bot 的 schema 多 2 × (区名字节数 + 3) 字节（实测 2 个时区 14 665，8 个时区 14 871）。schema 余量的主要消耗是 routine id：`update_routine` 和 `cancel_routine` 各有一份 enum，每个 64 字符 id 多 134 字节。
>
> 这些余量只对所测的 Host 上下文成立，不是最坏情况。按 12 个 Bot、每个 Bot 暂定 8 个 routine，Main Bot 同时枚举 96 个 64 字符 routine id 时，`checked` 是 26 336 字节，`flat` 是 25 670 字节，都超过 16 384（探针 §2b）。超限时按 §2.6 处理。
>
> 这个证明依赖 Host 填的 enum 长度。所以组合函数在冻结前重新算上界，超过 65 536 就拒绝（探针 §6：`delegateMaxItems` 改成 4 时报 `over-budget — largest outcome is 74069 bytes`）。草稿 schema 也在片段函数里单独检查（开放草稿报 `unbounded`，3 000 码点正文报 `18011`）。

来源：`docs/researches/2026-10-18-bot-mode-m0-outcome-routine.md:393`–`398`。

> 1. 组合函数分开报三种错误：`not-subset`（schema 不在 K7 子集里）、`schema-over-budget`（schema 超过 `RESULT_SCHEMA_MAX_BYTES`，K7 返回 `over-cap`）、`over-budget`（outcome 上界超过 `RESULT_OUTCOME_MAX_BYTES`）。
> 2. Host 先只放这次执行需要的动作片段和这次执行可见的对象。
> 3. 只有 `schema-over-budget` 允许 Host 把两个 routine 片段改为 `scheduleShape: 'flat'` 后重新组合。`not-subset` 和 `over-budget` 不触发这个退路，它们是 Host 的缺陷或上限设置问题。
> 4. 退路在冻结 offer 之前完成。冻结后的 schema 不再改变。
> 5. 用了 `flat` 后仍是 `schema-over-budget`：Host 显式阻塞这次执行并显示原因，或者执行它已定义的分批选择流程（例如这次执行只列一部分 routine，并在 ContextPack 里说明）。Host 不静默截断授权对象的 enum。
> 6. 用 `flat` 时，`daysOfWeek` 和 `dayOfMonth` 同时出现、只有 `month` 这两种组合由 Host 应用时的 `checkRoutineSchedule` 拒绝（探针 §5c：`flat` 接受，`checked` 拒绝，Host 报 `schedule_invalid`）。

来源：`docs/researches/2026-10-18-bot-mode-m0-outcome-routine.md:409`–`427`。

> schedule = {
>   minute: integer 0–59,
>   hour: integer 0–23,
>   daysOfWeek?: ('mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun')[],   // 1–7 项
>   dayOfMonth?: integer 1–31,
>   month?: integer 1–12,
>   tz: Host 填的 enum,
> }
> ```
>
> 语义：
>
> - 每个匹配的本地日期上，有一个本地时点 `hour:minute`。结果是本地整分钟。
> - 没有 `daysOfWeek`，也没有 `dayOfMonth`：每天。
> - 有 `daysOfWeek`：只在列出的星期几。
> - 有 `dayOfMonth`：只在每月的这一天。再有 `month`：只在这个月的这一天，也就是每年一次。
> - `daysOfWeek` 和 `dayOfMonth` 不能同时出现。`month` 必须和 `dayOfMonth` 一起出现。
> - `dayOfMonth` 是 29、30、31 并且没有 `month` 时合法，没有这一天的月份跳过。没有"每月最后一天"的语义。
> - 一个 schedule 每天最多一个时点。每天几个时点就建几个 routine。"每 N 小时"和"每月最后一天"不在 v1 里。

来源：`docs/researches/2026-10-18-bot-mode-m0-outcome-routine.md:869`–`869`。

> Host 应用时的动作序号：平台 PRD 的 `H(A.taskId, 动作序号)` 改为 `H(taskId, kind, 数组下标)`。Host 按固定顺序在一个事务里应用：`create_bot` → `update_bot` → `delete_bot` → `create_room` → `update_room` → `team_note` → routine 三动作 → `confirmable_action` → `ask_user` → `delegate`。新建对象先于引用它的动作。

来源：`docs/researches/2026-10-18-bot-mode-m0-outcome-routine.md:928`–`931`。

> - 已定（决定 3）。`packages/server/src/wakes/types.ts:42`：`MAX_FUTURE_MS` 从 `366 * 24 * 60 * 60_000` 改为 `368 * 24 * 60 * 60_000`。这是放宽校验，不改 SQLite schema，不改类型。
> - `packages/server/src/__tests__/wakes.test.ts` 有两处边界要改：`:48` 的拒绝边界 `NOW + 366 * 86400000 + 1` 改为 368 天加 1 毫秒；`:58` 的接受边界 `NOW + 366 * 86400000` 改为 368 天。两处都是测试断言改动，理由是 §3.5 的实测，PR 描述里要逐条说明。
> - Host 侧还要有超视界政策（§3.5）。server 不加任何重试逻辑。
> - server 不依赖 core 的常量。spec 写明两个值相等，core 的测试断言 `ROUTINE_HORIZON_MS === 368 * 86_400_000`。

来源：`docs/researches/2026-10-18-bot-mode-m0-outcome-routine.md:1005`–`1008`。

> > | `confirmable_action` | `action`（Host 提供的动作名之一）、`summary`（≤ 300 码点）、`draft`（该动作的 Host 草稿 schema，有有限上界，最坏 ≤ 16 KiB） | 所有 Bot | 建确认卡。用户确认后，Host 用自己的凭据执行这个动作；Bot 不直接执行有后果的动作 |
> > | `create_routine` | `localId`（Host 槽位）、`schedule`（结构化字段，见本文 §3.1）、`prompt`（≤ 500 码点）、`target`（只在 Main Bot 的 schema 里，默认是自己） | 所有 Bot；`target` 指向别人只有 Main Bot | 用 `checkRoutineSchedule` 校验 schedule，失败就拒绝这个动作并写进下一次 ContextPack；落 routine 账本，算下一个时点，调 `wakes.schedule`（§12；本文 §3.7） |
> > | `update_routine` | `routineId`（Host 枚举）、可选 `schedule`、可选 `prompt` | routine 的 owner 或 Main Bot（PRD v2 §5.2） | 没有改动时拒绝。校验 schedule；写新的定义版本，当前 occurrence 完成后切换（§12.3 第 6 条）。同 id 的版本切换由 K8a 实现 |
> > | `cancel_routine` | `routineId`（Host 枚举） | 同 `update_routine` | `lifecycle = completed`，取消已调度的 wake；运行中的执行不自动停止，要停时 Host 显式调用 `tasks.cancel`（§12.7） |

来源：`docs/researches/2026-10-18-bot-mode-m0-outcome-routine.md:1030`–`1042`。

> > `occurrence_key = SHA-256(routine_id, definition_version, 计划时间)`。这个 key 在账本中唯一。trigger 类型（`scheduled` 或 `catch_up`）在第一次提交时判定并持久化，重投读回这个决定，不按这次投递时间重算。
>
> **§12.3 第 6 条**后加："定义版本区分生效版本和待切换版本。有在途 occurrence 时，新版本先记为待切换，在途的那次按旧版本快照完成后再切换；没有在途 occurrence 时立刻切换。暂停后恢复也服从这个条件。调度操作经 outbox 执行，带调度链代数，过期的操作不执行。这些由 K8a 的 `update_routine` 实现；K4 的不可变定义参考实现不提供这个操作。"
>
> **§12.4 加一条共同恢复规则**（K4 和 K8a 都实现）："outbox 只有一个消费者，按持久序号执行同一 routine 的操作，迟到的取消不能删除之后重新调度的同一个 wake。日历计算抛错时，在同一个事务里记审计、停止后继、状态 `calendar_error`，hook 正常返回，不触发重投；UI 显示原因，恢复入口是进程启动、用户重试和新的定义版本。"
>
> **§12.4 第 6 条**，原文：
>
> > 时区存在定义里。用一个纯函数计算时点，设备和服务端共用。这样两边算出同样的期望时间。
>
> 改为：
>
> > 时区存在定义里。时点用 `@byok-sdk/core` 的 `nextRoutineOccurrence(schedule, now)` 计算，设备和服务端共用。设备上的 Host 进程算出的时点是调度用的唯一权威；服务端用同一个函数算期望时间，只用于可见性。时区只用两端都认识的规范名。

来源：`docs/researches/2026-10-18-bot-mode-m0-outcome-routine.md:1054`–`1068`。

> > | K8 Bot 协作参考实现 | 新 issue，正文取 §9。K8-S：`@byok-sdk/protocol` 的 outcome 片段和组合函数、`@byok-sdk/core` 的 routine 时点纯函数、server wake 上限 368 天。K8a：参考实现里同一 routine id 的版本账本（生效版本和待切换版本、调度链代数、在途上限）和对应测试，不属于 K8-S。参考实现放在 `examples/` | K4（K8-S 不依赖 K4） | §14.2；K8-S 定向测试；K8a 版本管理场景（本文 §8） |
>
> **§13.1 spec 修改列表的 K8 条**，原文：
>
> > - K8：只改 `examples/` 和文档。参考实现暴露出 SDK 缺口时另开 issue，不在 K8 里改 SDK。
>
> 改为：
>
> > - K8：K8-S 新增 spec「Bot turn outcome fragments and routine time points」一节，修改「Embedded wake queue」的 366 天和「Durable Pi lane」的周期规则句子。K8 的其余部分只改 `examples/` 和文档。参考实现暴露的其他 SDK 缺口另开 issue。
>
> **§13.1 回滚列表**加一条：
>
> > - K8-S：发布前直接 revert。发布后按 release notes 处理，不留兼容层（O10）。已冻结在 offer 里的 schema 不受影响。
>
> **§13.1 每阶段检查**的 "K7 还要运行 `bun run check:release-pack`" 改为 "K7 和 K8-S 还要运行 `bun run check:release-pack`"。

## R4

原报告 commit：`0d9955e1e60880353cc2f8bd2a07ef301116bf61`。以下内容从该 commit 读取。

来源：`docs/researches/2026-10-18-bot-mode-m0-aiphabee-inventory.md:5`–`7`。

> > 真相源：`/Users/chris/Projects/aiphabee`，`main@2eae75c74192a7ea76490cf9c9409a6e625d1444`（2026-10-18 16:04:20 +0800，工作树干净，与 `origin/main` 一致）。与任务给的预期 HEAD `2eae75c7` 一致。
> > 方法：只读。没有 install、build、测试，没有改 aiphabee。下文的 `file:line` 都相对 aiphabee 根目录，SDK 的路径标 `byok-sdk`（本 worktree，基线 `8e8839a3`）。其他 `aiphabee-*` 目录只作对照，引用时写目录名。
> > 证据等级：标 `(verified)` 的是本次读到的代码或命令输出。标 `(inferred)` 的是从代码推出、没有运行验证的结论。标 `(未核验)` 的是本次没有闭合的项。

来源：`docs/researches/2026-10-18-bot-mode-m0-aiphabee-inventory.md:30`–`38`。

> - 执行入口是 `ResearchPassHost.execute`。它用 K5 `server.executions.submit` 提交（`apps/local-agent/src/research-pass-host.ts:391`）。(verified)
> - 它校验 offer 类型必须是 `task.offer_for_agent_with_egress_fresh`，否则 fence 住 host（`research-pass-host.ts:526-532`）。这是 ordinary fresh lane。prepared lane 是另一种消息类型 `task.offer_prepared`，带 `preparation` 和 `agentMemory`（byok-sdk `packages/protocol/src/messages.ts:400-430`）。(verified)
> - payload 里没有 `preparation`，没有 `agentMemory`（`research-pass-host.ts:697-699`）。(verified)
> - Pi 的 BYOK 选择是 `dispatchSelection.lane: "byok-profile"`（`research-pass-host.ts:45-53`）。按 SDK spec，这条路启动的是 ordinary `byok-pi-rpc` host，凭据走 launcher 的 IPC（byok-sdk `docs/spec.md:2461`）。(verified：代码字段；lane 归类 inferred 自 spec)
> - runtime 不固定为 Pi。chat turn 和 workbench Agent 任务用同一条规则：设备上选了 runtime 就用它（Claude、Codex 或 Pi，用各自的登录）；没选才用 bundled Pi 加默认 BYOK profile（`apps/local-agent/src/connected.ts:1584-1600`、`:1680-1684`；`local-bot-chat.ts:76`）。daemon 的 `runtimeAllowlist` 是 `["claude","codex","pi"]`（`research-pass-host.ts:742`）。这是现状。PRD Q8 已定 v1 只 Pi，现状不改变这个决定。(verified)
>
> ### 1.2 记忆工具现在怎么接
>
> - 没有接 SDK 记忆工具。SDK 在 ordinary lane 上注入 `byokagentmemory` 有三个条件：有 `agentRef`、解析到 memory MCP bin、`isAgentMemorySecureFilesystemAvailable(helperConfigured)` 为真（byok-sdk `packages/client/src/daemon/task-runner.ts:3413-3415`）。这个函数在 Linux 原生为真；在 darwin 只有配了外部 helper 才为真；在 Windows 永远为假（byok-sdk `packages/client/src/daemon/agent-memory.ts:176-184`）。Aiphabee 没有配 helper（见第 2 项），用户设备只登记 macOS 和 Windows（见第 8 项）。所以用户设备上的 chat turn 拿不到 `memory_recall`/`memory_save`。(inferred：由代码条件推出，没有在设备上运行)

来源：`docs/researches/2026-10-18-bot-mode-m0-aiphabee-inventory.md:169`–`175`。

> #512、#513 的主线链路（verified，issue 状态由 `gh issue view` 读出）：
>
> 1. Bot 执行没选 runtime 时，用设备默认模型 profile（`connected.ts:1591-1599`、`:1680-1684`）。
> 2. 默认 profile 必须有 `pi_model`，否则抛 `LOCAL_MODEL_PI_CONFIG_REQUIRED`（`apps/local-agent/src/providers.ts:850-864`）。xAI 没有预设，用户要手写 `pi_model`。
> 3. SDK keys 把 `openai_compatible` profile 一律投影成 `api: "openai-completions"`（byok-sdk `packages/keys/src/pi-provider-projection.ts:58-68`）。xAI 在 vendor 目录里就是 `openai_compatible`（byok-sdk `packages/keys/src/provider-catalog.ts:90`）。所以 xAI 请求只能走 Chat Completions。这是 #512（OPEN）。
> 4. `PiModelConfigSchema.compat` 是 strict，没有 `supportsLongCacheRetention`，也没有 `inputLimits`（byok-sdk `packages/keys/src/pi-model-config.ts:7-25`）。所以 Aiphabee 不能从 pi-ai 的 xAI catalog 生成预设。这是 #513（OPEN）。
> 5. 影响：主线现在可以手配 xAI 走 Chat Completions，但 tool calling 是否可用没有验证。Bot 用 Grok 回复按 PRD §7 要等 #512、#513 关闭。

## R5

WO-05 已推送。使用固定 commit 的 [owner 裁定](https://github.com/Ancienttwo/byok-sdk/blob/e5afad26b42108cb4aa5b14f9f674291bc168b81/examples/host-execution-core/VALIDATION.md#L268-L273) 和 [取消后 attempt 读回](https://github.com/Ancienttwo/byok-sdk/blob/e5afad26b42108cb4aa5b14f9f674291bc168b81/examples/host-execution-core/README.md#L76-L79)。`tasks.cancel` 返回值不改的裁定原文见 R0。

## R6

使用 WO-05 固定 commit 的 [下游服务、版本管理和合成验收边界](https://github.com/Ancienttwo/byok-sdk/blob/e5afad26b42108cb4aa5b14f9f674291bc168b81/examples/host-execution-core/README.md#L120-L130)。WO-05 v3 的裁定原文见 R0。

## R7

群聊默认行为沿用已推送的产品 PRD v2。预算沿用同一基线的平台 PRD。此次只把它们写成可测试的矩阵。隐私、后来加入成员的可见范围、长记录策略和 Q5/Q6 保持待裁定。

来源：`docs/adr/ADR-039-bot-mode-product-prd.md:181`–`181`。

> **群聊（修订二，Aimpact 已定）**：默认模式是"未被点名不发言"。席位只来自 UI 的结构化 mention 或 outcome 的 `room_call`。平台 PRD §9.5 的 `admin` 模式降为可选。预算默认值不变。成员失败或没交 outcome 显示为失败，不算 PASS。

来源：`docs/researches/2026-10-13_bot-platform-prd.md:567`–`567`。

>    - 点名来自 UI 传来的 botId 列表，或 outcome 里的 `room_call`。Host 不扫描正文里的 `@名字`。

来源：`docs/researches/2026-10-13_bot-platform-prd.md:568`–`568`。

>    - 只有用户或 admin 可以点全体。

来源：`docs/researches/2026-10-13_bot-platform-prd.md:569`–`569`。

> 4. 默认预算取自 DeepSeek Bot 的实际值：一轮的发言上限是初始席位数加 4，有 admin 时再加 4；每个成员一轮最多 2 次，admin 最多 4 次；用户不说话时，Bot 最多自己开 3 轮；晚到发言最多 10 条。

固定参考：[产品 PRD v2](https://github.com/Ancienttwo/byok-sdk/blob/8e8839a3/docs/plans/2026-10-18-bot-mode-product-prd.md#L181)、[平台 PRD 原预算](https://github.com/Ancienttwo/byok-sdk/blob/8e8839a3/docs/researches/2026-10-13_bot-platform-prd.md#L569-L570)。
