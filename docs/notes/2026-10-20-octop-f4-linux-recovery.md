# Octop F4：Linux 强杀恢复准入

Refs #554。方案为 #557 分支的
`docs/plans/2026-10-19-octop-adaptations.md` §7.4、§7.6 和 Q8，固定于
`6926a3821a0a54e1a9d1b6cc9ee6f2881f6ea78c`。
本切片基于 `origin/main@e05082b0830974000f68342cb7e708dbb2ee0d5b`。
F1–F3 已通过 `d256d11d` 合入该基线。

## P1：平台边界

[恢复套件](../../packages/client/src/__tests__/execution-recovery-kill.test.ts)
原来由 `process.platform !== 'darwin'` 跳过其他平台。
`git blame` 将该 guard 追到最初加入套件的 `adfc85a0`。
该提交没有说明 guard 的平台原因。
`2392c3ae` 后来加入 per-test macOS Keychain，并保留这个 guard。
不能据此倒推最初的限制一定来自 Keychain。

目前可确认的差异是原生凭据的测试环境。
macOS 的 [Keychain 夹具](../../scripts/testing/macos-keychain.mjs)
为每个测试创建独立 keychain，且只允许在 Darwin 上调用。
Linux 的生产 provider 已使用 `secret-tool`。
CI 的 [Secret Service wrapper](../../scripts/ci/with-secret-service.sh)
已经能在独立 D-Bus session 中启动并解锁真实 gnome-keyring。
原 baseline Linux job 已通过这个 wrapper 运行全仓测试。

进程路径已有 Linux 分支。
[process-tree](../../packages/client/src/adapters/process-tree.ts)
从 `/proc/sys/kernel/random/boot_id` 读取 Linux boot identity。
强杀夹具使用 POSIX process group、`/bin/sh`、Perl `setsid` 和 SIGKILL。
这些入口没有把恢复能力限制为 Darwin。
Windows 的进程组行为不同，仍由现有 lifecycle smoke 覆盖。

## P2：一次真实恢复的路径

1. 套件用 Bun 编译 daemon 和 cloud 两个可执行夹具。
2. [daemon 夹具](../../packages/client/src/__tests__/fixtures/execution-recovery-daemon.ts)
   调用生产 `createDeviceCredentialStore`。普通 Vitest 的进程内凭据替身不会进入这个编译产物。
3. 每个测试生成独立 product ID。凭据 provider 按 product ID 和 store identity 组成服务名。
4. Linux 子进程继承 D-Bus session 环境。`secret-tool` 经该 bus 读写真实 Secret Service。
5. daemon 被 SIGKILL 后，同一测试的 bus 和 keyring 仍存活。
   重启子进程可取回原凭据，再恢复 journal、terminal 和 Agent-home ownership。
6. teardown 用真实 unpair 子进程清理凭据，再删除测试目录。

F3 的两个 cancel 发起场景仍走原来的 journal fault points。
提交前强杀检查回滚和 `daemon_interrupted`。
提交后强杀检查按原字节重放 `task.cancelled`。
原有 terminal、runtime start count 和单 writer 断言均保持不变。

## P3：最小准入改动

套件开放到 Darwin 和 Linux。
CI 的 `execution-recovery-native` 增加 `ubuntu-latest` matrix leg。
两个平台运行完全相同的恢复与 SQLite journal 测试。
保留现有 macOS leg，保留全部断言和既有超时。

Ubuntu leg 安装 `dbus-x11`、`gnome-keyring`、`libsecret-tools`、`perl` 和 `procps`。
它复用已有 wrapper，未增加文件凭据 fallback 或内存凭据替身。
该 leg 设置独立的 `XDG_DATA_HOME` 和 `XDG_RUNTIME_DIR`，均位于新建的 `/tmp` 目录。
command 结束时删除该目录。测试本身的 scratch 仍由既有 tmp-root 夹具管理。
source SHA、OS、Node/Bun 版本和测试日志保存在 worktree 的
`artifacts/execution-recovery/`，再按平台分别上传。
上传路径不包含凭据目录。

只要一个原断言在 Linux 失败，就记录失败事实，调查环境与产品的实际边界。
本切片不删除用例、不放宽断言、不延长超时来取得绿色结果。
本切片也不修改生产恢复或结算代码。

## 验证与可复现入口

本地 macOS 的两个套件已通过：58 passed，0 skipped，exit 0。
本机 Docker daemon 未运行，因此不把这个本地结果当作 Linux 实测。
Linux 准入结果以本 PR 的 Ubuntu native recovery job 和保留的 artifact 为准。
最终 job URL、source SHA 与结果写入 PR 验证记录。

本地或干净 Linux 主机的测试命令为：

```sh
bun ci
bun run build
# macOS
bun run --cwd packages/client test -- src/__tests__/execution-recovery-kill.test.ts src/__tests__/journal-sqlite.test.ts
# Linux：先安装上述 OS 依赖，再按 CI 配置独立 XDG 目录
bash scripts/ci/with-secret-service.sh bun run --cwd packages/client test -- src/__tests__/execution-recovery-kill.test.ts src/__tests__/journal-sqlite.test.ts
```

YAML parser 和 native job 的 Bash 语法检查已通过。
根目录五项 required checks 的最终结果见 PR 验证记录。
Linux job 通过之前，本文只确认代码路径和所需环境，不声称 Linux 已通过。

F4 验证的是现有 SIGKILL 恢复，不验证 cgroup v2 收容。
⑥ C0 可以引用这里的 Linux 结果，不能将它当作 cgroup v2 的实现或验收。
