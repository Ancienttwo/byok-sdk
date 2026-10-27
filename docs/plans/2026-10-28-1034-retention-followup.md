# #1034 retention 后续：有界目录回收

状态：实现完成，等待父线程验证。基线 `2fd42d450`（2026-10-28）。

## 范围和 ownership

#1021 已修复 released exec-runtime。#1042 已合入此基线，原 `producers.ts`、`registry.ts`、`retention.test.ts` 写入冲突已解除；新增 session-ledger 是单文件删除，不扩大本问题。

本车道只写此文档与 `_ops/1034-repro/`，不修改产品或已有测试。实施前由父线程确认边界。

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

Node `v24.22.1`，无 mock、无依赖安装、直接加载此基线 `usage.ts`。真实 fixture `/private/tmp/r1034-boundary-7smBkn` 保留：一个根目录与 16,384 个 1-byte 文件。

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

偶数轮读到目录游标尾，没有重新遇到目标；不是恢复。奇数轮每次在真实 `measureTree` 失败，三个类全部没有回收进展。最终 exit **0**；JSON `_ops/1034-repro/sweep-output.jsonl`，退出码 `sweep-exit-code.txt`，stderr 为空。fixture `/private/tmp/r1034-l54Zeu` 保留，包含三个各16,384个文件的目录。

这批证据只验证 registry producer 的周期 sweep，不声称完整 daemon startup 或 Windows 验证。此前无依赖的临时 resolver 三次失败均发生在产品执行前，已停止使用；失败 exit 1 保存在 `exit-code.txt`，不算产品回归。

## P3 — 最小实现提案

1. 将 RuntimeCleanup 中已验证的叶遍历机制提取成内部有界目录 collector，保留 runtime wrapper 的 released marker 特例。共享仅因为三个已观察到的目录消费者需要同一计数与 identity 不变量；不新增公开 API。
2. exec-sdk / daemon-temp 的 producer 各保留 resumable 状态与自身 eligibility。SDK startup 在预算耗尽且仍有 SDK residue 时继续 fail closed；下次启动可继续实际回收，不把部分完成当启动成功。
3. reader-run 候选选择提取到内部 `agent-home-reader-retention.ts`；原公开 `pruneReaderRuns` 签名不变。两个消费者共用同一 active/reference/TTL/overflow 规则。retention 逐个取得到期候选立即回收，pending 目标优先；每次重新取得 idle lease 与 handoff references。
4. collector 在部分回收的 finally 中将同 identity 目标目录的 mtime 恢复为原值，磁盘 mtime 继续是唯一 TTL authority。新 registry 无需 sidecar 或内存 mtime 副本即可继续。进程在 finally 前被强杀的窗口不在本次 registry-restart 证据范围内，不声称 crash atomicity。
5. leaf bytes 写回原始 pass budget 的 WeakMap，class wrapper 记录 parent；home 时间 wrapper 只提供 available，accounting 仍传 class budget。完整对象计数只在最终删除增加。
6. 父线程定案：runtime 保留 4,096 inspections；exec-sdk、daemon-temp、reader-run 各 1,024，总计最多 7,168，余下 1,024 服务其他类及 dispatch overhead。classBudget 是份额唯一 owner，listing 和 leaf 都计份额。周期轮换起点，startup 始终 SDK 先。全局时间上限不保证每轮所有类均服务，有限工作下轮换提供跨轮机会。保留旧 runtime 五轮清空断言，不修改已有测试。

10× 积压首先耗尽 inspections / wall time，不应再次触发整树测量上限；应增加完成轮数而非停止进展。每轮固定预算下，不承诺持续写入量超过清理吞吐时队列能清空。

## 验证边界

父线程负责 build/typecheck/required checks。行为证据应覆盖：真实 16,384/16,385 边界、跨轮进展与准确 bytes、registry 重建后的继续、预算不超额、其他类仍推进、live/reference/TTL 保护、startup SDK 未清净拒绝启动、symlink/identity 原有不变量。不得删改旧断言来适配实现；若实现与测试同 PR，按 repo 规则做一次只读断言审查。

## 实施交接

新增 `retention-oversized-classes.test.ts` 覆盖三个真实大目录、每类上限、完整 byte accounting、部分回收后 registry 重建、mtime 不重置、SDK startup fail closed 与其他单文件类进展。实施代理未运行 build/typecheck/tests；父线程统一验证。此前故障复现及 fixture 保留。没有修改公开 API golden、entry budgets、CHANGELOG 或旧测试断言。
