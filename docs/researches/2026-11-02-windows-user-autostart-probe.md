# S4-0：Windows 按用户自启机制探针（Startup `.cmd` + launcher，Task Scheduler 对照）

跟踪 issue：[#1329](https://github.com/Ancienttwo/byok-sdk/issues/1329)（Part of #1093，S4-3 的前置探针）。PR：[#1333](https://github.com/Ancienttwo/byok-sdk/pull/1333)。

- 证据 run：[41404258931](https://github.com/Ancienttwo/byok-sdk/actions/runs/41404258931)（job [125142610214](https://github.com/Ancienttwo/byok-sdk/actions/runs/41404258931/job/125142610214)），探针提交 `17acfcc23`，基线 `main@f783701a3`。Q1–Q4 在前一次 run [41403371773](https://github.com/Ancienttwo/byok-sdk/actions/runs/41403371773) 上结果相同。
- 环境：GitHub hosted `windows-latest`，镜像 `win25-vs2026 20261030.294.1`（Windows Server 2025）；Node `24.22.1`；`byok-agent` `0.34.0`（本仓库 `bun run build` 产物）。
- 探针 workflow 和脚本在本 PR 合入前已删除。要复现，检出 `17acfcc23` 看 `.github/workflows/s4-0-windows-autostart-probe.yml` 和 `scripts/probes/s4-0-windows-autostart/`。
- 非目标：不改产品代码和现有 CI job；不用 self-hosted runner；不调用付费模型。

## 结论摘要

| # | 问题 | 结论 |
| --- | --- | --- |
| Q1 | 普通用户写自己的 Startup 文件夹并拉起 launcher；安装进程退出后 launcher 仍存活 | 通过 |
| Q2 | `start "" /min` 与 `conhost.exe --headless` 哪个可用 | 两者都能拉起 launcher。`conhost --headless` 会去掉内层引号，含空格的路径会出错，推荐 `start "" /min`。窗口是否可见在 CI 无法判定 |
| Q3 | launcher 循环：非 0 等 10s 重跑，0 结束，每轮前查 `<name>.stopped` | 通过 |
| Q4 | `byok-agent` daemon 做被管进程，stop 程序发 `shutdown` 后 `control.token`、`daemon-owner.json` 被清掉 | 通过 |
| Q5 | Task Scheduler 对照：普通用户能否注册 logon 任务、非 0 是否重启、`/End` 是否优雅 | 不通过（不适合作为 S4-3 机制） |
| — | 用户登录时 Explorer 自动执行 Startup 项 | CI 无法判定（无交互式登录），留给 Windows 真机走查，需 owner 另行批准 |

Startup `.cmd` + launcher 在 CI 能证明的每一项都通过，没有触发“有一项不过就退回 owner”的条件。S4-3 推荐沿用这个机制，窗口方式用 `start "" /min`。

## 探针做法

1. 用 `net user` 新建本地普通用户 `byokprobe`。`whoami /all` 显示它属于 `BUILTIN\Users`，没有 `S-1-5-32-544`（Administrators），完整性级别 Medium。
2. 以该用户身份跑的每一步都经 `Start-Process -Credential -LoadUserProfile`（CreateProcessWithLogonW）启动。这个调用会把 runner 管理员的环境块原样带给子进程（`USERPROFILE`、`APPDATA`、`USERNAME` 都指向 `runneradmin`）。第一次 run 因此把 storeDir 和任务主体算到了管理员身上；之后每个用户脚本先按进程 token 和 ProfileList 重建这些变量再执行。
3. launcher 是 `cmd` 脚本 `launcher.cmd <stop-marker> <child.cmd> <log>`：每轮先查 marker，存在就以 0 退出；否则 `call` 子进程，退出码 0 就结束，非 0 用 `ping -n 11 127.0.0.1` 等约 10s 后重跑。`timeout.exe` 在没有控制台输入时会报错，所以用 `ping` 等待。
4. 被管进程是真实 CLI：`node packages/client/dist/bin/byok-agent.js start --config <cfg>`，配置为 `serviceEnrollment.enabled: true`、未配对、`serverUrl` 指向不可达的回环端口。这时 daemon 持有写锁、起控制端点、进入 `awaiting-enrollment`，不需要服务器。
5. stop 程序用 `bun build` 把 `packages/client/src/daemon/control-client.ts` 打成 Node 脚本：写 marker，发 `shutdown` RPC（同 `packages/client/src/bin/commands/unpair.ts:366`），用 `isControlDaemonGone` 轮询 15s，再检查两个文件。

## Q1：普通用户写 Startup 并拉起 launcher，安装进程退出后 launcher 存活

结论：通过。

证据（run 41404258931，步骤 “Q1/Q2 Startup .cmd install” 和 “Q1/Q2 launcher survives the installing step”）：

```
[min] standard user wrote its own Startup entry (installer exit 0) C:\Users\byokprobe\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\q12-min.cmd
acl owner: runnervmhao91\byokprobe
[min] launcher alive after the installer exited, owned by byokprobe launcher pids=6668 inJob=True
[min] managed child running under the launcher child pids=2372
--- 下一个 step ---
[min] launcher still alive in the next step pids=6668
[min] launcher.log: 7:10:15.91 start | 7:10:28.10 child-exit -1 | 7:10:38.14 marker-present end
```

`conhost --headless` 变体结果相同（launcher pid 4972 跨 step 存活）。

- 安装进程（用户身份的 pwsh）写完 Startup 项、执行一次后以 0 退出；launcher 和它的子进程继续运行，进入下一个 step 后仍在。runner 在 step 结束时没有杀掉它们。
- `IsProcessInJob` 对 launcher 返回 `True`，runner 的 step 进程本身也在 job 里。launcher 由 Secondary Logon 服务创建，它所在的 job 应来自 seclogon，不是 runner 的 step job（推断，探针没有读出 job 句柄身份）。真实登录时 Startup 项由 Explorer 拉起，job 上下文不同，需要真机走查确认。
- 新建、从未交互登录过的 profile 里 Startup 文件夹不存在：第一次 `[Environment]::GetFolderPath('Startup')` 返回空字符串，探针按 Explorer 默认位置 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` 建目录，之后的调用返回同一路径。

对 S4-3 的影响：
- 安装不需要管理员，Startup 项的所有者是用户本人，卸载同样不需要提权。
- S4-3 的安装器不能假设 Startup 目录已存在，要按该路径创建；`GetFolderPath` 返回空不代表没有 Startup 位置。真实交互用户登录过一次后目录总是存在，这一点只影响“安装后、首次登录前”的场景。

## Q2：`start "" /min` 与 `conhost.exe --headless`

结论：两者都能用。`conhost.exe --headless` 会去掉内层引号，推荐 `start "" /min`。窗口可见性在 CI 无法判定。

Startup 项内容（`install-user.ps1` 写入）：

```
start "" /min cmd.exe /d /c ""C:\byokprobe\launcher.cmd" "...\q12-min.stopped" "C:\byokprobe\longchild.cmd" "...\launcher.log""
start "" conhost.exe --headless cmd.exe /d /c ""C:\byokprobe\launcher.cmd" "...\q12-headless.stopped" "C:\byokprobe\longchild.cmd" "...\launcher.log""
```

进程表（run 41404258931）：

```
6668 cmd.exe  /d /c ""C:\byokprobe\launcher.cmd" "C:\byokprobe\state\q12-min\q12-min.stopped" "C:\byokprobe\longchild.cmd" "C:\byokprobe\state\q12-min\launcher.log""
1224 conhost.exe  --headless cmd.exe /d /c ""C:\byokprobe\launcher.cmd" "C:\byokprobe\state\q12-headless\q12-headless.stopped" ..."
4972 cmd.exe /d /c "C:\byokprobe\launcher.cmd C:\byokprobe\state\q12-headless\q12-headless.stopped C:\byokprobe\longchild.cmd C:\byokprobe\state\q12-headless\launcher.log"
```

- `start "" /min`：launcher 的命令行与 Startup 项写的一致，每个参数都带引号。
- `conhost.exe --headless`：conhost 自己收到的命令行完整，但它拉起的 `cmd.exe`（pid 4972）命令行里每个参数的引号都没了。探针路径不含空格，所以仍然跑通。路径含空格时（如 `C:\Users\John Smith\...`）参数会被拆开（由上面观测推断，探针没有跑带空格的路径）。`--headless` 也不是 conhost 的公开文档参数。
- 两种方式下 launcher 都能被拉起、能跑子进程，Q1 的存活和 marker 停止结果相同。
- CI 的会话没有可见桌面，`/min` 是否留下任务栏最小化窗口、`--headless` 是否完全无窗口，CI 看不到。

对 S4-3 的影响：用 `start "" /min`。它的引号行为可预测，用户名里的空格不会把路径拆开。代价是登录后任务栏可能有一个最小化的控制台窗口，真机走查时确认，如需隐藏再单独评估。

## Q3：launcher 循环和 stop 标记

结论：通过。

证据（步骤 “Q3 launcher loop and stop marker”，子进程按 `PROBE_SEQ` 依次退出）：

```
retry-then-clean runs: 07:01:10.493/exit=3, 07:01:20.885/exit=3, 07:01:31.310/exit=0   (run 41403371773)
PASS exit 3,3 then 0: three runs, launcher ends with exit 0
PASS rerun waits at least 10s after a non-zero exit gaps(s)=10.4978475,10.4591243        (run 41404258931)
PASS marker written during run 2 (exit 5): no run 3
PASS marker present before start: child never runs
```

- 非 0 退出后约 10.5s 重跑（10s 等待加上子进程启动）；退出码 0 后 launcher 以 0 结束。
- 子进程在第 2 轮写入 marker 再以 5 退出，launcher 等待后查到 marker 就结束，没有第 3 轮。
- 启动前 marker 已存在时，子进程一次都不跑。
- Q1/Q2 的 launcher 在子进程被外部结束（退出码 -1）后同样查到 marker 结束：`child-exit -1 | marker-present end`。

对 S4-3 的影响：这个 `cmd` launcher 可以直接作为 S4-3 的循环实现，不需要 PowerShell 或额外依赖。

## Q4：`byok-agent` daemon 做被管进程，stop 后清理

结论：通过。

证据（步骤 “Q4 byok-agent daemon under the launcher, then stop”）：

```
PASS daemon started under the launcher: control.token and daemon-owner.json exist
{"kind":"lifecycle","lifecycle":{"phase":"awaiting-enrollment"}}
{"kind":"daemon-started","productId":"byok-probe-q4"}
--- stop 程序（以 byokprobe 身份）---
{"phase":"status","status":{"localAgentRelease":{"version":"0.34.0"},"pid":2196,"paired":false,"lifecycle":{"phase":"awaiting-enrollment"},...}}
{"phase":"shutdown","ok":true,"r":{"acknowledged":true}}
{"phase":"gone","gone":true}
{"phase":"after","control.token":false,"daemon-owner.json":false}
PASS stop program: shutdown RPC, daemon gone, control.token and daemon-owner.json removed
launcher.log: 7:10:49.98 start | 7:10:58.05 clean-exit end
PASS launcher ended after stop without restarting the daemon
daemon.log: shutdown-requested → lifecycle stopped → shutdown-complete (undeliveredOutboxCount 0) → daemon-stopped
```

- daemon 以普通用户身份在 launcher 下启动，store 在 `C:\Users\byokprobe\.byok\byok-probe-q4`。
- stop 程序经控制端点认证并发 `shutdown`，daemon 走完 `shutdown-complete` 后退出，两个文件都被删除，`isControlDaemonGone` 为真。
- `start`（非 `--service`）在受控关闭后以 0 退出，launcher 走 `clean-exit` 结束。marker 是第二道保险：即使 daemon 以非 0 退出，launcher 也不会再拉起它（Q3 已证）。
- 本探针的 daemon 是未配对的 enrollment 模式。已配对 daemon 的 `shutdown` 路径相同（同一个 control 方法），但它的连接与任务排空没有在这里覆盖。

对 S4-3 的影响：`stop()` = 写 `<name>.stopped` + 发 control `shutdown` + 等 `isControlDaemonGone`，就能干净停下 daemon 且不被 launcher 重启。

## Q5：Task Scheduler 对照组

结论：不通过。普通用户在 CI 里跑不起任何任务；管理员 S4U 对照显示非 0 退出不会重启，`/End` 不是优雅退出，连子进程也不结束。

普通用户（步骤 “Q5 Task Scheduler control group”）：

```
RESULT schtasks-onlogon exit=1 :: ERROR: Access is denied.
RESULT register-atlogon-interactive ok
RESULT register-Interactive ok
RESULT start-Interactive ok
RESULT register-S4U error :: Access is denied.
RESULT register-Password ok
RESULT start-Password ok
RESULT restart-Interactive runs=0 lastResult=267011 lastRun=11/30/1999 00:00:00
RESULT restart-Password runs=0 lastResult=267011 lastRun=11/30/1999 00:00:00
RESULT end-skipped no logon type ran a task for this user
```

- `schtasks /Create /SC ONLOGON`（不带 `/RU`，触发器是任意用户登录）被拒绝。
- `Register-ScheduledTask` 用 `-AtLogOn -User <本人>` 加 Interactive 主体可以注册。
- S4U 主体注册被拒绝；Password 主体（存用户密码）可以注册。
- Interactive 与 Password 任务 `Start-ScheduledTask` 返回成功，但 170s 内一次都没跑，`LastTaskResult` 为 267011（`0x41303`，SCHED_S_TASK_HAS_NOT_RUN）。Interactive 任务需要用户已交互登录，CI 没有。Password 任务没跑的原因探针没有读出，可能是普通用户缺少“作为批处理作业登录”权限（推断）。所以普通用户身份下重启与 `/End` 两项在 CI 无法判定。

管理员 S4U 对照（同一步骤 “Q5 control: runner administrator, S4U”），用于看机制本身的行为：

```
RESULT restart-S4U runs=1 lastResult=3 lastRun=11/02/2026 07:14:07
RESULT daemon-task-S4U ready=True
RESULT end exit=0 :: SUCCESS: The scheduled task "byok-probe-daemon" has been terminated successfully.
RESULT after-end daemonAlive=1 controlToken=True daemonOwner=True
RESULT after-end daemonStoppedRecords=0
```

- 设置 `RestartCount 2`、`RestartInterval 1 分钟`，动作以 3 退出，170s 内只跑了 1 次。Task Scheduler 的失败重启不覆盖“动作进程以非 0 退出”。
- `schtasks /End` 报告成功，但它只结束了任务动作的 `cmd.exe`；作为子进程的 `node` daemon 10s 后仍在运行，`control.token` 和 `daemon-owner.json` 都还在，daemon.log 里没有 `daemon-stopped`。

对 S4-3 的影响：Task Scheduler 不满足契约。普通用户注册 logon 任务只能用 Interactive 或 Password 主体（后者要存用户密码）；非 0 退出不重启，仍需要自己的 launcher 循环；`/End` 不能代替 control `shutdown`，还会留下孤儿 daemon。它相对 Startup `.cmd` 没有优势。

## CI 无法证明的缺口

以下项目留给 Windows 真机走查（需 owner 另行批准）：

1. 用户交互登录时 Explorer 是否执行 Startup 里的 `.cmd`，以及在那条进程链下 launcher 是否存活（job 上下文与 CI 的 seclogon 路径不同）。
2. `start "" /min` 登录后的窗口表现（任务栏最小化窗口是否出现）。
3. 已配对 daemon 在 launcher 下的 `shutdown`（有连接和在途任务时）。
4. 路径含空格（用户名带空格）时 `start "" /min` 的引号行为。探针路径不含空格，`/min` 的引号保留是从进程命令行观察到的，没有用带空格的路径实际跑过。
