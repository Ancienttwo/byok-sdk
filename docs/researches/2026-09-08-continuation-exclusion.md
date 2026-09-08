# Continuation successor exclusion 定向核验

结论：**已有同 device、稳定 canonical Agent home 的在线 successor 排他保证（Handoff 方案 B）**。当前 Salesko baseline `2752ffe` 与 candidate `6bcf659` 均观察到释放前 successor 不启动；close 失败和 lease release 失败均有明确拒绝。无需为这个有限不变量新增 SDK wire API。**这不是方案 A 的远端 disposal receipt，也不是自动恢复 close 失败的保证。** Salesko 必须先将现行“quiescence-before-cutover”契约明确改为依赖 start exclusion，才能推进产品 mutation；SDK 测试不会自动批准该产品契约变更。

## P1：主体与边界

旧 cloud 固定 `2752ffe86c4b222e2a23e75176dd2dd3a75901bb`，公开 `createInMemoryByokCloud`；client 分别导入两个独立 npm 安装的 public packed exports。精确 graph 沿用此前已核验 pack，安装 client index 再次 SHA-256 读回，见 [subjects.json](evidence/continuation-exclusion-20260908/subjects.json)。

- baseline client tgz `0ff5898e293fd02c2a4033c90f7358b819af10e0196224dcd55fee9907e652df`。
- candidate source `6bcf659874be14ed27378d6dcb635a8a9a23a258`，client tgz `69923e28c832ca96d587b3796f3915af86d5a0156468102e3bcb392838b3010b`。
- 两者 label 都为 0.15.0；此结果不依赖版本字符串推断。

host 使用 `createDaemonWithAdapters`、默认 `maxConcurrentMutableSessionsPerAgentHome=1`、稳定 Agent `shared` 和同一 hostStorageRoot。实际 fresh bootstrap 使用 `enqueueFreshAgentEgressOffer`，含当前 Salesko `salesko.read.v1`、`salesko.propose.v1` requiredToolsets、required message、terminalProjection none。toolset 定义与 runtime 为 disposable stub，未调用 Salesko 工具或 provider。旧/新 profile 从 p1 改为 p2，task ID 不同，Agent/home 保持。

## P2：执行路径与实测

`TaskRunner.handleOffer` 在 adapter prepare、claim、runtime side effect 前，以 canonical home 计算 active attempts + reservations，并同步 reserve；达到 cap 则 `task.decline(retryable:true)`。入口 `packages/client/src/daemon/task-runner.ts:1760`，判断 `:1794`。锁 key 不包含 profile revision 或新 task ID。

terminal 路径进入 `finishOnce`，先标记 finalization，随后 await Session.close（`:4318`）。close throw 时保留 task/lease，并返回 false（`:4321`）；close 成功后才走 lease release（`:4387`）。lease release 失败可使内存计数归零，但磁盘 marker 与后续 acquire 仍是另一道 gate：`packages/client/src/agent-home.ts:536`、`:579`。因此 activeAttempts=0 不能被解释成远端 quiescence receipt。

| 场景 | baseline / candidate 结果 | 证据含义 |
| --- | --- | --- |
| terminal 已发出，close unresolved | `PASS_SERIALIZED_RELEASE` / 同 | cloud 已接受 successor；local slot=1，无第二次 start；释放后 successor 启动一次。required-message disposition 处理可串行等待 finish，本项没有谎报已收到 busy refusal。 |
| close reject | `PASS_EXCLUSION_ONLY` / 同 | slot=1，p2 successor 明确 busy/retryable=true；连接重建及同 ID 重复 enqueue 不触发 start。未证明无需 host 操作的在线 cleanup retry。 |
| close 成功，lease rm 持续 EACCES | `PASS` / 同 | slot=0 仍因 marker acquire/reclaim 失败而 retryable decline；撤销 fixture 故障后新的 immutable attempt 启动一次。 |
| 成功 claim 的 HTTP response 丢失 | 两个 lease 场景均通过 | cloud 接受 claim 后故意返回503；观察到2个 claim POST、1个 runtime start。 |

完整 [results.json](evidence/continuation-exclusion-20260908/results.json) 保留不同 PASS 类型，不汇总成“完整生命周期 6/6 全通过”。6个有限场景符合各自断言，所有 synthetic credential 清理完成。没有重启 daemon 来使断言通过；每例结束后的 stop/unpair 仅清理独立 fixture。升级演练没有重跑。

显式 gate、cloud 查询、拒绝 envelope、poll/reconnect 和 runtime-start 事件作为观察点；循环等待仅有 deadline，不用 elapsed sleep 推断资源已经释放。held-close 的结果由源码中保留 lease 的不变量和其余 busy/refusal 路径共同支撑，单纯“没启动”不独立构成收到 offer 后拒绝的证据。

## P3：可消费契约与限制

可沿用方案 B，前提是 **同 device/enrollment、相同 Agent/home authority、cap=1，所有 successor 经 SDK Agent bootstrap admission**。旧 cloud 足以支持本次有限排他组合；candidate 在旧 cloud 上会记录缺少 mailbox-read-ahead 的告警，不构成跨版本 backlog 服务质量保证。没有因此升级 cloud、换依赖或发布 artifact。

重试要区分两个层次：

1. HTTP claim response 丢失：相同 envelope 重传有去重，实测只启动一次。
2. 已 durable delivered 的 task 再调用 enqueue：公开 API 明确抛出 `Task ... already has a durable delivered attempt and cannot be enqueued again.`；不是自动再次入队。busy decline 的 retryable=true 不是允许复活同一个 immutable task 的契约。Salesko 应保存原 attempt 结果、查询不确定结果，只有收到准确拒绝后才按自身 CAS/attempt authority 创建新 attempt；不能因 timeout 猜测旧 attempt 未执行。

close 失败后保持阻塞是安全保证；本次没有证明 public per-task 在线 cleanup retry。不得用 daemon stop/restart、删除 lease、删除历史或固定等待作为产品 continuation 流程。lease EACCES 正向控制只撤销测试注入，未删除生产 marker。

不提供跨 device Placement、重启后 retained descendant、恶意 adapter 谎报 close 成功、任意 provider 副作用或任意旧 artifact 的保证。无远端 lifecycle receipt，故 duplicate/stale lifecycle receipt 测试不适用；本次验证的是 successor 方案 B 的 reconnect/duplicate 边界。

## Salesko 下一步

将 B 的明确前提、busy/failed 处理和 immutable attempt 重试写入 continuation admission contract，再实现 checkpoint 归档、atomic epoch CAS 与旧结果隔离。持久化 terminal/outbox dead 仍只证明语义终态，不能变成 disposal 成功字段；旧 epoch 迟到结果必须继续按精确 binding 拒绝。若产品坚持必须先远端证明 quiescence 才可切换，方案 A 仍缺失，需要独立 SDK 通用 receipt 契约，不能复用本报告冒充。

## 验证与复现

Node 22.22.3 / macOS arm64；无产品源码修改。定向脚本、结果 JSON 断言、strict task workflow 和 diff check 通过。安装 graph 复用此前 subjects/lock integrity 证明，无全仓重跑。

```sh
node docs/researches/evidence/continuation-exclusion-20260908/probe.mjs /absolute/path/to/packed-upgrade-install-root
```

安装 root 的 old/new 目录由此前 packed-upgrade `prepare.mjs` 创建。fixture 的初稿修正了对象括号、held close 不应强求 immediate refusal，以及 duplicate enqueue 明确拒绝的 API 预期；最终以本次机器结果为准，不把这些 fixture 修正归责 SDK。
