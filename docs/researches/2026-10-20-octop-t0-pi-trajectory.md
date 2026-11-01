# Octop T0：Pi 1.3.0 工具事件配对

任务：#553 前置切片 T0。方案来源是 #557 分支的
https://github.com/Ancienttwo/byok-sdk/pull/557 §6，固定于
`6926a3821a0a54e1a9d1b6cc9ee6f2881f6ea78c`。本次 SDK 基线是
`origin/main@312ba99b46d27125882202b2587b0b13c88e0127`，包含 #549 和 #558。

## 结论与证据范围

T0 的源码核对和合成记录测试通过。正常工具、抛错工具和已完成收尾的协作中断会配对
`tool_execution_start` / `tool_execution_end`。二者使用同一个 `toolCallId`。
工具报错本身不是轨迹缺失。进程被杀则没有配对保证，也没有结束事件保证。

本次没有启动真实 Pi RPC host，没有调用付费模型。测试直接运行固定 Pi core 的
`runAgentLoop`，显式传入合成 `streamFn` 和本地工具。测试还用本地子进程重放合成
RPC 记录。这个子进程不是 Pi。它只读测试记录并写 stdout。killed 场景使用真实
SIGKILL，但证明范围限于合成传输的中断。

合成模型测试替换的是外部模型响应。工具调度、异常捕获和事件发出仍由安装的 Pi
1.3.0 core 执行。测试将全局 `fetch` 设为拒绝，并断言调用次数为零。
RPC 重放进程不继承 provider 凭据环境，也不导入 Pi 或网络模块。

这些证据支持 T1 按 ID 采集事件和检查缺口。它们不能证明真实 provider、扩展组合、
三平台 Pi 运行或真实 stdout 采集已经重新认证。真实 Pi 付费验证仍需另行授权。

## P1：固定闭包与边界

SDK 的 [官方 Pi 闭包记录](../../packages/client/src/adapters/pi/official-pi-closure.json)
固定九个包为 `1.3.0`。上游 commit 是
`71023aec1546d6d677a65669c5665c0927ce0dd0`。本次按
[安装身份代码](../../packages/client/src/adapters/pi/official-pi-installation.mjs)
复算 `SHA-256(JSON.stringify(closure))`，结果是：

```text
7950a1f4a0e34241c861ca5d9ba566ad3255ed493b8b5c17c39f32587962bede
```

读取的是本 worktree 中 `packages/client/node_modules/@earendil-works/` 实际链接到的
安装文件。没有从其他版本的 Pi 文档推断行为。闭包中的 provenance 是已有 pin
证据；本次没有重新向 registry 认证九个 tarball。

以下 SHA-256 记录本次读过的发出路径。路径均相对于对应安装包的根目录。

| 包 | 文件 | SHA-256 |
| --- | --- | --- |
| pi-agent-core | `dist/agent-loop.js` | `4d56e5352826e0dbe324eedd2b632d19867aff8844d1f010b3cdcd34069da7fb` |
| pi-coding-agent | `dist/core/agent-session.js` | `d0b4545a5da7fe97aa699269e64e27b37ee2fb5b7985efb1c0a66fc3d1883b52` |
| pi-coding-agent | `dist/modes/rpc/rpc-mode.js` | `631697cd35928fc827f4a423538c43ff227b8cbf63c2a2f11060616f55eba6db` |
| pi-coding-agent | `dist/modes/rpc/jsonl.js` | `049a9f8ca4242c79f1911ed977949e8d8906b4561f424c2729687f426fabaacf` |
| pi-coding-agent | `dist/core/output-guard.js` | `e860db94650c57e07582c300983671737bf9e796682193b498f75e3dd72e9024` |

测试校验官方 closure 身份、安装的 core 版本及 `agent-loop.js` 的上述 hash。
另外四个 hash 是源码审阅记录。它们不是新增的安装认证接口。

## P2：实际发出路径

下表的行号来自上述固定安装文件。可在干净的 `bun ci` 后按包内路径重读。

| 入口 | 本次核对的路径 |
| --- | --- |
| `pi-agent-core/dist/agent-loop.js:43–56` | `runAgentLoop` 使用显式传入的 `streamFn`；只有未传入时才取默认 stream。 |
| 同文件 `:374–405` | sequential 先发 start，再准备和执行工具，最后发 end。 |
| 同文件 `:411–463` | parallel 先准备调用，再并发执行。end 按完成顺序发出。工具结果消息仍按 assistant 的原始顺序排列。 |
| 同文件 `:481–539` | 未知工具、参数错误和 prepare hook 错误转为 immediate error result。 |
| 同文件 `:568–593` | `tool.execute` 抛错转为 `isError: true` 的结果。 |
| 同文件 `:646–655` | end 使用原调用的 ID 和工具名，带 `result` 与 `isError`。 |
| `pi-coding-agent/dist/core/agent-session.js:752–755` | AgentSession 先通知扩展和订阅者，再处理后续消息持久化。 |
| 同文件 `:684–692`、`:1433–1441` | session 层发 `agent_settled`。它带本次 run 的 abort 标志。它与 core 的 `agent_end` 不同。 |
| `pi-coding-agent/dist/modes/rpc/rpc-mode.js:28–30`、`:265–273` | session 事件经 `toJsonEvent`、`serializeJsonLine` 和 `writeRawStdout` 写出。 |
| `pi-coding-agent/dist/modes/rpc/jsonl.js:8–10` | 每帧用 `JSON.stringify` 序列化，并加 LF。 |

SDK 的
[RPC host](../../packages/client/src/bin/pi-session-runtime.ts)
调用这个固定的 `runRpcMode`。
[PiRpcClient](../../packages/client/src/adapters/pi/rpc-client.ts)
按 LF 拆行并解析 JSON。
[映射器](../../packages/client/src/adapters/pi/events.ts)
把 start/end 映射为 `tool_use` / `tool_result`，保留 ID 和原生错误标志。

Pi 的 `turn_end` 是单次模型 turn 的边界。一个工具调用后还可有下一次模型响应。
Pi 的 `agent_end` 也可能先于 session 的 retry、compaction 或队列处理完成。
SDK 只把未 aborted 的 `agent_settled` 映射为 SDK `turn_end`。
aborted settlement 产生 semantic、non-retryable failure。
[PiSession](../../packages/client/src/adapters/pi/pi-adapter.ts)
还会在 settlement 后读取统计信息。T0 的直接 mapper 测试不覆盖这次统计 RPC。

因此，看到 start/end 配对不等于看到了 SDK 的结束证据。看到 RPC event 也不等于
Pi 后续的 session 持久化已经完成。

## 四种情况的观察

| 情况 | 真实 core 的合成输入实验 | 合成 RPC 记录的 SDK 观察 |
| --- | --- | --- |
| 正常 | sequential 和 parallel 均为 1 start、1 end，ID 相同，`isError: false`。工具后的最终响应另有一次原生 turn_end。 | 1 tool_use、1 tool_result、1 SDK turn_end。 |
| 工具报错 | `execute` 抛错仍产生 1 start、1 end，ID 相同，`isError: true`。loop 可继续到最终响应。 | tool_result 保留错误标志，仍可有 SDK turn_end。 |
| 中断 | stream 阶段 abort 没有工具事件。工具执行期间协作 abort 会在工具拒绝后发 error end。parallel queued call 可在未执行工具时发 `Operation aborted` 的 end。 | 已配对工具加 `agent_settled{aborted:true}` 不产生 SDK turn_end；mapper 抛 semantic failure。 |
| 进程被杀 | SIGKILL 不执行 JavaScript 收尾，不能由 core 承诺补齐 end。 | 重放进程在完整 start 后写半行 end，再 SIGKILL。SDK 只看到 tool_use；没有 tool_result 或 settlement。 |

另一个实验在工具已收到 abort 请求后返回成功。Pi 保留 `isError: false`。
这说明 abort 请求不等于工具执行失败。不能从 end 的错误标志推断整个 task 的取消状态。
parallel queued abort 实验还验证了 end 的顺序可以不同于 start 的顺序。
计数相等不能代替按 ID 配对。

中断配对的前提是工具和 listener 能完成。源码直接 await 工具；工具若忽略 abort
且一直不返回，就不能证明 end 会到达。listener 拒绝或进程退出也可能中断发出路径。
T0 没有把这些情况改成无条件配对保证。

## stdout、解码和记录边界

`output-guard.js:38–55` 把普通 `process.stdout.write` 转到 stderr。
协议 writer 使用 takeover 前保存的 raw stdout writer。
按这条源码路径，普通日志不是预期的 RPC stdout 帧。
本次未运行真实 Pi，不能把这个静态结论写成“实测 stdout 没有非 JSON 行”。

现有 SDK 的 `onLine` 会静默跳过无法解析的完整行。`onData` 只处理 LF 结尾的行。
进程关闭时，残留的半行不会进入 `onLine`。killed 记录验证了这个半行缺口。
因此，T1 不能只在 JSON.parse 的 catch 里计数，便声称覆盖了全部流中断。
还需独立处理提前 EOF 和缺少结束事件。

本次没有证据表明正常 RPC stdout 必须容忍非 JSON 日志。因此，没有依据将
`decode_dropped` 收窄为“只统计以 `{` 开头的坏行”。T1 应保留非空完整坏行的可见性。
EOF 半行和未知帧的计数方式应在 T1 中明确。预期的原生 bookkeeping 帧也不能一律
计为 unmapped gap。

本次记录使用同一工具名和明确的 ID。内容全部由测试构造。
四个 `.jsonl` 文件是最小合成 RPC 记录，不是 Pi 抓取实录。
bookkeeping 帧只保留本测试需要的字段。
`agent_settled` 由记录显式给出；core 实验本身不产生 session settlement。
killed 记录的最后一行故意没有 LF，且不是完整 JSON。

## 验证与后续边界

[测试入口](../../packages/client/src/__tests__/pi-1.3-trajectory.test.ts)：

```sh
bun ci
bun run build
bun run --cwd packages/client test -- src/__tests__/pi-1.3-trajectory.test.ts
```

定向结果：14 passed。包含闭包身份 1 例，core 实验 9 例，RPC 重放 4 例。
重放使用真实 SDK parser 和 mapper。killed 用例检查实际子进程的 SIGKILL 状态。
测试未新增 timeout、sleep 或产品 seam。

本地环境：macOS arm64，Node 24.21.0，Bun 1.4.3。
五项 required checks 的最终命令结果见本切片 PR 的验证记录。

T1 可以实现事件来源声明、按 ID 的累加器、decode/unmapped 计数和本地诊断记录。
来源声明只说明采集面，不保证每次运行完整。
进程死亡且 Host 没有诊断记录时，保持 unknown。
工具报错但事件与结束证据完整时，可以判采集完整；K7 结算另行决定。
本切片未改 descriptor、Session、daemon、wire、K7 或 adapter 能力矩阵。
