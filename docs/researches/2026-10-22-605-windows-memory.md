# Windows Agent 记忆（#605）：现状清单、0.28.3 切片与 owner 决定

状态：方案与清单。Windows admission 保持关闭。`B`（`strictLedgerBarrier`）保持 `false`。
本文不改变 SDK API、wire、ledger 格式、release pin 或部署。

日期：2026-10-22（Asia/Taipei）。
SDK 基线：`7c0bbebc`。下文的 `file:line` 都指这个基线。
关联：[issue 605](https://github.com/Ancienttwo/byok-sdk/issues/605)；
[WO-09a 决策稿](../adr/ADR-042-windows-ntfs-ledger-barrier.md)（§3 定义，§7 验收）；
[WO-09 验证稿](2026-10-19-wo09-windows-ledger-validation.md)；
[model S 证据稿](2026-10-20-windows-ntfs-model-s-evidence.md)。
已关闭：#522、#521、#603、#604。仍开放、不在本文范围：#614（记忆 admission 开关）、#609（memory-reader 运行目录）。

## 1. 结论

- 0.28.3 不能关闭 #605。§7 的 OS-crash 和断电两行需要可丢弃的 Windows 环境，hosted CI 做不到。
  所以 Windows admission 在 0.28.3 保持关闭。PR 写 "Refs #605"。
- 0.28.3 的切片只加 Windows 测试和一条例行 CI leg（§3）。产品代码不变。
- 其余工作等 owner 决定（§5、§6）。

## 2. 现状清单

### 2.1 `codex/p2-win-ledger`

- origin 上没有这个分支。`git ls-remote origin 'refs/heads/codex/*'` 只列出 `codex/release-0.28.1-frozen`。本地分支的 upstream 显示 `[gone]`。
- 本地分支还在：head `f3b4b288`，worktree `.claude/worktrees/p2-win-ledger`。它有 7 个 commit 不在 main 上，落后 main 149 个 commit。
- 它的内容以 squash 方式进了 main：#527（`433deced`，WO-09a）和 #528（`f7b600de`，WO-09）。#580（`8d527cca`）和 #584（`ed4a81fb`）在其上继续扩展。
- 逐行核对：该分支新增的每一行都在 main 上。唯一例外是旧的 entry budget `67063`（`README.md` 一行、`api-surface/entries.json` 一行），main 后来改过这个 budget。
- 这个分支没有需要再合入的内容。

### 2.2 main 上已有的 Windows 部分

| 项 | 位置 | 状态 |
|---|---|---|
| TS 平台门 | `agent-memory.ts:181`、`agent-memory-fs-helper.ts:41`、`agent-memory-helper-release.ts:43`、`create-daemon.ts:1362` | 关闭。win32 不放行。 |
| TS/Go tagged identity（protocol 2） | `agent-memory-fs-helper.ts:67`；Go `identity_windows.go` | 已实现。按 handle 读 volume serial 和 file index。 |
| Go open admission | `main.go:312-319` | 关闭。返回 `unsupported_platform`。 |
| Windows `sameVolume` | `sync_windows.go:89` | 总是返回错误，所以 `syncHomeChain` 在 Windows 上不能通过。 |
| NTFS 目录屏障 | `sync_windows.go:37`（#584） | 已实现。`NtCreateFile` 相对重开、同对象核对、`FlushFileBuffers`。 |
| model P 进程 kill 证据 | `crash_windows_test.go` | 63 个固定点和 150 次随机 kill，admin 和标准用户两种 token。run [39407286913](https://github.com/Ancienttwo/byok-sdk/actions/runs/39407286913)（head `5e6848c2`）。 |
| 平台拒绝、空 env、junction fixture | `scripts/ci/agent-memory-windows-denial.mjs`；`barrier_windows_test.go`、`main_windows_test.go` | 已实现。只证明拒绝，不证明 containment。 |
| model S 规范文字 | `docs/spec.md:2244-2256`；`docs/protocol.md` §2.4 | 已写明 S 和 BLOCKED。 |
| Windows workflow | `.github/workflows/agent-memory-windows.yml` | 只有 `workflow_dispatch`。PR 和 push 不运行它。 |

最近两次绿色的手动 run 是 39404884723 和 39407286913（2026-10-20），之后没有再运行。
`git diff 5e6848c2 origin/main` 在 helper 目录、该 workflow、denial 脚本和两个 TS Windows 测试上为空。
所以那次 run 的 Go 证据仍对应 main 上的 helper 代码。

### 2.3 §7 证明状态

| §7 行 | main 上的状态 | 能否在 `windows-latest` 运行 | 不改 selector 时在哪里运行 |
|---|---|---|---|
| API 可用性 | 部分。NTFS 目录屏障在 admin 和标准用户下成功。workflow 记录 OS build、卷、token 和 helper sha256。`TestWindowsDirectoryFlushDiagnosticsOnly` 只记录，不断言。只有 Server 2025 build 26100 一个 build。 | 能。Windows 10/11 客户端版不能。 | `agent-memory-helper-linux` 的新 Windows leg（§3）。 |
| namespace 原语 | 部分。kill 测试覆盖 replace-new、replace-existing、delete，但目录由父进程预建。新建 home、`.byok`、`notes` 的父目录屏障没有覆盖。reparse 矩阵只证明打开前拒绝。 | 能。 | 本 PR 加 pin 之后的 junction 和 symlink 替换。目录链见 W2。 |
| 确定性错误注入 | 只有 POSIX 版。`barrier_test.go` 是 `!windows`。 | helper 层能。TS processor 层需要已放行的 Windows backend。 | 本 PR 把 helper 层移植到 Windows（§3）。 |
| process-crash | Go 层已做（model P），只在手动 workflow 运行。production `settleExistingRow` 没在 Windows 运行。ledger 只有一条记录。没覆盖新建 home。 | 能。 | 本 PR 让 Go 层在例行 leg 以 admin 运行。标准用户仍只在手动 workflow。 |
| OS-crash | 只有论证（证据稿 §5，缺口 G1、G2）。 | 不能。 | 无。 |
| 断电 | 只有论证，并且依赖 storage 兑现 flush。 | 不能。 | 无。 |
| #522 回归 | 只有论证（证据稿 §5.2）。 | TS 部分能。平台部分需要 OS-crash 实验。 | 无。 |

### 2.4 CI 映射

- `ci.yml` 里在 Windows 上运行的 job：`adapter-lifecycle-smoke`、`windows-git-workspace`、`packageability-smoke`、`npm-release-pack`、`windows-service-smoke`、`ipc-smoke`。它们都不运行记忆 helper 的测试。
- 改 helper 目录会选中 `agent-memory-helper`（macOS）、`agent-memory-helper-linux`（Linux）、`packageability-smoke` 和 `npm-release-pack`（`select-impact.mjs:176-187`、`:433-435`）。
- 合约测试要求 family job 运行的每个测试都归该 family 所有（`select-impact.test.mjs:83`）。helper 目录归 `agent-memory-helper-linux` 和 `packageability-smoke`，`npm-release-pack` 经 `:433` 的规则也被选中。
- 所以不改 selector 时，Windows Go 测试只能放进三处：`agent-memory-helper-linux` 的新 Windows leg，或 `packageability-smoke`、`npm-release-pack` 的 Windows leg。后两个 job 的用途不同。本 PR 用第一处。
- TS Windows 测试（`agent-memory-windows-gate.test.ts`、`agent-memory-helper-identity.test.ts`）只归 `agent-memory-helper`。那个 job 只跑 macOS，大部分 step 是 macOS 专用。本 PR 不动它。
- 改 `agent-memory-windows.yml` 会让 selector 抛出 "Reviewed CI mapping required"（`select-impact.mjs:282`、`:286`）。那需要改 selector，见 Q3。
- 只改 `ci.yml` 不会选中任何 family（reason `root-ci-scripts`）。新 leg 能在本 PR 运行，是因为本 PR 同时加了 helper 目录下的 Go 测试文件。

## 3. 0.28.3 切片（本 PR）

1. `barrier_inject_windows_test.go`：把 `barrier_test.go` 里四个注入测试移植到 Windows。
   - session 由测试直接构造，和 `crash_windows_test.go` 一样。`openSession` 不变。
   - 注入的错误码：`ERROR_ACCESS_DENIED`（#580 的真实失败）、`ERROR_INVALID_FUNCTION`、`ERROR_NOT_SUPPORTED`、`ERROR_IO_DEVICE`。
   - 没被注入的调用交给真实的 `platformStrictSync`，并且必须成功。
   - 断言和 POSIX 版相同：`io_failure`、调用次数、内容、冲突不 rename。temp 残留检查用 helper 真实的前缀 `.byok-agent-memory-`。
   - "冲突不 rename" 用 handle 读 file ID。Windows 上 `os.Stat` 的 file ID 要等 `os.SameFile` 运行时才按路径读取，rename 前后两次 `os.Stat` 的比较总是相同。
   - 另加一个不注入的 append 测试。Go 以 `O_APPEND` 打开文件时去掉 `FILE_WRITE_DATA`，所以已有 note 的 append 经只有 `FILE_APPEND_DATA` 的 handle flush。这条路径在 Windows 上原来没有测试。
2. `containment_windows_test.go`：session pin 住 home 以后，用 junction、目录 symlink 和文件 symlink 替换 `notes` 或叶子文件。read、replace、delete、append、walk 都不能碰到外部 sentinel。home 本身被换成 junction 时，写入仍落在原目录。
   - fixture 建不出来时测试失败，不 skip。`go test` 遇到 skip 仍返回 0，skip 不是证据。
3. `ci.yml`：`agent-memory-helper-linux` 加 `windows-latest` leg。只改显示名，family id 不变。Windows 上不加 `-race`。
4. 本文和 CHANGELOG 的 Unreleased 条目。

不改：helper 产品代码、TS 门、`openSession`、`sameVolume`、B、wire、API budget、selector、`agent-memory-windows.yml`。
release pin 不变：source digest 不含 `_test.go`（`packages/client/scripts/agent-memory-helper-source.mjs:6-12`）。

验收：新 leg 在本 PR 的 CI 上通过；`node --test scripts/ci/*.test.mjs` 通过；source digest 不变。

已知缺口：

- 新测试只以 admin token 运行。手动 workflow 的标准用户 step 只运行三个指定测试。见 Q7。
- 例行 leg 不设 `BYOK_TEST_AGENT_MEMORY_JS_RUNTIME`，所以 Node/Bun identity parity 测试在该 leg 里 skip。手动 workflow 仍运行它。
- pin 之前的 home 替换（POSIX 版的 `root` 子测试）要经过 `openSession`。它在 Windows 上关闭，所以这一项归 W3。

## 4. 风险

- 每个 helper PR 多一个 Windows job。手动 run 的 Go step 用了 48–65 秒，整个 job 3–4 分钟。
- 新 leg 也进入发版门。release validation 运行全部 family，`ci-required` 要求完整清单。改 `.node-version` 的 PR 选中全部 family（`select-impact.mjs:317-321`），改 `.gitattributes` 的 PR 也选中这个 family（`:308-312`）。所以 0.28.3 的 release validation 和这些 PR 都要等这个 Windows leg 通过。
- 随机 kill 测试有统计断言。手动 run 里 4 次都通过。例行运行后若出现 flake，按 flake 处理，不放宽断言。
- 默认 temp 在 C:，fsync 慢（`docs/researches/2026-10-22-windows-k8-fsync-stalls.md`）。新 leg 保持默认 temp，和手动 run 的 admin step 一致。
- family id 仍叫 `agent-memory-helper-linux`，但它现在也跑 Windows。改名要改 selector，见 Q4。

## 5. 必须等待的切片

- **W1 Windows 名称与别名矩阵。** ADS（`a.md:s`）、保留名（`CON.md`、`con` 目录）、以点结尾的目录段、大小写别名（`notes/A.md` 与 `notes/a.md`）、8.3 短名、硬链接、DACL。TS 的 `SAFE_SEGMENT`（`agent-memory.ts:27`）已经拒绝 `:` 和 `~`，但接受 `CON.md`、`con` 和 `x.` 这样的目录段。期望行为要 owner 定（Q9）。
- **W2 Windows home 目录链屏障。** 需要 Windows 版 `sameVolume` 和新的链规则。`syncHomeChain` 会 flush 同卷上的全部祖先目录。按默认 ACL，标准用户对 `C:\Users` 只有读和执行权限，拿不到可写 handle，这条链在 Windows 上走不通（推断，未运行）。可能的方向是只在 SDK 新建目录时 flush 它的父目录。这需要设计和 Windows 实验。
- **W3 open admission 与发布物。** Go `openSession`、TS 平台门、win32 helper 发布物（x64，可能还有 arm64）、PE digest、Authenticode 与产品重签策略、release pin 条目、打包（复用 #603 的机制）。这会改 release pin，可能改 API budget，要 owner 确认（Q5）。
- **W4 Windows 上的 TS processor。** production `settleExistingRow`、多记录 ledger 和 prune、Node 和 Bun、新 home 和已有 home。依赖 W3 或一个 TS 测试接缝。
- **W5 OS-crash 和断电实验。** 使用可丢弃环境。独立 Host 留存收到 complete 的时点和 digest（Q1、Q2、Q6）。
- **W6 规范与广播。** 证明齐全后，采用 WO-09a §6 的拟议文字，把 Windows backend 的 B 改为 true，再广播 `agent-memory-intent.v1`。
- **W7 CI 结构。** 标准用户进入例行 CI；`agent-memory-windows.yml` 加 selector 映射，或并入 `ci.yml`（Q3、Q7）。

## 6. owner 决定

1. OS-crash 和断电实验用的可丢弃 Windows 环境由谁提供？只切 VM 电源、结论只适用于该虚拟 storage profile，可以接受吗？
2. model S 支持哪些 Windows build？CI 是 Windows Server 2025 build 26100，用户主要用 Windows 10 和 11 客户端版。
3. `agent-memory-windows.yml` 要加 selector 映射（允许改它，也允许 PR 触发），还是把它的标准用户 step 并入 `ci.yml`？
4. `agent-memory-helper-linux` 现在也跑 Windows，要改名吗？改名是 selector 改动。
5. Windows helper 发布物的 PE digest 算法、Authenticode 与产品重签策略是什么？要不要 win32-arm64？
6. 证据稿的缺口 G1（rename 跨崩溃的原子性）和 G2（目录 flush 使 rename 持久）按论证接受，还是要求更多证据？
7. 新测试要不要在例行 CI 里也以标准用户运行？这要加一个建用户的 step。标准用户没有建 symlink 的权限，所以 symlink fixture 只能以 admin 运行。
8. 能否先在 Windows 放行 `memory_recall`/`memory_save`（需要 containment 证明），晚一步再给 intent 的 B（需要 model S）？现在两者共用同一个 open 门。AiphaBee 计划在两个平台一次切换。
9. W1 的名称规则：在 TS 校验里对所有平台拒绝保留名、以点结尾的段和大小写别名，还是只在 Windows 拒绝？
10. P2-win 的目标版本是哪个？0.28.3 只交付 §3。

## 7. 验证记录

### 7.1 本机（macOS arm64，Go 1.26.5）

本机不能运行 Windows 代码。下列结果只证明编译、合约和 digest。

| 命令 | 结果 |
|---|---|
| `gofmt -l packages/client/native/agent-memory-fs` | 无输出 |
| `GOOS=windows GOARCH=amd64 go vet ./...`，`GOARCH=arm64` 同 | exit 0 |
| `GOOS=windows GOARCH=amd64 go test -c` | exit 0（只编译，不运行） |
| `GOOS=linux GOARCH=amd64 go vet ./...` | exit 0 |
| `go test ./...`（darwin） | exit 0；新文件只在 Windows 编译 |
| `node --test scripts/ci/*.test.mjs` | 92 pass，0 fail |
| `select-impact` 读本 PR 的改动路径 | 不抛错；families 为 `agent-memory-helper`、`agent-memory-helper-linux`、`npm-release-pack`、`packageability-smoke` |
| helper source digest | `e39988d8…`，与 release pin 相同 |
| `node --test scripts/release/agent-memory-helper-source.test.mjs` | 4 pass，0 fail |

### 7.2 PR CI

Run [39769769167](https://github.com/Ancienttwo/byok-sdk/actions/runs/39769769167)，head `7c92d091`。本节之后的 commit 只改本文。

- `agent memory helper non-Darwin volume checks (windows-latest, fixed Go)`（job 119794199650）：pass，58 秒。
  runner image `win25-vs2026` 20261018.275（Windows Server 2025），Go 1.26.5 windows/amd64，admin token，temp 在 C:。
  `go test -v ./...`：77 PASS、2 SKIP、0 FAIL，package 用时 21.7 秒。
  - 新测试全部通过：四个注入测试共 31 个子测试（8、4、16、3），append 2 个，reparse 5 个（parent 2、leaf 3），pinned home 1 个。
  - pinned home 的 rename 被拒绝："The process cannot access the file because it is being used by another process."。写入仍落在原目录。
  - 两个 SKIP：`TestWindowsRuntimeIdentityMatchesNativeHandle`（该 leg 不设 runtime 变量）和 `TestWindowsCrashProbeChild`（kill 测试的子进程入口，按设计 skip）。
  - 已有的 model P kill 测试也在例行 leg 通过：固定点 10.2 秒，随机 kill 11.0 秒。
- `agent memory helper non-Darwin volume checks (ubuntu-latest, fixed Go)`：pass，18 秒。
- 写本节时其余 job 仍在运行。最终结果以 PR #722 的 checks 为准。

### 7.3 顺带发现，未修改

POSIX 的 `TestStrictBarrierFailuresNeverBecomeConflict`（`barrier_test.go:80`）检查 temp 前缀 `.byok-replace`。
helper 的 temp 名是 `.byok-agent-memory-replace-…`（`main.go` 的 `temporaryName`），所以这个残留检查永远匹配不到。
Windows 移植版用真实前缀。改 POSIX 版是加强断言，作为后续工作，不在本 PR。

## 8. 0.29.0 切片（lane C）

owner 在 2026-10-22 定了 §6 的 10 个问题（见 #605）。0.29.0 先放行 `memory_recall` / `memory_save`，B 保持 `false`。切片顺序：

1. **W3-go**：Go helper 在 Windows 放行 open。
   - Windows 只接受 NTFS，其他卷返回 `unsafe_root`。只有在 NTFS 上，volume serial 加 64 位 file index 才唯一。ReFS 的 file ID 是 128 位，64 位 index 不唯一。FAT 的 file ID 随目录项移动而变。
   - Windows 不跑 home 链屏障，链规则（W2）和 B 一起做。写法对齐 #738 的 O6：进程崩溃下单文件原子，每次写严格 flush 自己的文件和目录；不承诺 OS 崩溃和断电后仍持久。
   - TS 门仍关，包里也没有 Windows 资产，所以产品行为不变。
2. **W1**：名称规则（保留名、以点结尾的段、硬链接、大小写别名），所有平台。要确认 budget 和大小写别名的语义。
3. **W3a**：win32-x64 发布物和 `pe-content-v1` digest。要确认 budget 和 `sdkNativeAssetTargets` 的公开类型。
4. **W3b**：TS 门放行 win32-x64 的 recall/save，Windows 上 B 为 `false`。要确认 budget。
5. **W7**：删除 `agent-memory-windows.yml`，family 改名。要确认 selector 映射。

W2、W4、W5、W6 等 owner 提供 Windows 环境后再做。
