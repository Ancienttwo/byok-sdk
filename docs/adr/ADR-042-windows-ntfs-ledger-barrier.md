# ADR-042：Windows / NTFS strict ledger barrier（WO-09a 决策稿）

> **来源**：PR [#527](https://github.com/Ancienttwo/byok-sdk/pull/527)；跟踪 issue [#605](https://github.com/Ancienttwo/byok-sdk/issues/605)。决定：选 model S；§3 定义结果，§7 是可失败验收；`docs/spec.md` 和 `docs/protocol.md` 引用这两节。
> **移入**：#1291 把本文从已退役的 plans 目录（`2026-10-19-windows-ntfs-ledger-barrier-decision.md`，原标题「WO-09a：Windows / NTFS strict ledger barrier 决策稿」）移到这里。正文未改；只把指向已移走或已删除文件的链接改为新位置或合入它的 PR。

状态：Aimpact 已选 S；Windows 证明仍 BLOCKED。日期：2026-10-19。

本稿记录 spec 决策。它不批准 Windows admission，也不修改现行契约。
当前结论：Windows 的 `B` 保持 `false`。`agent-memory-intent.v1` 不开放。
Aimpact 于 2026-10-19 选择 S。故障集合包括 process crash、OS crash 和断电。
支持域限本地 NTFS、明确 OS build、普通用户 token。排除 SMB、同步目录和其他 FS。
storage 必须兑现完整 flush。磁盘毁坏、谎报 flush 和备份回滚仍不在条件承诺内。
S 尚未获证明。这项裁定不授予 B，也不完成 Q14。WO-09 保持 BLOCKED，直到按 §7 证明 §3。
P/F/R 只作为未采用方案保留。原建议、选项和依据见 §6。
Microsoft 已说明文件数据和 metadata 的 flush 语义。缺口是把这些语义绑定到本后端的完整操作和恢复结果。
不能把“本单未证明 namespace barrier”写成“NTFS 无法提供 durability”。依据：[M1]、[M2]、[M4]；调用证据见 §2。

## 1. 决策范围与证据规则

裁定来源：Aimpact 于 2026-10-19 的 doc-honesty 修订指令。原文节录：

> Windows fault model S is CHOSEN (2026-10-19) but UNPROVEN; B=false; WO-09 stays BLOCKED.

同一裁定记录见 [WO-09 文档的状态与支持域](https://github.com/Ancienttwo/byok-sdk/blob/f11fe428d136b6afcd7cfb9172f3e60724a5ff2e/docs/plans/2026-10-19-windows-ntfs-ledger-barrier-decision.md#L3-L11)。

远端问题依据：[issue #522](https://github.com/Ancienttwo/byok-sdk/issues/522)。
issue #522 在本次读取时没有评论。它是风险记录，不是本单完成的 Windows 故障复现。

源码基线：[8e8839a3](https://github.com/Ancienttwo/byok-sdk/tree/8e8839a38524d5323bb32011edc7392c80df528f)。
下文的仓库 `file:line` 均指该基线。

原工单与 WO-02 v3 调研稿未随本 PR 发布。下面内联本稿使用的原文节录，读者无需访问本机文件或本地 Git 对象。
这些节录是任务范围和先前调研结论，不是 Aimpact 的故障模型裁定。

**原工单 WO-09a：**

> 目标：写出 Windows 故障模型的 spec 决策稿，和矩阵并行（WO-02 v3 §5.4，#522）。
>
> 范围：NTFS 下 strict ledger barrier 的定义、能证明到哪一级（process-crash / 文件级 / 断电）、`FlushFileBuffers`/`NtFlushBuffersFileEx` 的可用性、B 保持 false 的条件、owner 要接受的弱化故障模型选项。
>
> 验收：Aimpact 能据此选一个故障模型；每个结论有 Microsoft 文档或实测引用。
>
> WO-09（代码）等 WO-09a 的故障模型被接受。

**WO-02 v3 §1：共享目录缺口。**

> 共享缺口：新 home/`.byok` 的目录项持久化尚未证明。 `packages/client/src/agent-home.ts:280` 的 mkdir 后没有父目录 sync。Linux native 声明的 `B=true` 也依赖这些目录已经持久建立。P2-mac 负责共享初始化修复，并补 Linux 回归；P2-win 接入自己的屏障实现。当前没有足以豁免 Linux 的理由。

**WO-02 v3 §4.3：部署产物证明。**

> 最小交付链：固定源码/toolchain/参数 → native 测试 → SDK 包内产物 → 所选签名策略与清单 → packed/install 测试 → SDK 解析路径并检查部署 → 实际 home 卷能力探测。

**WO-02 v3 §5.4：barrier 与未裁定状态。**

> 定义先于 boolean。 在声明支持的 OS、文件系统和故障模型内，一次成功 ledger write 必须使完整下一状态成为可恢复权威。至少要求：`applying` 成功之后即使进程中断，恢复不能把它读成“从未尝试”；terminal 成功之前不 complete；`ackedAt` 成功之前不 resolve。损坏或无法判断时拒绝继续，不能把 ledger 重置为空。
>
> 证据和决定未齐前，`B=false`、capability 不开放；Q14 本身不批准削弱 at-most-once。

证据分为三类：

- **文档事实**：Microsoft 文档直接说明的 API 行为。引用使用 `[M*]`。
- **调用观察**：在上述基线读取的代码与契约。引用使用仓库路径和行号。
- **推论或提案**：由前两类证据得到的边界或规则提案。它们不是 Windows 实测结论。

本机是 macOS arm64。本单没有 Windows runner、OS-crash 实验或物理断电实验。
§7 的用例是验收要求，不是通过记录。

## 2. P1 map / P2 trace / P3 decision

### P1 map：真实边界

| 边界 | 本次调用观察 |
|---|---|
| 契约 | `docs/spec.md:1872` 要求 `applying`、terminal、`ackedAt` 的持久化顺序。`:1878` 要求 ledger 包含 directory fsync。`docs/protocol.md:978` 定义相同的 admission。 |
| proof | `packages/client/src/daemon/agent-memory-intent.ts:153` 区分 `C=conflictProvesNoRename` 与 `B=strictLedgerBarrier`。`:165` 明确成功写入须覆盖 temp fsync、rename、directory fsync。helper 在 `:194` 固定 `B=false`。 |
| 广播与入口 | `packages/client/src/daemon/create-daemon.ts:4157` 检查 transport、home、安全 filesystem、B。native backend 另做目录 sync probe。processor 在 `agent-memory-intent.ts:546` 于 fetch 前拒绝缺少 B 的 backend。 |
| 实际 ledger 写入 | `agent-memory-intent.ts:622` 的 `writeLedger` 调用 strict whole-file rewrite。`packages/client/src/daemon/agent-memory.ts:353` 在 helper 存在时委托普通 `filesystem.replace`。没有另一个 strict RPC。 |
| Go filesystem | `packages/client/native/agent-memory-fs/main.go:409` sync 临时文件，`:421` rename，`:425` sync parent。`:755` 用 `Open(".")` 再 `Sync()`。Windows `openSession` 在 `:311` 仍关闭。这段 parent sync 不是已通过的 Windows 方案。 |
| 新目录 | `packages/client/src/agent-home.ts:280` 的 mkdir 后没有父目录屏障。新 home、`.byok`、新 `notes` 子目录都必须纳入证明。§1 内联的 WO-02 共享目录节录记录了该缺口。 |

### P2 trace：一次 intent 的实际顺序

1. 持有 home lease，读取 ledger。已有 `applying` 只转成 `uncertain`，不再执行 CAS。见 `agent-memory-intent.ts:675`。
2. fetch 后校验 identity、digest 和内容。首次执行先写 `applying`。写失败则 CAS 次数为 0。见 `:884`。
3. 执行一次 memory replace/delete。观察结果一致才生成 `applied`。见 `:891`。
4. 成功写 terminal 后才调用 Host `complete`。见 `:908`、`:927`。
5. Host readback 匹配后写 `ackedAt`。该屏障成功后 handler 才能返回。见 `:950`、`:973`；`create-daemon.ts:2517`。

关键点：Host 在第 4 步已经持有完成事实。
第 5 步的本地 `ackedAt` 不能补救第 4 步之前缺少的 memory 或 terminal durability。
这是调用顺序的推论；Windows cache 丢失的机制依据 [M3]、[M4]。

### P3 decision：保留的核心不变量

`e869cca28d44948dbe5ae24d322d62ac1463bf3d` 引入当前 intent 路径。
其代码和现行协议用 durable `applying` 阻止重复 CAS，用 durable terminal 支持完成重传。
所以最小决策是先确定故障集合，再证明操作顺序。
单独打开 Windows 开关会绕过现有证明边界。
依据：`docs/protocol.md:912`、`:917`、`:947`；[M3] 对 volatile cache 的说明。

本稿保留单 writer lease、pinned handle、内容 CAS 和本地 memory 权威。
`C=true` 不能替代 B。B 也不证明 path containment 或冲突前未 rename。
`docs/spec.md:2215` 的 Windows 文件 flush 句子属于 message outbox、spool 和 cursor。
它不授权弱化 Agent-memory intent。以上是现有代码与契约的边界观察。

## 3. strict barrier 的结果定义

以下为拟议定义。它用恢复结果定义 barrier，不要求在 NTFS 上复制 POSIX API 名称。
若采用，须同时修订 `docs/spec.md`、`docs/protocol.md` 和 B 的接口说明。
当前“directory fsync”原文仍有效。

令 `F` 为 owner 接受的故障集合。一次成功 barrier 必须满足：

1. **完整性**：恢复能取得完整下一状态，或后续已确认状态。不得把坏 ledger 重置为空。
2. **先行记录**：成功写 `applying` 后发生 `F` 内故障，恢复不能把该 intent 当作未尝试。允许恢复为 `uncertain`。
3. **结果先行**：发送 `applied` 前，memory 新内容或删除结果及其名称关系已满足 `F`。terminal 也已满足 `F`。
4. **确认顺序**：Host durable readback 匹配后，`ackedAt` 满足 `F`，才允许 cursor 推进。
5. **失败关闭**：任何必要屏障失败都不是成功。CAS 前失败不执行 CAS。CAS 后失败不得报告无修改的 conflict。terminal 屏障失败不得 complete。
6. **合法回收**：只回收已持久 `ackedAt` 的旧记录。回收后仍依赖 immutable Host terminal fetch，不能重新 release 同一 intent。见 `docs/protocol.md:912`、`:958`、`:1003`。

第 3 条也适用于 memory delete。只 flush 已写文件的内容，不能证明“原文件不再以该名称存在”。
此处的 namespace 包括 temp → target replace、target → tombstone、tombstone remove，以及新目录链。
这是本后端操作与 [M2]、[M3]、[M5] 的推论，不是另加一个内容存储。

最坏情况的充分条件是以下先后关系。`durable_F` 包含内容、必要 metadata 和可恢复名称关系：

`durable_F(applying) → CAS → durable_F(memory result) → durable_F(terminal) → Host complete/readback → durable_F(ackedAt) → cursor`

证明分三个窗口：

- CAS 前崩溃：没有外部确认。已成功的 applying 阻止再次 CAS。
- CAS 后、terminal 前崩溃：恢复最多报告 uncertain。它不再执行同一 CAS。
- Host complete 后崩溃：memory 结果和 terminal 已先持久。Host 可重传同一完成事实。失去尚未成功的 ackedAt 只导致重复确认。

以上是条件证明。它依赖每个 `durable_F` 的平台证据、Host durable receipt 和单 writer。
它不保证未来合法编辑不能改变该文件。
底层 flush 能处理数据和 metadata，但不是跨文件事务；依据 [M2]、[M4]。

## 4. Microsoft API 能证明什么

### 4.1 FlushFileBuffers

**文档事实**：这是 user-mode Win32 API，来自 `Kernel32.dll`。
最低 client 为 Windows XP。文件 handle 须有 `GENERIC_WRITE`。
失败返回 0，须读取 `GetLastError`。volume handle 可 flush 全卷，但调用者须有管理员权限。[M1]

**文档事实**：Microsoft 说明 metadata 也会被 cache，并指示用文件 flush 将其写盘。[M3]
Microsoft 的 storage 说明指出，该 API 会发送 `FLUSH_CACHE`。
它也说明设备或设置可能使该请求失效。[M4]

**推论**：成功的完整文件 flush 可以支持文件级 durability。
不能称它“只能防进程崩溃”或“只刷用户数据”。
但 temp handle 在 rename **之前**的 flush，不能证明**之后**发生的 rename。
本调用链还缺少对 replace/delete、新目录链和实际 handle 的完整证明。[M1]、[M3]、[M5]

### 4.2 NtFlushBuffersFileEx

**文档事实**：Nt 页面列出 Windows 8 为最低 client。
它列出的 header/library/DLL 是 driver 的 `ntifs.h`、`NtosKrnl.lib`、`NtosKrnl.exe`。
这张表不是 Go user-mode helper 的链接说明。[M2]

不能由 driver 页面推出 user mode 不可调用。
Zw 页明确说 user-mode 调用应使用 `NtFlushBuffersFileEx` 名称。[M7]
因此它是可调查的 native API 路径。
本单没有验证目标 Windows 的 `ntdll.dll` export、调用绑定或普通用户 handle 的成功结果。
“OS 名称符合最低版本”不等于部署路径已可用。
具体 export、签名和 flag 支持须在目标 build 检查；不能假定每个后来列出的 flag 都在 Windows 8 可用。最后两句是证据限度，不是 API 不存在的断言。

| Flags | Microsoft 的同步范围 | 本稿判定 |
|---|---|---|
| `0` | 文件 data + metadata；同步底层 storage cache。 | 完整 flush 候选。仍须绑定实际 handle 和恢复结果。 |
| `FLUSH_FLAGS_FILE_DATA_ONLY` | data；不写 metadata；不 flush storage cache。 | 不足以满足完整 barrier。 |
| `FLUSH_FLAGS_NO_SYNC` | data + metadata；不 flush storage cache。 | 不足以满足断电模型。 |
| `FLUSH_FLAGS_FILE_DATA_SYNC_ONLY` | data + 读取数据所需 metadata；flush storage cache。只支持 NTFS；不得用于 directory 或 volume handle。 | 不是 directory flush 的替代证明。 |

本表依据 [M2]。`Parameters=NULL`，`ParametersSize=0`，`IoStatusBlock` 必须有效。
该调用是同步操作。错误如 `STATUS_ACCESS_DENIED` 必须返回失败。
Nt flags=0 的说明较完整，但仍没有给本 helper 自动附加一个跨文件事务。[M2]

### 4.3 namespace 候选与边界

| 候选 | 文档事实 | 决策边界 |
|---|---|---|
| 文件 write-through | NTFS 会 flush 由 write-through 请求产生的 metadata，文档举例包含 rename。[M5] | 不能忽略这项正面依据。须证明本实现的 rename 请求、handle 和 flags 确实落入该保证。普通 `os.Root.Rename` 没有因此自动取得这项证明。 |
| rename 后对仍固定的文件 handle 做完整 flush | 文件 flush 可写 metadata。[M3] | 可调查。须说明覆盖旧目标替换、父目录关系和错误窗口的依据。delete 后只 flush 原文件不是完整删除证明。尚无本单实验。 |
| writable directory handle + 完整 flush | `CreateFileW` 可用 `FILE_FLAG_BACKUP_SEMANTICS` 打开目录。该 flag 不绕过普通权限检查。[M5] | 能打开目录不等于 flush 已支持。不得把当前只读 `Open(".")` 当作已验证实现，也不得声称所有 Windows 目录 flush 必然失败。 |
| `MoveFileExW(MOVEFILE_WRITE_THROUGH)` | 文档说等待文件移到 disk，并专门说明 copy/delete 的 flush。[M6] | 是正面依据。该 API 接收路径。采用前须保留 pinned-root 安全和同卷 replace 语义。不得以跨卷 copy/delete 替代现有 CAS。 |
| `ReplaceFileW` | `REPLACEFILE_WRITE_THROUGH` 不受支持。部分失败可改变文件名称或属性。[M8] | 该 flag 不能补齐 barrier。失败不能统一映射成“什么都没改”。 |
| volume flush | 有公开 API；要求管理员权限。[M1] | 可用于专用受管部署或实验。不是普通用户 SDK 的默认解法。不得每个 intent 临时提权。 |
| 固定双槽 ledger | 对预建文件可做 data/metadata flush。[M2]、[M3] | 这是后端提案。尚无实现或实测。须证明首次建槽、torn write、generation 和恢复选择。它不解决 memory rename/delete。 |

## 5. 证明等级与 B=false 条件

| 级别 | 能作出的承诺 | 仍缺的证明 |
|---|---|---|
| process-crash | 只终止 helper/daemon，OS 和 storage 继续运行。恢复按 ledger 保持 at-most-once。 | 必须验证进程终止窗口、helper 已退出才释放 lease、完整 ledger 读取。cache 仍在，所以该测试不能证明 OS crash 或断电。[M3] |
| 文件级 | 完整 flush 已将该文件 data 和 metadata 交给遵守请求的 storage。 | 须另证明各次 namespace 变化与跨文件先后关系。它不是一个独立的完整故障模型。[M1]、[M2]、[M4] |
| OS-crash | 内核或系统突然中断后仍满足 §3。 | 须有完整操作的平台依据和突然重启恢复实验。正常 reboot 不模拟此故障。[M3] |
| 断电 | 主机及 volatile storage cache 同时失去电力后仍满足 §3。 | 还须证明 storage 栈兑现 flush，且未禁用 cache flush。磁盘毁坏、谎报 flush 和备份回滚不在此条件承诺内。[M4] |

本单达到的是“文档支持文件级完整 flush；当前 Windows backend 仍未 admitted”。
本单没有获得上表任何新的 Windows 运行通过记录。
OS-crash 与断电可使用同一条件契约，但两者的实验覆盖不能互换。

出现以下任一条件，现有 B 必须保持 false：

1. S 所需的 spec/protocol 修订尚未完成。
2. 只有 temp 文件 flush、可见 readback 或 process kill 证据；没有所选模型的完整恢复证明。[M3]
3. 使用 data-only/no-sync 作为强模型的必要屏障，或吞掉 flush/权限/不支持错误。[M1]、[M2]
4. ledger 的 rename、memory replace/delete 或新目录链仍有一项未覆盖。[M3]、[M5]
5. 只证明 ledger 双槽不回退，没有证明 `applied` 对应的 memory 结果。[M2]、[M4]
6. 依赖 admin volume flush，但实际部署使用普通用户 token。[M1]
7. helper 发布物、实际 home 卷、普通用户权限或目标 OS API 未被验证。不得用源码测试替代部署证明。见 §1 内联的 WO-02 部署产物节录；[M1]、[M7]。

`B=false` 时继续禁止广播和执行 intent。不得把 `uncertain` 当作屏障失败后的通行证。
写 uncertain terminal 也需要有效 barrier；否则保留 cursor 并报告 `local_io_failed`。
这是 `agent-memory-intent.ts:635`、`:687`、`:909` 的现有行为。

## 6. 故障模型选项与裁定记录

以下保留裁定前的建议和选项，作为决策记录。Aimpact 已于 2026-10-19 选择 S。
S 尚未获证明，B 仍为 false。P/F/R 未采用。

原建议：建议选择 S，保留强故障模型。若选择 P/F，须接受系统故障后的永久分裂风险，并修改 Host admission。

| 选项 | owner 接受的准确含义 | v1 与 B 的后果 |
|---|---|---|
| S：保留强模型（已选；原建议） | 覆盖 process-crash、OS-crash、断电；假设 storage 兑现完整 flush。支持域先限本地 NTFS、明确 OS build、普通用户 token。排除 SMB、同步目录、其他 FS、磁盘毁坏和备份回滚。 | WO-09 必须证明 §3。失败时阻塞 Windows intent，不能以 Linux-only 完成 Q14。证明齐全并修订 API 表述后才可授予 B。依据 [M2]、[M4]、[M5]。 |
| P：仅 process-crash | OS 与 storage 在 helper/daemon 故障期间继续正常工作。保留应用进程恢复与 at-most-once；明确排除系统 crash、突然重启和断电。仍执行并检查所有约定 flush。 | owner 接受系统故障后永久 Host/device 分裂风险。现有 B 继续 false，直到 spec、protocol 与 Host admission 明确采用较弱模型。依据 [M3] 和下述反例。 |
| F：接受文件级保证 | 每次成功写有完整文件 flush，但 namespace recovery 未获证明。 | 这不是完整 strict 模型。若 owner 仍选择它，必须明确接受系统故障后 lost apply、重复 CAS 及无自动修复。不得单凭“文件已 flush”授予现有 B。依据 [M1]、[M2]、[M5]。 |
| R：系统故障后先 reconcile | 允许尚未 reconcile 的完成事实过时。重启后先暂停新 intent，独立于设备 ledger/cursor 向 Host 枚举需核对的已完成意图。 | 这是另一个协议方案。须另定保留期、断点、内容来源、合法后续编辑及冲突规则。仅启动时检查本地 ledger 不够。现有代码和 B 均不具备该证明。依据 [M3] 的 cache 损失机制；现有缺口见 #522。 |

P 与 F 的成本必须写成产品承诺，不能只写成技术限制。
正常关机或 UPS 可以降低风险，但不使未证明的 namespace 顺序成立；storage 不兑现 flush 的边界见 [M4]。

**#522 的条件反例**：

1. 设备完成 memory CAS，并在 cache 中写 terminal applied。
2. Host durable complete/readback 成功。设备写 ackedAt，cursor 前移。
3. 若相关 namespace 尚未持久，系统故障后 memory 和 ledger 一起回到旧状态。
4. Host 仍认为 applied。旧 notice 不再投递。没有自动路径使内容回到已确认结果。

这不需要 ABA，也不需要第二次 CAS。
即使手工重新 enqueue，现有 terminal fetch 路径也可用零 memory 写入直接 resolve。
所以“重发 notice”不是 reconcile。
这是 `docs/protocol.md:958` 的调用推论；第 3 步是 [M3] 的 cache 损失机制与未证明 namespace 的组合。
它是允许状态的反例，不是本单测得 NTFS 必然回退的结论。

另一个窗口位于 CAS 后、Host complete 前。
若 applying 名称回退丢失，Host 尚无 terminal，重发可再次 release。
若内容回到相同 baseRevision，CAS 可再成功。hash CAS 不证明历史上从未执行。
依据：`agent-memory-intent.ts:863`、`:887`、`:891`；[M3]。

若选择 P 或 F，须同时记录 Q14 的新验收文字。
Q14 原文要求三端证明进入 v1；它没有接受上述弱化风险。
当前 wire capability 只有 `agent-memory-intent.v1`，没有 failure-model 字段。
不能让已按强契约接入的 Host 静默接受较弱设备。
WO-09 开始前须确定 Host 的明确 opt-in 和兼容边界；仅本地布尔配置不足。
依据：`docs/adr/ADR-039-bot-mode-product-prd.md:443`、`docs/protocol.md:978`。

裁定记录：Aimpact 于 2026-10-19 选择 S。故障集合、支持域和 storage 假设见开头。
WO-09 可继续矩阵和原语实验，但完成 §7 证明前保持 BLOCKED，不能开放 Windows intent。

### 可并入 spec 的拟议文字

S 已选。完成 §7 证明后，在 Durable Agent homes 的 intent 段采用以下文字。
同步替换 `docs/protocol.md` 的 advertisement 限制和 B 的注释。
本稿保留现行 spec 文件，等待 §7 证明。

> A backend may advertise Agent memory intents only after it proves a durable barrier for its stated OS, file system and storage profile. On Windows, the profile is local NTFS with storage that honors flush requests. The barrier covers process failure, OS failure and power loss. It covers the ledger bytes, memory result, required metadata and name changes, and new parent directories. The device commits applying before CAS. It commits the memory result and terminal before Host completion. It commits ackedAt after matching Host readback and before cursor advance. An error blocks the next step. File flush alone is not proof of the full sequence. Windows remains disabled until this proof is complete.

此为项目要求的提案。其 flush 能力和 storage 前提来自 [M1]—[M5]，不表示 Microsoft 为本 SDK 的完整序列作了保证。

## 7. WO-09 所需的证据与可失败验收

| 验收项 | 成功断言与证据范围 |
|---|---|
| API 可用性 | 固定 Windows build、NTFS volume identity、helper digest、普通用户 SID/token。记录 handle access/share/open flags、API、flush flags、返回码和 IO status。缺 export、不支持 flag 或拒绝访问均失败，不降级。[M1]、[M2]、[M7] |
| namespace 原语 | 分别验证新建 ledger、已有 ledger replace、memory replace、delete、首次 home/`.byok`/notes 目录。保留 pinned-root 与 reparse 矩阵。一次目录 flush 成功只证明调用可用，不单独证明断电恢复。[M3]、[M5] |
| 确定性错误注入 | 在每个实际屏障前后注入失败。CAS 前失败断言 CAS=0、complete=0。memory 已变而屏障失败不得返回 applied/conflict。terminal 屏障失败断言 complete=0。ackedAt 失败不得推进 cursor。spy 必须委托真实 API，mock 成功不是平台证明。 |
| process-crash | 每个 §3 窗口终止 helper/daemon；等待进程退出再释放 lease。重启后 applying 不重放，terminal 完成可重传，坏 ledger 不清空。覆盖 replace/delete、fresh/existing home、Node/Bun。此项只验 P。[M3] |
| OS-crash | 用专用可丢弃 Windows 环境作突然系统中断。在独立 Host 留存已收到 complete 的时点和 digest。恢复后逐项核对 §3，不以正常 reboot、guest 进程 kill 或读取旧 cache 代替。虚拟磁盘/宿主 cache 假设单独记录。[M3]、[M4] |
| 断电 | 在可丢弃设备上，覆盖已声明 storage 栈的掉电恢复。若只切 VM 电源，结论仅适用于该虚拟 storage profile。记录设备 cache、flush 设置、断点、次数、结果。单次通过不是所有硬件证明。[M4] |
| #522 回归 | 注入设备 memory+ledger 同时回退、Host terminal 和 cursor 保留。强模型须用平台依据排除该已确认状态回退，并以恢复实验支持。R 则须发现分裂并停止新写入，不能因 cursor 或 ledger 无记录而跳过核对。 |

每个被支持操作都要有“API 契约 → 实际调用 → 顺序 → 恢复断言”的链。
有条件的平台证明与故障实验共同支持结论。
有限次数 crash 测试不能证明任意硬件永不失败；也不能以缺少实验为由否认文档已给出的文件级保证。

## 8. Microsoft 引用索引

以下链接在 2026-10-19 读取。引用只使用 Microsoft 文档与 Microsoft 工程说明。
本稿没有把 Microsoft Q&A 的用户回答作为 API 契约。

- [M1] [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)：Parameters、Remarks、Requirements。文件写权限、返回码、volume 管理员条件与 Win32 可用性。
- [M2] [NtFlushBuffersFileEx](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntflushbuffersfileex)：Parameters 的四种 Flags、Return value、Remarks、Requirements。
- [M3] [File Caching](https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching)：Windows cache、突然故障时未 flush 数据丢失、metadata flush。
- [M4] [Revised notes on the reliability of FlushFileBuffers](https://devblogs.microsoft.com/oldnewthing/20170510-00/?p=95505)：Microsoft 工程说明。讨论 FLUSH_CACHE、NTFS metadata、硬件和关闭 flush 的设置。它不替代具体 API 文档。
- [M5] [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)：Caching Behavior、Directories、Physical Disks and Volumes。包括 write-through 的 metadata/rename 说明和目录 handle 条件。
- [M6] [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)：MOVEFILE_WRITE_THROUGH、MOVEFILE_COPY_ALLOWED、MOVEFILE_REPLACE_EXISTING。
- [M7] [ZwFlushBuffersFileEx](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-zwflushbuffersfileex)：Remarks 明确 user-mode 应使用 Nt 名称。Flags 细节采用较完整的 [M2]，不混用两页的表。
- [M8] [ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)：REPLACEFILE_WRITE_THROUGH 不支持；Return value 列出部分失败状态。

## 9. 本单验证记录

本机：macOS arm64，Node `v24.21.0`，Bun `1.4.3`。
仓库 packageManager 固定 `bun@1.4.2`；本次记录是本机 Bun 1.4.3 的结果，不是该版本 CI 的复验。
`bun ci` 返回 exit 0。没有改 lockfile、产品代码或测试。

| 命令 | exit code | 用时 |
|---|---|---|
| `bun run build` | 0 | 17.18 s |
| `bun run typecheck` | 0 | 9.68 s |
| `bun run test` | 0 | 880.63 s |
| `bun run check:api-surface` | 0 | 9.62 s |
| `bun run check:version-authority` | 0 | 0.10 s |
| `git diff --cached --check` | 0 | 不计时 |

Vitest 合计 9,288 passed、200 skipped。cloud-do 的 Node tests 另有 10 passed、0 failed。
其中 client 为 3,992 passed、30 skipped；cloud-dataplane 为 94 passed、139 skipped。
本次没有启动可选 Docker dataplane substrate。所有 skipped 项均不计作已验证。
这些本机 suite 结果不证明 Windows barrier。

文档核对通过：M1—M8 的 ID 齐全；所有显式 `file:line` 目标存在；本分支只增加本稿。
M1—M8 的 8 个 Microsoft URL 均返回 HTTP 200。程序逐项检查了所引关键条款，人工核对了含义与推论边界。
上述表格和计数是实现时日志的内联摘录。关键输出如下，仅移除对齐空格。
这些摘录保留当次结果，不表示本次文档修订又运行了整套测试。

```text
@byok-sdk/client:test | Test Files 343 passed | 1 skipped (344)
@byok-sdk/client:test | Tests 3992 passed | 30 skipped (4022)
@byok-sdk/cloud-dataplane:test | Test Files 10 passed | 33 skipped (43)
@byok-sdk/cloud-dataplane:test | Tests 94 passed | 139 skipped (233)
@byok-sdk/cloud-do:test | ℹ tests 10
@byok-sdk/cloud-do:test | ℹ pass 10
@byok-sdk/cloud-do:test | ℹ fail 0
api-surface: 9 package golden(s) match the built declarations
version-authority: README.md and docs/spec.md agree with the dispatch train 0.27.0 (packages/core/package.json) and @byok-sdk/keys@0.12.0
```

Microsoft 引用检查的原始输出节录：

```text
M1 200 missing=[]
M2 200 missing=[]
M3 200 missing=[]
M4 200 missing=[]
M5 200 missing=[]
M6 200 missing=[]
M7 200 missing=[]
M8 200 missing=[]
```

`missing=[]` 表示所引关键条款的文本检查未发现缺项。它不证明 Windows API 调用或 durability。
读者可直接审查上述摘录和 §8 的 Microsoft 链接，不需要访问原始临时日志。

残留边界：S 已选但尚未获证明；Windows API/普通用户矩阵、OS crash 和物理断电尚无本单实测。
B 保持 false。WO-09 保持 BLOCKED，直到完成 §7 证明。
