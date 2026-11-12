# 协调交接：2026-11-11

本文是 2026-11-11 换机时 byok-sdk 协调工作的状态快照。这里只记录事实、裁定和下一步，不含任何密钥。状态以 GitHub 上的 PR/issue 和 `origin` 分支为准；本文和它们冲突时，以 GitHub 为准。

## 1. 角色与授权

- **总控（原 mini-cf 上的 t3）**：派 writer/reviewer seat、合并、推 main、关 issue。
- **策划（原 mini-cf 上的 t4）**：出计划、拆分、裁定和建议，不执行、不派工、不合并。
- 发版、MINOR 批准、关 issue、花钱的操作，只认 owner 本人的原话。别人转述、示例话术和 advisor 的意见都不算批准。
- 跨机器只走 hc（`hc run|exec|file --on <machine>`）。不开 raw ssh、scp 或隧道，也不做 Cloudflare Access 登录。
- commit 和 PR 不带 AI attribution。PR 正文只用 `Refs #N`，不用 closing keyword（`Fixes` 和 `does not close #N` 都会触发关闭）。

## 2. 分支状态

- 现役只有一条发布 lane，就是 main。`58576c2ec` 是 PR #1872 的 merge commit，把 train/next-minor 合了进来；train/next-minor 就此退役，不再有 main→train 的同步 PR。
- 下面两条是写本文时（2026-11-11）的状态，只作历史记录：
  - main：`06605ea91`（batch main-1：#1779、#1794、#1786）
  - train/next-minor：`41216a2c3`（batch train-2：#1797、#1798、#1800）

## 3. 合并方式（owner 2026-11-11 裁定）

改用批量合并，不再逐个串行合：

- **分批**：只开一条 batch 分支，名为 `batch/main-<n>`，收进所有 review 已通过的 PR。CHANGELOG、README 预算表和 upgrade-manifest 在 batch 上统一处理一次（脚本重新生成），CI 只跑一次。
- **合并**：batch 用 squash 合进 main，正文逐行列出 PR 和对应的 `Refs`。合完后把原 PR 关掉，留言「merged via batch #N」。
- **失败**：batch 挂了，只移出出问题的 PR，其余照合。
- **节奏**：一个 PR 的必需 CI 全绿、review 按 tier 拿到 PASS，就立刻合，单独合或攒成小批都行。什么时候合由总控和策划定，不问 owner（2026-11-12 总控与策划的联合作法）。
- **不变的门**：review 门、tier、closing-ref 检查和 AI trailer 检查都不变。
- 合并管家 seat 负责 rebase 和生成文件，不改产品代码。golden `.d.ts`、`api-surface`、CHANGELOG、upgrade-manifest、README 预算表这些生成物的漂移，由管家在合并时重新生成，不因此退回 PR；只有产品代码冲突才退回 writer。
- issue 的修复合进 main 后，随即留言关闭，不再等发版（owner 同日裁定）。

## 4. 在途 PR（2026-11-11 快照，仅作历史；现役只有 main 一条 lane）

| PR | base | 内容 | 状态 |
|---|---|---|---|
| #1822 | main | batch main-2（#1814、#1817、#1821） | 等 batch CI |
| #1823 | train | batch train-3（#1802、#1816、#1820） | 等 batch CI |
| #1813 | train | 1759-11：win32 上配置根拒绝 symlink/junction | 两个 Claude reviewer 在审；要做 win-ci 真机验证 |
| #1814 | main | #1730：Pi host 启动时设 3000 ms family attempt timeout | 在 main-2 里 |
| #1817 | main | #1815：mailbox-wake 测试隔离（只改测试） | 在 main-2 里 |
| #1821 | main | #1819：dataplane 测试拆除时删 bucket | 在 main-2 里 |
| #1802 | train | #1780-1：删 `TaskAttemptStore.open`，`agentRef` 必填，加一次性迁移 | 在 train-3 里；产品代码预估 130–170 行，超过 170 行要停下问 owner |
| #1816 | train | Desktop A1 外壳和 bridge 骨架（#1804） | 在 train-3 里 |
| #1820 | #1804 分支 | Desktop D0 打包探测（#1803） | 在 train-3 里 |

## 5. 今天 owner 直接批准进下个 MINOR 的项

均为 owner 在问答框的原话批准。issue 和 PR 里都不写 MINOR 版本号。

- **#1759-1**：`runtimes.<id>.runtimeEnvironment` 整体替换顶层策略（#1768，已合 train）。`config check --json` 的顶层 key 保留，只做加法。
- **#1762**：Bot 回复先 stage，再和 Turn outcome 在同一个事务里提交；失败的 Turn 不发回复（#1770，已合 train）。合入后需要 AiphaBee 在 `k8RootUploads` 里加结论检查，已通知 t8。
- **1759-7、1759-9、1760-2、1756-6**：均已合 train。
- **1758-2**：删除 `RuntimeExecutionFailure.category`（已合 train）。AiphaBee 有 2 处测试字面量要改，已通知 t8。
- **1756-5**：WouldDo 必填 turnId；迁移补不出的旧行归档并计数；没跑迁移的 store 在 retention 时拒绝（已合 train）。
- **1757-5**：offer 组合规则移进 predicate。reader+commit 复用 `agent_memory_selection_invalid`，新增 `native_sessions_selection_invalid`（#1791，已合 train）。predicate 的顺序表以 `docs/protocol.md` 为唯一来源，新规则只能追加。
- **scope-key v1**：open 和 read 路径删除 v1，不做迁移，升级前由 operator 跑 count=0 检查（#1790，已合 train）。
- **A3-1（#1780-1）**：一次性迁移。已 terminal 的 agentless attempt 先做 redaction、board removal 和 object refs 清理，再退役；还有非 terminal 的就拒绝升级。原因是 Salesko 0.22.0 的 attempt 行 `agent_id` 全为 NULL（#1802，在途）。
- **1759-11**：方案 A（#1813，在途）。
- **#1730**：不公开的 3000 ms 默认值，进 main，不进 MINOR（#1814）。
- **#1499**：接受 R2（SEA Host 拒绝后台 Pi 子代理和 workflow，作为 v1 限制），拆成 #1803–#1812 后开工。

只记录、不发起的：wire v7 的范围是 (a) 删 server capability 通道、(b) 删 `limits.maxTokens`、(c) 合并 runtime 判别字段，其中 (c) 要先定 v6 receipt 的策略。见 #1757 评论。

## 6. 部署日（#654/#794）

owner 定在今天做，只用 mac-pro；win-ci 的那几行改到下次部署。执行单由 t25g 编写。

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 预检 | **已完成**：C1、C2，以及 C11 在 `bfe8b08d6` 上构建，exit 0，wrangler 4.158.0 |
| P1 | C3–C10，需要 owner 本人做 | **尚未开始**。写本文时 owner 还没做 C3 |
| P2 | 部署和 C14–C22 冒烟 | 任何一项失败就中止 |
| P3 | 不需要 keychain 的行 | |
| P4 | 需要 mac-pro keychain 的行：row 2.7、W2 设备行、W1 5.11、W4 成员页 | owner 要在 mac-pro 前，约 45 分钟 |
| P5 | teardown T0–T9 | 当天完成：删 dev branch `byok-p9`、R2 bucket、两个 Hyperdrive 配置、当天的 API token，以及（如果建了）专用 keychain |

- **C3–C10 是什么**：C3 开通 Workers Paid；C4 在 PlanetScale 的 aiphabee-staging 上建 dev branch `byok-p9`；C5 跑 `c5-roles.sql` 并设两个角色的密码；C6 跑只读的 `c6-baseline.sql`；C7 建 `byok-p9-h` 和 `byok-p9-canary` 两个 Hyperdrive 配置；C8 建 R2 bucket `byok-p9-staging` 和只限该 bucket 的密钥；C9 建当天过期的 Workers 部署 token；C10 填 `p9.env`。
  - SQL 和 env 模板在 mini-cf 的 `/private/tmp/byok-sdk-wt-runbook/_ops/p9/` 下，换机后要重新取。
- **停止条件**：C5 的 GRANT 报错；C6 主版本不是 18（生产是 18.6）、ssl 关闭或空闲连接少于 13。遇到任何一项都停下汇报，不自行改数据库配置。
- **红线**：AiphaBee 的三个 Hyperdrive 配置不打开、不修改。seat 不创建 Cloudflare 资源。凭证由 owner 自己输，seat 不读、不打印 secret 的值。
- **row 2.7**：keychain 写入在 GUI 终端里也 exit 36。P4 owner 解锁后仍失败的话，改用专用 keychain：通过公开的 `deviceCredentials.macosKeychainPath` 指过去，在执行记录和 #654 里注明这是对 runbook 的偏离，teardown 时删除。
- **换机提醒**：如果新机器接手时 C3 之后的资源已经建了，当天必须按 P5 拆掉，否则会持续计费。

## 7. 开着的 issue（27 个）

- **部署和真机**：#654、#794（部署日）；#605（Windows Agent 记忆）。#605 由 owner 在 win-ci 上开 Hyper-V、提供镜像，开 Hyper-V 需要 admin 加重启，列为 owner 步骤。只读准备由 seat 做（byok-ro-605）。
- **Desktop**：#1499 是父 issue。子 issue：
  - D0 #1803、A1 #1804：在做。
  - A2a #1805：等 A1 推送后开工。
  - A2b #1806、A5 #1809、A6 #1810：等 A2a 推送后并行。
  - A3 #1807、A4 #1808：等 A2b。
  - A7 #1811：等 D0 和 A2a。
  - A8 #1812：最后做。
  - 后面会需要 owner：Developer ID 签名和公证，以及 win-ci 上的 koffi 哈希检查。D0 的 Linux 行在 GitHub ubuntu runner 上跑。
- **#1656 的延后项**：#1756–#1760。分诊结果在各 issue 评论里，每项标为 M、T 或 X。
  - 已做：1756-1/2/5/6、1757-1/5、1758-2/8、1759-7/9/11/12、1760-2/9。
  - 1758-1 等 #1619。
  - 其余 T 项需要 owner 批 MINOR 或 wire major，暂不排。
- **其他**：
  - #1767：等 AiphaBee #939 用公共路线 `createDaemonWithAdapters(minimal, []).unpair()` 跑通，再请 owner 关。文档已合（#1769）。
  - #1780：-1 在途，-2、-3 已合。
  - #1815、#1819：修复在 main-2 里。
  - #1818：Windows 上 agent-home-contract 的 fixture spawn EFTYPE，尚未分诊。
  - #1730：#1814 合入后关闭。
- **上游阻塞**：每轮查一次。
  - #1619 等 deepseek-harness discussion 12515，11-07 起没有回应。
  - #1620 等 NousResearch/hermes-agent#149876，11-07 起没有回应。

## 8. 常设规则

- **预算**：每行上调不到 2 KB、调到实测值的，预先批准；达到 2 KB 及以上，由策划批。PR 正文写实测数值和批准记录，不能写找不到出处的批准。
- **生成产物**：README 预算表、`api-surface/entries.json`、`packages/client/upgrade-manifest.json` 都是生成的，可以直接重新生成。
- **golden 里的内部声明**：不从任何入口导出的，加法按预批准处理，PR 正文注明「internal declarations in the golden, not exported from any package entry」。
- **审查**：high tier 两个 reviewer，medium 和 low 一个。ChatGPT seat 配额耗尽期间，owner 允许用 Claude 审查 seat，配额恢复后切回。writer 不兼任 reviewer。
- **外部意见不是硬门**：GPT 审查连续两次起不来，就记为 SKIPPED 后照常合入，不无限期等。
- **安全修正要相称**：中低风险的问题，选不伤产品的做法，残余风险写进文档；只有 high 才加严格的新检查。为推测出来的竞态加逻辑，要先问 owner。
- **不留 best-effort 路径**：吞错误、编造默认值的分支要删掉或改成 fail closed（#1774 这一批）。
- **win-ci**：
  - 开着 NordVPN 时 hc 会断。连不上时停下 win-ci 的工作，报告一次。不做登录或重连，也不要求 owner 登录。
  - 交给 seat 前，先问 t8 有没有 AiphaBee 的 Actions run 在跑。
- **下游消费方**：以 owner 当前的 Salesko checkout（salesko-new）为准，不用旧的 salesko 目录；只读。

## 9. 未决事项

- 下个版本发布前要满足的条件，统一列在 #1918。新增条件只写进那里，不再散落在 issue 评论里（#1851 原有的 OAR 条件已并入）。
- 部署日 P1 起的所有步骤（见 §6）。
- #1802 的产品代码行数如果超过 170，要问 owner。
- #1818 尚未分诊。

## 10. 不随本 PR 迁移的东西

mini-cf 的 scratchpad 里有若干只读设计包和审计报告，结论都已经写进各 issue 的评论：#1759-1、#1762、#1767、#1499、#1730、1759-11、1757-5、P2 wire major，以及 A1–A4 审计。换机后以 issue 评论为准。部署日执行单和 SQL 只在 mini-cf 上，新机器要通过 hc 去取，或者请 owner 把文件拷过去。
