# 可归因恢复 probe：2026-09-09

## 结论

八组真实 public server/daemon + SIGKILL 对照通过。新实验把三次 start 明确分成
**旧任务 A 两次、新任务 B 一次**：第一次 A 的 offer 已投递但未在服务器 ACK；
无 journal；重启切换 URL 后客户端换用空的 cursor namespace，同一 offerId/seq
再次投递并 start A；恢复屏障之后的显式 façade dispatch 新建 B，另一次 start。

固定 URL 的两个无 journal 对照（已 ACK / 未 ACK）均 A=1；变更 URL 但 offer
已 ACK 的对照也 A=1。显式启用 journal 后，终态在“服务器消费前”或“服务器
已消费但响应尚未返回”两个窗口崩溃，恢复均不再次 start A，且同一终态 hash
由 pending 变 confirmed。恢复后再调用 façade dispatch 产生 B，A=1、B=1。

**这证明受控新实验的机制，不证明历史 raw report 当时一定换了端口。** 原报告
没有 URL/task-bound start 证据；原 exact-2 assertion、历史失败报告均未改动。
没有证据把三次 start 归为 Agent journal 缺陷，也未证明任意 provider 副作用
的 exactly-once。实验是组合 server+daemon 子进程崩溃，无真实 provider 调用。

## 最终对照矩阵

| 报告（reports/） | 崩溃点 / 配置 | 实测 |
| --- | --- | --- |
| fixed-no-journal-acked.json | 固定 URL，无 journal，服务器已 ACK | A=1 |
| fixed-no-journal-pending.json | 固定 URL，无 journal，本地 cursor=1，服务器 ACK=0 | A=1 |
| fixed-journal-pending-terminal.json | 固定 URL，journal terminal pending；终态 HTTP 请求在服务器消费前持留 | A=1，同 hash confirmed |
| fixed-journal-terminal-response-held.json | 固定 URL，服务器 Complete；终态响应持留，client journal 仍 pending | A=1，同 hash confirmed |
| fixed-journal-then-dispatch-B.json | journal 消费前窗口恢复确认后，显式提交同一 host request | A=1、B=1 |
| changed-url-no-journal-pending.json | 切 URL，无 journal，未 ACK，仅恢复 | A=2 |
| changed-url-no-journal-pending-then-B.json | 上述恢复完成后显式提交 B | A=2、B=1 |
| changed-url-no-journal-acked.json | 切 URL，无 journal，已 ACK，仅恢复 | A=1；新本地 cursor 仍缺失 |

## 一条完整身份链

见 `reports/changed-url-no-journal-pending-then-B.json`：

- hostRequestId `2daa16e8-f2a5-48e4-a183-03b060a87fe2`。
- A=`d406955d-1e6a-4cc6-a9b8-3914d728ba86`，offer=`1af27b72-278d-8dee-a4da-da88d2cfb90c`，seq=1。
- first URL `http://127.0.0.1:50729`：local cursor=1、server delivered=1 / ACK=0，offer pending。
- recover URL `http://127.0.0.1:50730`：deviceId 不变，新 namespace cursor=null；服务器 offer 仍 pending。
- 同一 A/offer/seq 在新进程投递并再次 start，两次 sessionRef 不同且各自记录。
- A 的 offer 已 ACK、两次后续空 poll 响应和 Complete 状态构成恢复屏障，随后才调用 façade dispatch。
- B=`a439c880-41c5-4037-9e0f-99ca8347f13d`，新 offer=`8eef62a5-60c5-8697-b058-b631d1b90f7e`，seq=2，仅一次 start。

没有按 instruction 或 phase 归因。start 使用 public `input.manifest.taskId` /
runtimeId / agentRef，并在 fsync 前要求同进程曾实际输出同任务的单一 offerId/seq。
随后以该 start 返回的 sessionRef 建立执行记录。HTTP wrapper 观测真实 SDK wire，
只保留身份与状态，不输出 header、credential、env、message body 或完整本地路径。

## 屏障与状态语义

正常 URL 由父进程预选并固定；端口占用会直接失败，不自动换端口。`connected`
仅用于准备首次 dispatch，不是恢复完成屏障。恢复以 server mailbox ACK、相关
terminal confirmed（journal 组）及后续顺序空 poll 为准，再断言 start 计数。

journal 使用 public `hostedJournal:{mode:'sqlite'}`，dispatch 仍是 legacy task.offer，
AgentRef=null。SQLite 只读采样 admitted/claimed_runtime/local_state/terminal hash 与
truth_state；没有写 SDK DB、游标或注入内部 DI。
`journal_envelope.acked_at` 虽记录其原始值，但当前未被生产写入，不能充当 ACK。
`journal_terminal.attempt` 不是 HTTP 重发次数；实际 sends 由 HTTP 事件记录。
terminal response 的 accepted/rejected 是整批计数，HTTP 200 不是逐消息成功凭证；
本地 confirmed、服务端 task 状态和同一 terminal hash 分别记录，不混称。

新的 URL 在 offer 已 ACK 时收不到任何 offer，不会因空 poll 而创建/推进本地游标。
初版 probe 错误要求该组 localCursor>=offer.seq，导致诊断超时。其原报告保留为
`initial-probe-barrier-failure.json`，不是 SDK failure。最终 barrier 仅在显式 changed-URL
ACKed 控制组允许 localCursor=null，同时仍要求 durable server ACK、acked mailbox
和后续空 poll；负例测试证明缺失 server ACK 时不得放行。

## 复现（安装隔离消费者）

从 SDK 分支根目录执行。需要 Node >=22.22.0、Bun、可用 OS credential store。
脚本位置是测试目录，不更改任何生产实现或公开 API。

```sh
bun install --frozen-lockfile
bun run build
(cd packages/server && bun pm pack --destination ../../_ops/recovery-pack)
npm install --prefix _ops/recovery-consumer --no-save --package-lock=false --ignore-scripts --no-audit --no-fund @byok-sdk/client@0.16.0 ./_ops/recovery-pack/byok-sdk-server-0.16.0.tgz
cp packages/server/src/__tests__/recovery-probe/{probe,evidence}.mjs _ops/recovery-consumer/
node --test packages/server/src/__tests__/recovery-probe/evidence.node-test.mjs
node _ops/recovery-consumer/probe.mjs --out _ops/recovery-evidence-new
```

`--out` 必须是不存在的新目录；报告不覆盖。可加 `--scenario <矩阵中的文件名去掉.json>`
只跑一组。不要设置 BYOK_TEST_DEVICE_CREDENTIAL_STORE。每组随机 productId，真实 OS
test enrollment，临时状态为 0700、signer 为 0600；每组最终 unpair 并删除状态，
八组均回读 testStateRemoved=true。报告无 secret；临时 signer 从不复制入 Git。

独立消费者必要：Bun isolated workspace 不保证 docs/root probe 可以解析 server
和 client 的全部 dependencies。初始两个 loader 失败发生在任何配对之前；最终
标准 npm 环境安装固定 client 0.16.0 和候选 server（仍标 0.16.0，未发布）。确切
artifact、dependency manifest 与 probe/report SHA-256 见 evidence-index.json。

## 验证与边界

八组 probe passed；四项 evidence validator 负例/正例测试 passed。最终 required
checks 结果另外记录在本轮 plan / notes；不能把诊断通过扩张成产品端到端验收。
本次仅新增 probe、测试和研究记录，没有修改生产 journal、迁移校验、driver 或 API。
Schema 约束完整性、driver collision 差异、receipt 持久化仍是分开的待办。
下一刀应从这些实测配置出发明确 G1c 的 durable request/receipt 组合，而非先补一个
“修三次 start”的 journal patch。原 façade 无 caller request identity 的窗口仍存在。
