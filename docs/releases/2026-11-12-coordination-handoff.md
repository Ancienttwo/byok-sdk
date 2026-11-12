# 协调交接：2026-11-12

2026-11-12 15:45Z 换机时 byok-sdk 协调工作的状态快照，接替 [2026-11-11 那份](2026-11-11-coordination-handoff.md)。那份的 §1（角色与授权）、§3（合并方式）、§8（常设规则）继续有效，本文只写今天变了的和在途的。状态以 GitHub 上的 PR/issue 和 `origin` 分支为准；本文和它们冲突时，以 GitHub 为准。不含任何密钥。

## 1. 等 owner 的决定

排在最前面的一项挡着 0.42.0。

1. **#1985 的修复循环停在 owner。** #1983（`install()` 对已存在的 stores 不跑 `precheck`、snapshot、`migrate`）经总控和策划联合决定列为 0.42.0 的 precondition。修复 PR #1985 在 `d3300ea87` 上被 Codex 复审读出两个 P1 数据问题：还原 snapshot 失败后仍重启旧服务；`prune()` 会删掉还原失败后留下的唯一备份。两个都在代码里核实过。修法已定型，写在 #1983 最新一条设计评论里。owner 二选一：
   - 维持 precondition，按该修法继续修。最快 11-14（台北时间）发版，取决于 review 轮数。策划的建议是这一项。
   - 否决 precondition，照发 `06a14462e`。11-13 发版，#1983 进 Known issues，AiphaBee 自己在 `install()` 前跑 `precheck` 和 `migrate`，或者等下一版。
2. **`install()` 要不要 write-ahead 记录**（安装程序在 snapshot 之后被杀掉的窗口）。默认 0.42.0 不做，文档写明 Host 的 `migrate` 必须能在中断后重跑。按 #1983 的修法，这种情况下 migration 前的备份会留在磁盘上，可以手动恢复。
3. **#1987** 要不要并进 #1985：`upgrade()` 在还原失败后同样重启旧版，0.41.0 已带着；receipt 留在 pending，`recover()` 能重做还原。策划建议下个周期单独修。
4. 不挡 0.42.0 的 owner 步骤：恢复 harness policy（#1914、#1959 的 cloud-do 归档等它）；#1904 的 Developer ID 签名和公证；给 pi-subagents、DSH、OAR 的上游请求；归档合入后对已发布的 `@byok-sdk/cloud-do` 版本做 `npm deprecate`。

## 2. 发版状态（0.42.0）

- 只有 main 一条 lane。当前 main 是 `06a14462e`，它的 push CI 是绿的。
- precondition 清单只在 #1918。未结的三项：
  - nightly 完整矩阵在 candidate 上跑绿。`ci.yml` 的 cron 是每天 19:43Z，一次约 75 分钟。
  - owner 核准 release validation 的 `workflow_dispatch`（填 candidate SHA），AiphaBee 用 validation tarballs 测一次。
  - owner 做 `npm publish`、tag、GitHub Release。`@byok-sdk/bot-collaboration` 的首次 publish 要 owner 另行授权。
- candidate 是哪个 commit 取决于 §1 第 1 项：维持 precondition 的话是含 #1985 的那个 commit，precondition nightly 是合并之后的第一次；否决的话是 `06a14462e`，今晚的 nightly 就算数。
- nightly 的 flake 规则：只有 cloud-do wake-inbox 那个测试（#1982）红、重跑变绿，算绿；任何地方连红两次算真的，交给策划；不改断言。
- 冻结期规则：只合 precondition 修复和 cross-model review 的发现；合并之前等上一次 main 的 code run 跑完，文档合并也一样，否则会把在跑的 run 取消掉。
- 一般发现的截止规则：修复要在当天 18:30Z 前合并、过两个 review 和一次 Codex 复读、main push CI 跑完，才进当晚的 candidate；review 不缩短，赶不上就列为 known limit。precondition PR 不走这条，走修复循环规则（每轮发现减少且范围不扩大就继续，第 5 轮硬停）。
- 已定为 0.42.0 Known issues 的：#1964（owner 原话「接受，照發」，只覆盖这一项，不是 publish 授权）、#1940、#1942、#1943、#1944、#1946、#1947、#1948、#1949、#1957、#1962。release prep 是 draft PR #1950，#1985 合并后要重新同步。

## 3. #1983 / #1985 的设计

完整裁定是 #1983 上策划的几条评论，以最后一条「Design state after the two P1 findings」为准。要点：

- store 准备（`precheck`、snapshot、`migrate`、再 `precheck`）由 `install()` 和 `upgrade()` 共用一个函数。只有没有 current version 时 `install()` 才跑它；同版本重装仍然只是修 unit 和 launcher。
- 停服务的规则：没有 unit 时不停；外来 unit（`replaceUnmarked`）不碰，只靠 store lease，被占用就回 `store_busy`；自有 unit 用正常的 stop 停掉，准备失败后重启。
- 还原失败后不启动任何服务。
- snapshot 两个名字：`.install-<uuid>` 由本次调用建立和删除，任何残留都保留、不自动还原；`.install-repair-<uuid>` 只在程序亲眼看到还原失败时改名得到，`prune()` 和 `uninstall()` 不删，下一次首次安装先从它还原。
- health check 失败后的清理顺序：unit、`current`、安装记录、staged 目录，最后才还原 snapshot。
- Host 看得到的变化要进 CHANGELOG 和 upgrade note：`install({ replaceUnmarked: true })` 在外来 agent 还占着同一批 stores 时回 `store_busy`；`uninstall()` 遇到保留的 snapshot 时不清空 `snapshots/`。AiphaBee 的协调 seat 已收到这两点。
- t2f6（writer）目前只做「不重启、`prune()` 和 `uninstall()` 不删」这几项防护，自动还原那段等 owner 答复。

## 4. 在途 PR（13 个）

| PR | 内容 | 状态 |
|---|---|---|
| #1985 | #1983 的修复 | 停在 owner，见 §1 |
| #1950 | 0.42.0 release prep | draft，全绿，等 nightly 和 owner 步骤 |
| #1958 | 取消的 recovery offer 不经 runtime 结算（#1944） | 已裁定不进 0.42.0，held |
| #1968 | 重启后保留已取消的 offer（#1955） | draft，有红灯，已派回原 seat |
| #1973、#1976 | Desktop：#1948、#1947 | draft；#1976 有红灯，已派回原 seat |
| #1974、#1979、#1980 | Pi：#1949 的三段 | draft；#1979 有红灯，已派回原 seat |
| #1975 | memory 的 startup 等待（#1943） | draft |
| #1951 | `resolveHostLayout` 移到 `@byok-sdk/client/host-layout`（#1925） | draft，有红灯，没有活着的 seat |
| #1953、#1954 | 研究记录：#1927、#1619 | 文档，held |

除 #1985 和 #1950 外都是下个周期的工作，0.42.0 发布前不合。

## 5. 开着的 issue（41 个）

- **挡发版**：#1983。
- **今天 cross-model review 的发现，下个周期修**：#1940、#1942–#1944、#1946–#1949、#1955、#1957、#1962、#1964、#1965、#1970、#1971、#1977、#1984、#1986、#1987。
- **下个周期的设计项**：#1925、#1927、#1932、#1933、#1959、#1978、#1981。#1978 和 #1981 是 AiphaBee 报的，今天已分诊，对方说 0.42.0 不需要。
- **等 owner**：#605、#654、#794、#1904、#1914、#1915。
- **tracker 和 umbrella**：#1918、#1972、#1982、#1911（nightly 绿了就关）、#1836、#1846、#1757、#1619。

## 6. 今天新增或改动的规则

- **数据、认证、密钥、安全类的 P1**：review seat 保留的这类 P1，先到 owner，总控和策划不能自行判为不挡发版。issue 一旦引用 #1918，同一步就把 #1918 上的那一行写好。
- **cross-model review 的计数规则**：verdict 要写明精确范围（`merge-base(base, head)..head`）、读过的文件数对上 `git diff --name-only`、跳过的文件和理由；超过约 1,000 行而零发现的 PASS 要抽查。给对抗式复读点名目标（「成立并说明理由，或者给出打破它的操作序列」）比泛读有效。
- **review seat 的构成**：high tier 是一个 Claude Opus 加一个 Codex 对抗式复读；只有删除凭证、custody、往 fork 推送这几类才加第二个 Claude reviewer；纯文档和纯 example 的 diff 用 Sonnet。
- **Pi 上的 seat 没有 OS sandbox**：不接碰凭证的任务，不启动 Host 或 daemon，不碰 keychain。keys、custody、删除凭证和往 `Ancienttwo/oar` 推送只给 Claude seat。
- **额度**：Claude Code 7 天额度用到 92%，2026-11-14 22:00Z 重置。剩余的留给恢复顺序有变动时的最后一读，其余复审走 Codex 和 Pi 上的 Opus seat。Codex 主额度显示耗尽但有 credits 时，launcher 会拒绝启动，手动绕过 launcher 需要 owner 当次会话的原话。
- **OAR fork**：base 是 `v0.101.0`（`byok/0.101.0`）。每个发版周期在冻结前 bump 一次（owner 的规则）；之后的 tag 归下个周期。任何 seat 都不在 `botiverse/oar` 开 issue 或 PR。
- **策划 seat 不空等**：等总控时继续做下个周期的设计和研究，自己读 CI；冻结期间下个周期的工作在分支上做，PR 留着不合。

## 7. 换机后要重新建立的东西

- hc 的终端地址（t3、t4、t1nq、t2f6 等）只在原机器上有效。新机器上先 `hc ls` 按 cwd 找到对应终端，不向猜测的地址发消息。
- 原机器上的共享 checkout 有其他会话在用，分支工作只在单独的 worktree 里做。
- 策划 seat 的草稿都已贴到对应的 issue，没有只留在本地的结论。
- 运行时的本地 memory 不随 PR 走；需要的规则已写在本文和 2026-11-11 那份里。

## 8. 策划 seat 的下一步

1. 拿到 owner 对 §1 第 1 项的答复，转给总控；维持 precondition 的话，盯 #1985 的下一轮复审。点名目标：找一条经过 `install()`、让 `current` 和 `.install-repair-*` 同时存在的路径（预期没有）；确认没有任何路径从残留的 `.install-<uuid>` 还原。
2. 读今晚 19:43Z 的 nightly（跑在 `06a14462e` 上），按 §2 的 flake 规则判定。
3. 欠总控的：#1964 的设计说明；fork lane 的顺序（#1957 和 #1942 的 fence，然后 #1932 和 #1940）；#1946；#1927 的第二项检查；#1951 和 #1954 的 CI scope 红灯。
