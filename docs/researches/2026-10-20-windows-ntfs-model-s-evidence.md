# #522 Windows NTFS model S：已证明与仅论证

状态：model P 在 hosted Windows CI 上有实测证据。OS crash 和断电只有文档论证。B 保持 `false`。
Windows admission 保持关闭。WO-09 保持 BLOCKED。日期：2026-10-20。

本稿接续 [WO-09a 决策稿](../adr/ADR-042-windows-ntfs-ledger-barrier.md)。
引用 `[M1]`—`[M8]` 与该稿 §8 相同。`[M9]` 起为本稿新增。

## 1. 结论

| 项 | 等级 | 证据 |
|---|---|---|
| Go helper 的 NTFS 目录屏障可用 | 已证明（本 runner profile） | admin token 和标准用户 token 均成功；§4 |
| process crash（model P）：每个文件只出现完整旧版本或完整新版本 | 已证明（有限点位） | 63 个固定 kill 点 + 150 次随机 kill；2 种 token × 2 个 job；§4 |
| process crash：Host 已收到 complete 后，设备 ledger 不回退到该 terminal 之前 | 已证明（同上） | 同上 |
| process crash：测试内恢复模型不写 memory | 已证明（只覆盖测试模型） | 恢复专用子进程后 memory 不变；§4。production `settleExistingRow` 未在 Windows 上运行，见 §6 |
| OS crash：§3 的 durable 顺序成立 | 仅论证 | §5 |
| 断电：§3 的 durable 顺序成立 | 仅论证，且依赖 storage 兑现 flush | §5 |
| 新建 home、`.byok`、`notes` 目录链的持久化 | 未覆盖 | §6 |
| Windows containment 和 admission | 未覆盖 | §6 |

model P 的证明不能推出 OS crash 或断电的结论。
进程终止后，OS cache 仍在。[M3]

## 2. P1 / P2 / P3

**P1 map。** Windows 上唯一候选后端是 Go helper（`packages/client/native/agent-memory-fs`）。
macOS 用同一 helper 写 memory 和 ledger（`agent-memory.ts` 的 `replaceAgentMemoryHomeInternalFileStrict`）。
Windows `openSession` 仍拒绝。`sameVolume` 在 Windows 上仍返回错误。
`isAgentMemorySecureFilesystemAvailable` 在 Windows 上仍为 `false`。

**P2 trace。** helper replace：独占 temp → 写 → `strictSync(temp)` → 最终 CAS 读 → `Root.Rename` → `strictSync(parent)`。
helper delete：最终 CAS 读 → rename 到 tombstone → `strictSync(parent)` → remove → `strictSync(parent)`。
processor 顺序：durable `applying` → CAS → durable terminal → Host complete → durable `ackedAt`。见 `agent-memory-intent.ts`。

**P3 decision。** #580 的 run 39390405785 记录：`Root.Open(".")` 的只读目录 handle 不能 flush，NTFS 返回 `Access is denied`。
所以 Windows 上每次 replace/delete 在 rename 后都返回 `io_failure`。这是 fail closed，但 Windows 后端不能用。
最小改动是只修 Windows 的 `platformStrictSync`。调用顺序、CAS、pinned handle 和 admission gate 都不变。

## 3. 改动

`sync_windows.go` 是新文件。`sync_other.go` 的 build tag 从 `!darwin` 改为 `!darwin && !windows`。

- 文件 handle：仍用 `File.Sync`，即 `FlushFileBuffers`。temp handle 以写方式打开。
- 目录 handle：用 `NtCreateFile` 以空名称、`RootDirectory` 为已固定的 handle，重新打开同一目录。
  访问权限为 `FILE_WRITE_DATA|FILE_READ_ATTRIBUTES|SYNCHRONIZE`。选项含 `FILE_DIRECTORY_FILE` 和 `FILE_OPEN_REPARSE_POINT`。
  然后比较两个 handle 的 volume serial 和 file index。不同则失败。相同才调用 `FlushFileBuffers`。
- 这个打开方式不解析路径。Go 的 `Root.Open(".")` 也把 `"."` 变为空名称，相对 root handle 打开（Go `internal/syscall/windows/types_windows.go` 的 `OBJECT_ATTRIBUTES.init`）。
- 第一版用 `ReOpenFile`。run 39403409956 仍得 `Access is denied`。诊断 run 39403994537 分别记录各调用：
  `Root.Open(".")` 的 granted access 为 `0x120089`（只读）。`ReOpenFile` 对五种写权限都返回 `Access is denied`。
  相对 `NtCreateFile` 得到 `0x120116`，随后 `FlushFileBuffers` 和 `NtFlushBuffersFileEx(0)` 都成功。
  `ReOpenFile` 文档只说明 `CreateFile` 创建的 handle。[M9]
- 诊断 run 用的是 `FILE_GENERIC_WRITE`。最终代码只请求 `FILE_WRITE_DATA|FILE_READ_ATTRIBUTES|SYNCHRONIZE`。
  这个最终掩码只由 §4 的 run 验证。`NtFlushBuffersFileEx` 只在 handle 既无 write 也无 append 权限时返回 `STATUS_ACCESS_DENIED`。[M2]
  `FlushFileBuffers` 页写的是 `GENERIC_WRITE`。[M1] 本 handle 没有 `GENERIC_WRITE`，只有 `FILE_WRITE_DATA`。它能 flush，是 [M2] 的推论和 run 的观察。

## 4. 实测

Run：[39407286913](https://github.com/Ancienttwo/byok-sdk/actions/runs/39407286913)，head `5e6848c2`，node 和 bun 两个 job 都成功。
前一次 run [39404884723](https://github.com/Ancienttwo/byok-sdk/actions/runs/39404884723)（head `32168a1e`，无恢复专用检查）也成功。
node/bun 只影响其他 step。两个 job 对 Go kill 测试是同一测试的两次独立运行。
Host：Windows Server 2025 Datacenter，build 26100。C: 和 D: 都是 NTFS。测试用 `GetVolumeInformationByHandleW` 检查实际 temp 卷。
admin step 的 temp 在 C:。标准用户 step 的 temp 在 D:（`RUNNER_TEMP`）。

标准用户：`net user` 新建 `byokntfs`。token 的 BUILTIN 组只有 `Users`（`S-1-5-32-545`）。完整性级别为 Medium。token 中没有 `S-1-5-32-544`。
workflow 断言该 token 和用户名。`Start-Process -Credential` 运行同一个测试二进制。

### 4.1 kill 测试的方法

`crash_windows_test.go` 用子进程重新运行测试二进制。子进程直接构造 session，因为 `openSession` 在 Windows 上拒绝。
子进程按 processor 顺序调用真实的 helper `replace`/`delete`：`applying` → memory CAS → `applied` → 向父进程发 complete → `acked`。
父进程是 Host。它用 `os.Process.Kill`（Windows 上是 `TerminateProcess`）终止子进程，读完管道，再从磁盘读 store。
memory 每版约 104 KB。ledger 每版约 24 KB。每版内容不同，所以撕裂写会表现为 hash 不匹配。
ledger 只有一条记录，不是真实的记录列表。恢复逻辑照 `settleExistingRow`：`applying` 改为 `uncertain`，不再 CAS；terminal 先重写再重发 complete。

每次 kill 后检查：

1. ledger 字节等于某一完整版本的规范编码。
2. memory 不存在，或其 sha256 等于 ledger 记录的 base 或 target。`applied`/`acked` 时必须等于 target。
3. Host 已收到 intent k 的 complete，则 ledger 为 k 的 `applied`/`acked`，或为更晚的 intent。
4. ledger 的 (intent, phase) 不回退。
5. 固定点位还检查确切状态：rename 前为旧版本，rename 后为新版本，complete 只在 `applied` rename 之后出现。
6. 固定点位 kill 后，先运行一个只做恢复的子进程。`applying` 必须变为 `uncertain`，`applied` 必须变为 `acked`。memory 必须不变。
7. 再运行一个子进程，检查它从恢复后的记录开始，完成下一个 intent。

固定点位：每个 helper 写有 5 个点（temp flush 前后、最终 CAS 前、目录 flush 前后）；delete 有 5 个点（最终 CAS 前，两次目录 flush 前后）；complete 发出后 1 个点。
每个 intent 共 21 个点。replace-new、replace-existing、delete 各一组，共 63 个。
随机 kill：先运行一次不 kill，量出启动时间和每个 intent 的时间。之后 150 轮的 delay 在 `[1ms, startup + 3 × perIntent]` 内均匀取值。
测试要求少于一半的 kill 落在 ready 之前，并且 `applying`、`applied`、`acked` 都至少出现一次。

### 4.2 结果

| job | token | 固定点位 | 随机 kill：kill 时 ledger phase | 最终 ledger | Host 收到 applied |
|---|---|---|---|---|---|
| node | admin | 63/63 PASS | applying 80, applied 27, acked 40, uncertain 3；16 次在 ready 前 | intent 248 | 180 |
| node | 标准用户 | 63/63 PASS | applying 73, applied 33, acked 39, uncertain 5；27 次在 ready 前 | intent 215 | 156 |
| bun | admin | 63/63 PASS | applying 76, applied 33, acked 39, uncertain 2；18 次在 ready 前 | intent 282 | 214 |
| bun | 标准用户 | 63/63 PASS | applying 57, applied 40, acked 45, uncertain 8；29 次在 ready 前 | intent 241 | 192 |

恢复专用检查共 240 次：120 次 `applying` → `uncertain`，120 次 `applied`/`acked` → `acked`，memory 全部不变。

`TestWindowsMemoryResultBarrierFailsClosedOnNTFS` 在两种 token、两个 job 中都走成功分支：目录屏障无错误，结果为成功。
#580 时同一测试走失败分支（`Access is denied` → `io_failure`）。测试断言没有改。

每个 intent 的时间：C: 上 31–50 ms，D: 上 7–8 ms。这只是 storage profile 的观察。它不证明 flush 到达介质。

## 5. OS crash 与断电：论证

本节不是实测。hosted CI 不能制造 OS crash 或断电。

### 5.1 单个 helper 写

1. **temp 内容。** `FlushFileBuffers` 写出该文件的全部缓冲信息，handle 须有 `GENERIC_WRITE`。[M1] temp handle 以写方式打开。
   `NtFlushBuffersFileEx` 的 flags 为 0 时，写出文件 cache 中的 data 和 metadata，并让底层 storage flush 其 cache。[M2]
   Microsoft 工程说明：`FlushFileBuffers` 会发送 `FLUSH_CACHE`。[M4]
   推论：temp flush 成功返回后，temp 的 data 和 metadata 已交给 storage，并已请求 storage flush cache。
2. **rename。** Go 的 `Root.Rename` 调用 `NtSetInformationFile(FileRenameInformationEx)`，flags 为 `FILE_RENAME_REPLACE_IF_EXISTS|FILE_RENAME_POSIX_SEMANTICS`（Go `internal/syscall/windows/at_windows.go`）。这是一次 metadata 操作。
   NTFS 维护基于事务的 log 文件。系统故障后，下次启动用该 log 恢复文件系统一致性。[M10]
   推论：故障后，目标名称指向完整旧文件或完整新文件。
   **缺口 G1**：没有 Microsoft 文档直接说 rename 跨崩溃是原子的。`MoveFileExW`、`FILE_RENAME_INFORMATION` 和 NTFS overview 都没有这样写。[M6]、[M10]、[M11]
   Microsoft 推荐“写新文件再替换原文件”作为 TxF 的替代，但没有声明其崩溃原子性。[M12]
3. **目录屏障。** File system metadata 总是被 cache。要写盘，须 flush 或使用 write-through。[M3]
   write-through 请求会让 NTFS flush 该请求产生的 metadata 变化，文档举例包含 rename。[M5]
   `FLUSH_FLAGS_FILE_DATA_SYNC_ONLY` 对目录 handle 无效。这间接说明其他 flags 接受目录 handle。[M2]
   推论：对 rename 所在目录的可写 handle 做完整 flush，会写出该目录的 metadata，其中包括这次 rename。
   目录 handle 只有 `FILE_WRITE_DATA`，没有 `GENERIC_WRITE`。它满足 [M2] 的 write 权限条件。见 §3。
   **缺口 G2**：没有 Microsoft 文档直接说“flush 目录 handle 使该目录中的 rename 持久”。本稿用 [M2]、[M3]、[M5] 推出这一点。
4. **delete。** rename 到 tombstone、目录 flush、remove、目录 flush。论证同第 2、3 条。

### 5.2 跨文件顺序

每个 helper 写只在 flush 成功后返回。flush 失败时返回 `io_failure`，processor 不进入下一步。
所以，在 storage 兑现 flush 的前提下，durable 顺序为：
`applying` → memory 结果 → terminal → Host complete → `ackedAt`。
#522 的状态是“Host 有 applied，设备 memory 和 ledger 一起回到旧状态”。
它要求 storage 丢失一个已经确认 flush 的写入。这超出 model S 的 storage 假设。[M4]；WO-09a §6。

### 5.3 论证依赖的假设

- storage 兑现 `FLUSH_CACHE`，且没有关闭 flush。[M4]
- 本地 NTFS，非 SMB、同步目录或其他文件系统。
- G1 和 G2 成立。
- 单 writer lease。见 WO-09a §3。

## 6. 未覆盖项

1. OS crash 和断电实验。需要可丢弃的 Windows 机器或 VM。VM 断电的结论只适用于该虚拟 storage profile。WO-09a §7。
2. 新建 home、`.byok`、`notes` 子目录后的父目录屏障。本测试由父进程预建 `notes` 和 `.byok`。
3. 真实 ledger 记录列表和 prune。本测试只有一条记录。
4. 真实 processor（TS）在 Windows 上运行，包括 production `settleExistingRow` 不重复 CAS。Windows gate 仍关闭，所以本测试按其顺序调用 helper，恢复逻辑是测试内的模型。
5. Windows containment、reparse 矩阵、admission、发布产物和部署路径。
6. 其他 Windows build 或 storage 栈。本证据只来自 Windows Server 2025 build 26100 的 hosted runner。
7. kill 后留下的 `.byok-agent-memory-*.tmp` temp 或 tombstone 文件不会被清理。它们不影响目标名称。helper 在其他平台上走同一代码，行为相同。

## 7. 新增引用

以下链接在 2026-10-20 读取。

- [M9] [ReOpenFile](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-reopenfile)："Reopens the specified file system object with different access rights, sharing mode, and flags." 以及 "The object must have been created by the CreateFile function."
- [M10] [NTFS overview](https://learn.microsoft.com/en-us/windows-server/storage/file-server/ntfs-overview)，Increased reliability："NTFS enhances reliability by maintaining a transaction-based log file and checkpoint information. If a system failure occurs, NTFS uses this log to automatically restore file system consistency during the next startup"。
- [M11] [FILE_RENAME_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)：`FILE_RENAME_POSIX_SEMANTICS` 与 ReplaceIfExists 的运行时语义；没有崩溃原子性的说明。
- [M12] [Alternatives to using Transactional NTFS](https://learn.microsoft.com/en-us/windows/win32/fileio/deprecation-of-txf)："A common approach is to write the document to a new file, then replace the original file with the new one."
