# G1c：持久请求与 receipt 契约

源码基线：`a06fbe6a83ee26a49199b51d2528531802117019`。本刀只增加研究、内部 store probe 和观察记录；没有修改生产 SDK、journal、公开 API 或版本。未验收产品接入。

## P1 / P2：当前 authority 与路径

`packages/server/src/index.ts` 的 façade 持有私有 cloud 和进程内 `dispatched` map；每次 dispatch 新建随机 taskId。`tasks.get` 是 snapshot 投影，不是可恢复的 TaskHandle。`packages/server/package.json` 只导出根入口与 package.json；内部 `createSqliteEmbeddedStores` 不能作为产品公开入口。

`packages/cloud/src/cloud.ts::enqueueTaskEnvelope` 接受 caller taskId。稳定 messageId 绑定 tenant、taskId、deviceId、AgentRef；顺序是 open/reserve attempt → immutable offer receipt → mailbox append → delivered receipt。它们不是一个跨 store transaction。相同身份的重试依靠稳定 messageId 和 first-write-wins 收敛；已存在 delivered receipt 的重试会报冲突，不能将所有冲突当成成功。

`readTaskResult` 优先读取持久 cancellation tombstone，否则从 terminal receipt 投影。task status 不能重建丢失的 terminal payload。SQLite composition 从 in-memory cloud 展开而未替换 receipts；task 与 cancellation 持久化不意味着正常终态结果也持久化。

## 本机证据与边界

运行 `bun docs/researches/2026-09-09-g1c-receipts/store-probe.ts`，观察在 `store-observation.json`。临时 SQLite 自动清理；无凭据、provider、网络或产品写入。

实测同进程 first-write-wins 和 tenant 隔离成立。close/reopen 后 task 仍存在，三类 receipt 均不存在，receipt store 接受相同 key 的不同 body。脚本使用内部 composition 与合成 receipt body，只证明 store 生命周期；没有声称完整 enqueue、terminal projection、SIGKILL 或重复 start 的端到端验收。首次运行因 docs 目录不能解析 workspace bare import 在创建数据库前退出；改为显式源码入口后成功。

源码进一步支持、尚待端到端测试的反例：无 cancellation 的终态 task 重启后 readTaskResult 可能 undefined；offer/delivered receipts 丢失且旧 mailbox 行已清理后，同 taskId 可能重新进入 mailbox，旧 payload fence 也随 receipt 丢失。

另有独立范围风险：`packages/cloud-dataplane/src/cleanup.ts` 按 requestReceiptRetentionMs 删除 generic receipts，仅豁免 pairing-completion；持久 Postgres 本身不能代替 lifetime 契约。本刀没有修改或运行 Postgres。不能以改用 Postgres 宣称 G1c 完成。

## P3：最小恢复契约（待实现）

1. **先绑定再 enqueue。** host 在一次本地事务内保存已认证 account/workspace、外部请求及执行分支身份、目标 device/AgentRef、SDK taskId、完整不可变提交体或可验证摘要。提交成功后才调用 SDK。唯一键来自真实业务请求/执行分支，不能只用 instruction、全局 requestId 或可能跨周期复用的 research taskId。现有 research runner 的 `taskId#pass` 只用于 manifest 关联，未证明跨周期幂等。
2. **重试核对。** 恢复加载原绑定，禁止新建 taskId。同一身份不同 payload/target/scope 必须拒绝；重复提交冲突必须回读并核验原绑定和 SDK authority。缺失或不可核验时保持 uncertain/fenced，不能把冲突、timeout、connected 或本地 phase 当成接受证明。
3. **receipt 生命周期。** immutable offer body、delivered marker、first terminal bytes 的保留至少覆盖该执行身份仍可能重试的全部时间；mailbox ACK/清理不能使已交付身份重新变为新工作。若需要回收完整结果，必须另有不可重执行的持久 tombstone 和明确 expired 读取语义，不能简单删掉最后一个证据。10x 时先遇到 receipt/result 容量边界；容量不足应可观测地拒绝 admission。
4. **读取与取消。** 通过同一个 kernel authority 按持久 taskId 读取 attempt/result 并取消；重启不依赖旧 handle、内存 map 或 event subscriber。取消接受事实与 provider 已停止分别呈现，保留既有 tombstone 优先级。不得建立第二套 SDK 外执行状态机。
5. **consumer。** SDK terminal durable 后，host 校验身份并持久记录 result hash/consumer disposition，再按外部 consumer 契约提交。ACK 丢失时用同一 delivery identity 重试；远端不支持幂等时不能承诺恰好一次。held 不等于用户已收到，consumer 尚未定义时保持 held，不自动放开消息权限。
6. **恢复配置。** 固定 serverUrl、signer 和 device 绑定，显式 hostedJournal；server、daemon、host 分开故障域。journal 防止重复 start 不等于 provider 工作续跑成功。

## 验收矩阵

| 断点或反例 | 必须观察到的事实 |
| --- | --- |
| host binding commit 后、enqueue 前崩溃 | 恢复仍提交同一 taskId，只有一次可执行 offer |
| SDK append 后、delivered receipt 前崩溃 | 稳定 messageId 收敛；不新增可执行 offer |
| enqueue 返回前/host 回执写入前崩溃 | 原绑定回读并核验；不随机重新 dispatch |
| 同身份不同 payload/device/AgentRef/tenant | 明确拒绝，无跨 scope 读取/取消 |
| 终态 receipt 已写、task status 未写时崩溃 | first-terminal-wins 与状态收敛，保留原 bytes |
| 终态完成、ACK、mailbox retention、组合重启 | 同身份不再 executable；原结果可读或明确 expired |
| 上一场景随后更改 payload | 仍拒绝，不能因清理丢失 immutable fence |
| cancel commit 后响应丢失/重启 | 可读原 tombstone，取消重试不换身份 |
| consumer 已接受、host ACK 前崩溃 | 同 delivery identity 收敛；无凭内容猜测的 ACK |

每条端到端实验均需 task → offer/seq → start/sessionRef → terminal/hash → ACK 的归因链。原八组恢复 probe 只覆盖配置/投递归因，不能替代本矩阵。本刀 store probe 也不满足该矩阵。

## 实施顺序与 handoff

下一工作包先实现 SQLite receipt durability 与 lifetime fence，并用上述 restart/retention/changed-payload 反例验收。之后才确定最小 façade 投影（caller 确定的身份、read/cancel），或选择确实公开且可持久组合的 cloud 入口。G0 consumer/消息权限仍需产品契约；本刀没有设计新的恢复 API，也没有批准发版。
