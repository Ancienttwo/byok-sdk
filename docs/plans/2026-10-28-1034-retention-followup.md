# #1034 retention 后续：有界目录回收

状态：实现完成，等待父线程验证。基线 `2fd42d450`（2026-10-28）。

## 范围和 ownership

#1021 已修复 released exec-runtime。#1042 已合入此基线，原 `producers.ts`、`registry.ts`、`retention.test.ts` 写入冲突已解除；新增 session-ledger 是单文件删除，不扩大本问题。

实现范围为 retention collector/producer/sweeper、内部 reader-run 候选选择器及专属回归文件。公开签名、行为断言、API golden 与预算保持不变；模块清单的精确新增见验收记录。

## P1 — 系统边界

入口 `RetentionSweeper.pass`（`retention/sweeper.ts`）创建一轮共享预算，经 registry 分发给 `producers.ts`。全局上限 8,192 inspections、默认 256 个完整对象删除与 10 秒；exec-runtime 的 leaf collector 最多使用 4,096 inspections。home 类在 idle home lease 中执行，另有每 home 250 ms 时限。预算不是提升权限：TTL、引用、live ownership 和 canonical path 检查仍决定是否可删除。

`usage.ts:6` 的 `measureTree` 计数包含根目录；返回的 `entries` 则只数非目录。`usage.ts:39` 的 `removeOwnedPath` 必须完整测量成功才调用 `fs.rm`。

## P2 — 具体调用链与证据

- exec-sdk：`sweepExecSdk` → 非 live scratch token → `remove(execRoot, token/sdk)` → `removeOwnedPath` → `measureTree`。startup 的 secret-bearing SDK residue 清理是能力发布前置条件；不能允许半清理后继续启动。
- daemon-temp：`sweepDaemon` → diag/credential/prepare 名称目录 → mtime TTL → 同一 `remove` 链。
- reader-run：idle home lease → `readerRunReferences` → `pruneReaderRuns` 的 active/reference/TTL/overflow 判定 → `beforeRemove` 的 `measureTree` → `fs.rm`。测量失败会在删除前退出。
- agent-result：`pruneAgentResults` 对 Dirent 与 lstat 都要求 regular file；每个 target 仅一项。home-temp 同样只收 regular file。二者不满足本 issue 推测的“单个删除对象包含超大树”，只参加公平性回归，不套目录 collector。
- skill-pack-old 也有整树删除路径，但未列在本 issue 的明确切片内；报告此观察，不在本切片扩改。

### 已运行的真实边界证据

命令（worktree 根目录）：

```sh
node _ops/1034-repro/measure-only.mjs
```

Node `v24.22.1`，无 mock、无依赖安装、直接加载此基线 `usage.ts`。真实 fixture `/private/tmp/r1034-boundary-7smBkn` 已在验证后清理：一个根目录与 16,384 个 1-byte 文件。

- 16,384 scanned entries（根 + 16,383 文件）测量成功，bytes=16,383。
- 16,385 scanned entries（根 + 16,384 文件）连续三次 `removeOwnedPath` 都报 `retention_usage_scan_limit`，每次仍剩 16,384 文件，零删除。
- 最终 exit code **0**。JSON：`_ops/1034-repro/measure-output.jsonl`；退出码：`measure-exit-code.txt`；stderr 为空。

这证明共享删除 primitive 的确定性停滞，不等同于三个 producer 的完整 sweep 证据。

### 完整 producer 复现已确认

父线程执行标准 `bun install --frozen-lockfile` 和 `bun run build`（均 exit 0）后，直接运行：

```sh
bun _ops/1034-repro/repro.ts
```

使用真实 ScratchRoot、AgentHomeManager、handoff store 与 registry；没有 mock、没有 resolver。Bun 1.4.3（`process.version` 报 `v26.3.0`）。三个 producer 都用真实 16,384 leaves，逐个确认根+16,383 leaves 可测量、恢复第16,384个文件后超界。

| producer | 五轮 error | 每轮剩余 leaves | 每轮 deleted / bytes |
| --- | --- | --- | --- |
| exec-sdk | scan-limit / none / scan-limit / none / scan-limit | 16,384 | 0 / 0 |
| daemon-temp | 同上 | 16,384 | 0 / 0 |
| reader-run | 同上 | 16,384 | 0 / 0 |

偶数轮读到目录游标尾，没有重新遇到目标；不是恢复。奇数轮每次在真实 `measureTree` 失败，三个类全部没有回收进展。最终 exit **0**；JSON `_ops/1034-repro/sweep-output.jsonl`，退出码 `sweep-exit-code.txt`，stderr 为空。fixture `/private/tmp/r1034-l54Zeu` 当时包含三个各16,384个文件的目录，已在验证后清理；JSON/exit evidence 保留。

这批证据只验证 registry producer 的周期 sweep，不声称完整 daemon startup 或 Windows 验证。

## P3 — 最小实现提案

1. 将 RuntimeCleanup 中已验证的叶遍历机制提取成内部有界目录 collector，保留 runtime wrapper 的 released marker 特例。共享仅因为三个已观察到的目录消费者需要同一计数与 identity 不变量；不新增公开 API。
2. exec-sdk / daemon-temp 的 producer 各保留 resumable 状态与自身 eligibility。SDK startup 在预算耗尽且仍有 SDK residue 时继续 fail closed；下次启动可继续实际回收，不把部分完成当启动成功。
3. reader-run 候选选择提取到内部 `agent-home-reader-retention.ts`；原公开 `pruneReaderRuns` 签名不变。两个消费者共用同一 active/reference/TTL/overflow 规则。retention 逐个取得到期候选立即回收，pending 目标优先；每次重新取得 idle lease 与 handoff references。
4. collector 在部分回收的 finally 中将同 identity 目标目录的 mtime 恢复为原值，磁盘 mtime 继续是唯一 TTL authority。新 registry 无需 sidecar 或内存 mtime 副本即可继续。进程在 finally 前被强杀的窗口不在本次 registry-restart 证据范围内，不声称 crash atomicity。
5. leaf bytes 写回原始 pass budget 的 WeakMap，class wrapper 记录 parent；home 时间 wrapper 只提供 available，accounting 仍传 class budget。完整对象计数只在最终删除增加。
6. 父线程定案：runtime 保留 4,096 inspections；exec-sdk、daemon-temp、reader-run 各 1,024，可续扫 listing/删除份额总计最多 7,168。完整 reference authority 扫描单独使用原始 pass 的 8,192 全局上限及 250 ms home 时限，不受 1,024 删除份额限制；因此引用清单较大时不承诺其他类每轮还剩 1,024。classBudget 是删除份额唯一 owner，所有工作仍共享全局上限。周期轮换起点，startup 始终 SDK 先。全局时间上限不保证每轮所有类均服务，有限工作下轮换提供跨轮机会。保留旧 runtime 五轮清空断言，不修改已有测试。

10× 积压首先耗尽 inspections / wall time，不应再次触发整树测量上限；应增加完成轮数而非停止进展。每轮固定预算下，不承诺持续写入量超过清理吞吐时队列能清空。

## 验证边界

父线程负责 build/typecheck/required checks。行为证据应覆盖：真实 16,384/16,385 边界、跨轮进展与准确 bytes、registry 重建后的继续、预算不超额、其他类仍推进、live/reference/TTL 保护、startup SDK 未清净拒绝启动、symlink/identity 原有不变量。不得删改旧断言来适配实现；若实现与测试同 PR，按 repo 规则做一次只读断言审查。

## 实施交接

新增 `retention-oversized-classes.test.ts` 覆盖三个真实大目录、每类上限、完整 byte accounting、部分回收后 registry 重建、mtime 不重置、SDK startup fail closed 与其他单文件类进展。实施代理未运行 build/typecheck/tests；父线程统一验证。此前故障复现的 JSON 与退出码保留，临时大目录已清理。没有修改公开 API golden、entry budgets、CHANGELOG 或旧行为断言。

## 父线程验收记录

验证 subject：`8a85f3ac9f41a96ac76382e49729390099d093f3`，冻结基线 `2fd42d4502693001aa6b9942342731c4d748a84a`。

- 初始三个定向文件（retention、oversized classes、agent-home-readers）：89 tests passed。
- 独立只读审查发现 references 不可续扫却受 1,024 删除份额限制；`8a85f3ac9` 将完整 authority 扫描恢复为全局预算计费，保留 250ms 和不完整 references 全 home 禁删规则。
- 第二轮仅读该修复 delta，确认 P2 已修复，无新增 finding；最后的执行条件已由新增专属文件 6 tests passed（exit 0）满足。回归使用生产 writer 建立 1,026 个真实 ledgers，检查未引用目录推进与引用目录保留。
- `bun run build`、`bun run typecheck`、`bun run check:api-surface`、`bun run check:version-authority`：全部 exit 0。九包 declaration golden 匹配，未提高任何预算。
- `bun run test`：exit 1，client 为 4,935 passed / 109 skipped，唯一失败是 `agent-memory-entry-constraints.test.ts` 的精确模块名单缺少新提取的 `agent-home-reader-retention.ts`，命令在此停止，未跑后续 workspaces。
- 名单仅增加该一个模块，保留等值断言、禁止依赖与 runtime exports 检查。原因：原 reader-run eligibility 被提取为两条实际路径共用的内部 policy；没有把 daemon/control/transport 加入 entry。新增两行原因注释。该文件随后 9/9 passed；built entry check exit 0；agent-memory 发布 JS 与冻结 base 的 `cmp` exit 0、closure 仍为 74,254 B。
- 此清单调整经用户授权的限定第三轮只读审查通过；精确名单与发布 bundle 不变的证据均获确认。
- 同一冻结 base 的已知范围外阻塞：`examples/bot-collaboration/src/cross-bot-join.test.ts` 的 “spent 9 + fan-out 2…” 在 clean base 单独执行也 exit 1，失败于 `cross-bot.test-support.ts:11:135`。未修改该例或产品路径。日志 `/tmp/byok-baseline-cross-bot.log`。
- 未把定向通过与公共声明通过写成全仓通过；最终 CI 和上述审查仍未完成。

## CI 体积修复

用户要求直接修复 #1054 的预算失败。先合入固定 main `875eb002034017b3af665df336c0c35513304c82`；合并后同一构建仍复现 client 超限。client 主 tsup 构建增加 `minifyWhitespace: true`，只收紧生成 JS 的普通注释与空白；不启用 identifier 或 syntax minification。

构建前后对照：330 个 client declaration 文件逐字节相同；23 个 JS 文件经 Acorn 解析、去位置与字面量 raw 拼写后的 AST 相同，CLI shebang 相同。检查脚本和 baseline 位于 `_ops/1054-budget/`，结果 `/tmp/byok-1054-budget-equivalence.log`。source maps 仍由原工具链生成。

最终 closure：client 1,833,448 / 2,304,426 B；byok-agent 1,778,082 / 2,232,941 B。`api-surface/entries.json` 仅同步同三个 opaque import 的新行号（245、5109、5167）；预算、规则、依赖、公开声明没有变更。build、typecheck、API surface、version authority 均 exit 0。

此改动解决本 PR 的 client 主构建体积阻塞。其他包的发布注释策略和统一重测仍属于 M；本稿不声明全局 M 已完成。最终提交的 workspace tests 与远端 CI 由本轮 PR 验证记录给出。

## Startup and vanished pending-target correction

Startup safety enumeration is complete and outside the periodic inspection/time quota; actual SDK residue removal remains bounded and fail closed. This replaces the fixed-share enumeration that could permanently reject a restart containing only 1,024 normally released executions. Runtime TTL history therefore adds O(N) startup I/O. A disappeared pending daemon-temp target releases its pending state without inventing reclaimed bytes; other errors and identity replacement remain failures.

The new test-only commit 0ce6203a6 failed both scenarios before production changes. On 929cd9174, root build/typecheck/version checks and all 52 tests in the new regression file plus retention/oversized suites pass. Existing test assertions are unchanged. Independent read-only implementation/test review passed; the startup complexity exception is documented in spec. Client and byok-agent closures each add exactly 369 B, signed by coordinator wB:p4 under #1008 authority, without extra headroom. This correction does not resolve the separate reader-run 250 ms reference-scan progress risk.
