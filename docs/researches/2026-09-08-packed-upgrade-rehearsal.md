# Packed SDK 旧→新生命周期演练

结论：限定组合 **6/6 PASS**。旧 SDK `2752ffe86c4b222e2a23e75176dd2dd3a75901bb` → 新 candidate `6bcf659874be14ed27378d6dcb635a8a9a23a258`，固定旧 cloud、同一 host adapter、同一 device/store/Agent home。没有修改 SDK 产品源码、Salesko 或生产状态，没有发布、push 或 merge。

旧主体依据是 Salesko Local Agent 0.1.19 的 release/source dependency receipt；本次运行其实际 SDK tarball，而不是运行 Salesko binary。新旧 package label 都为 SDK 0.15.0 / keys 0.4.1，必须以 source 与 tarball hash 区分。旧 manifest SHA-256 `495f80cac139ade7debfa6f16381cb8599305663af7afaacc7c1e684201a7e09`；新 manifest SHA-256 `b273e045b2db82b0783192a4a548ad046bd08a1a908ac230e29a7a18beaa3412`。完整 package hashes 与 npm lock integrity 核对见 [subjects.json](evidence/packed-upgrade-20260908/subjects.json)。

## P1：真实边界

公开 `createInMemoryByokCloud` 提供固定旧版 HTTP admission、task state 与 terminal receipt；公开 `createDaemonWithAdapters` 和 `SqliteLocalTaskJournal` 来自隔离 npm 安装的 packed client。固定 `pi` descriptor 的 host adapter 只产生可控 runtime event，无 provider 请求。真实 SQLite、outbox、Agent home、synthetic enrollment 在 disposable 目录跨进程保留。每次旧进程 SIGKILL 都等待 OS exit，再启动新进程；新进程 stop 后由 host close 注入 journal。

## P2：实走路径与结果

Pair → Agent offer → journal → cloud claim → runtime → terminal journal → HTTP ACK → durable confirmation。message 场景额外走 packed MCP helper `send_agent_message` → outbox → 注入 HTTP 503 → 重启后 replay。helper 在返回 staging receipt 后终止并等待 exit。

| 旧进程切点 | 切换前 cloud | 新 client 结果 | runtime 总启动数 |
|---|---|---|---:|
| journal append commit，尚未 claim | offered | 重新接收 offer，首次执行并 complete/confirmed | 1 |
| cloud 已 claim，adapter.start 尚未产生 Session | claimed | daemon_interrupted，failed/confirmed | 0 |
| runtime 已启动 | running | daemon_interrupted，failed/confirmed，无再次启动 | 1 |
| terminal 已 durable，未发送 | running，无 receipt | terminal 原 bytes/hash 回传，complete/confirmed | 1 |
| terminal ACK 已 durable confirm | complete，有 receipt | 无新 terminal POST，保持 confirmed | 1 |
| message 已 staged，cloud admission 注入 503 | running，message consume=0 | 原 payload replay，consume=1；任务 interrupted/failed/confirmed | 1 |

所有场景 device identity 保持；journal task device identity 与重启 identity 一致。terminal replay 比对 exact bytes 和 hash。post-ACK 场景观察新 daemon ready、后续两次 poll 及 stop，terminal POST 数不增；这是有限观察窗口，不是无限时域保证。消息 payload 做 deep equality，完整身份与内容没有转换。所有 synthetic credential 均经新 client unpair 清理；unpair 发生在断言、stop 与 journal close 之后，未用于升级恢复。

执行：Node 22.22.3 / macOS arm64。机器结果：[results.json](evidence/packed-upgrade-20260908/results.json)。6/6 PASS，6/6 credential cleanup，new process exit=0。各成功场景只执行一次；message 场景修正 fixture 的 helper EOF 等待后单独重跑，没有重跑前五项。早期 fixture 修正还包括 ESM import-only export 的 bridge，以及为 unclaimed offer 的合法首次执行发出 finish event；这些不属于 SDK 缺陷。

## P3：判断与限制

本次未发现需新增修复的 SDK 缺陷。已有版本门禁修复 candidate 的 source acceptance 沿用原报告；本次仅补充实际 packed artifact 运行证据，不重做全仓测试。旧 cloud 不宣告 mailbox-read-ahead，新 client 在 unacknowledged work 时可报告该 capability 不可用；本矩阵最终仍完成 terminal settlement，这不证明并发 mailbox backlog 下的服务质量。

结论仅覆盖上述 exact old/new 组合、有效 schema 状态、单 Agent、受控 adapter 与固定 in-memory cloud。没有证明 Salesko Postgres adapter、binary updater、真实 provider 子进程树、跨 Agent/tenant 攻击隔离、已有坏 JSONL 修复、任意旧版本 migration 或任意外部副作用 exactly-once。历史 R7 损坏文件仍须保留并拒绝，不能把 writer 修复解释成数据迁移。

Salesko 开工 Gate 可引用此 exact SDK 组合证据；生产开工前仍需实际消费候选 artifact，并对 host updater 的旧进程退出、相同 storeDir 与失败保留路径验收。SDK public lifecycle receipt 和 typed refusal 的原有 contract gaps 仍按 [责任报告](2026-09-08-independent-upgrade-responsibility.md) 处理。

## 复现入口

从仓库 root，使用 Node 22.22.3，将两个已验证 release-pack 目录传入：

```sh
node docs/researches/evidence/packed-upgrade-20260908/prepare.mjs OLD_PACK_DIR NEW_PACK_DIR _ops/packed-upgrade
node docs/researches/evidence/packed-upgrade-20260908/run.mjs _ops/packed-upgrade
```

prepare 检查 manifest source、每个 tgz SHA-256、每个安装 package 的 lock integrity；所有内部包以 file dependency + overrides 固定。run 使用 public ESM bridge，未导入源码或私有 SDK 入口。需要可用的 macOS synthetic device credential store；fixture 只使用随机 productId 与新目录。
