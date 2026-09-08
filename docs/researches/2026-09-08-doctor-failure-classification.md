# Doctor 候选的七项失败：固定基线对照归因

## 结论

七项均表现为基线已有的测试时间预算/调度假设问题，当前对照未发现 doctor 候选引入新的功能回归。六项 compaction 的真实 I/O 在慢磁盘条件下仍满足原断言，但超过固定 10 秒测试预算；projection 的“总共两次 hook”假设无法覆盖停止前的合法再次投递。

这不是全仓通过或发布许可。原 `bun run test` 失败证据保留，没有用过滤运行或放宽全局 timeout 替代。没有修改产品代码或原测试文件，也没有实施测试修复。

## 授权、对象和方法

用户批准的范围是“对照基线复现七项失败，先归因”。基线 `62e83ae9ac76e38b5448307fec02850f780d7347`，候选 `06991fb945c3e5349a6ea0a9e77b4da562c935f5`；分别使用独立 worktree、各自 lockfile 安装和 build，Node 22.22.3 / Bun 1.4.2。候选已存在的 build/full-test 证据先核对 subject，再复用，没有重跑全仓。

四个原测试、spool/outbox、durable-jsonl/atomic-write、Agent-home、daemon/connection/long-poll、lockfile 与 Vitest config 共 14 个文件在两边 SHA-256 相同。候选对 auth 的变化仅提取同一 metadata reconcile；具体运行参数、commit、文件哈希、每项结果和探针源码保存在 [evidence](evidence/doctor-failure-classification-20260908/results.json)。

两边依次运行，避免人为的跨工作树 I/O 争抢；每边先运行原始七项一次，再执行有界控制探针。不是性能基准测试，顺序运行的毫秒差异不能用于宣称吞吐量回归或提升。

## P1：边界

- Compaction：原测试通过真实 append + disposition/ack 达到 512-entry 自然门槛，检查后续 append/reopen 与持久化失败的隔离语义。压力在实际文件/目录 sync，不经过新增 doctor API。
- Projection：真实本地 server、daemon A/B、task-free Agent-home hook、completion HTTP receipt 和 cursor。authority 是 completion/cursor，不是 hook 调用次数。
- 不涉及真实 provider、外部云部署、凭证变更、代码修复或版本发布。

## P2：复现路径与结果

### 六项 compaction

`append/disposition 或 ack -> DurableJsonlFile.append -> file.sync + directory.sync -> 512 entries -> atomic replacement -> sync -> append/reopen/assert`。POSIX 上每个场景约有千次文件/目录 sync；原始单项 timeout 为 10,000ms。

第一组保持原测试、原 10 秒预算：基线 **7/7 PASS**，候选 **7/7 PASS**。compaction 六项耗时如下，单位秒，数值顺序都是“基线 / 候选”。

第二组只使用临时 Vitest setup，在每次真实 JSONL 文件 `sync()` 前增加 21ms，仍调用真正的 sync；目录 sync 和生产实现保持不变。仅这个观测运行设 60 秒预算，让原断言跑到完成，原 test config 未改。两边六项原断言均通过，且每项均超过原 10 秒预算。

| 场景 | 原测试 | 受控慢文件 sync，原断言 PASS |
| --- | --- | --- |
| spool retain 1 | 8.20 / 8.38 | 17.34 / 18.22 |
| spool retain 3 | 5.52 / 8.20 | 16.30 / 17.19 |
| outbox retain 0 | 8.33 / 8.43 | 17.48 / 18.30 |
| outbox fault temp | 8.23 / 8.33 | 17.44 / 18.30 |
| outbox fault target | 5.50 / 8.22 | 16.30 / 17.20 |
| outbox fault directory | 2.64 / 5.49 | 15.60 / 17.05 |

观测每项 514–516 次受控文件 sync，注入等待实测约 11.39–11.97 秒。仅最少 514 × 21ms = 10,794ms 就超过 10,000ms，还未计真实 I/O、目录 flush、序列化和断言。因此有限且成功的慢 I/O 就足以造成原测试 timeout；两边均暴露这个预算边界。不能据此降低产品 fsync 保证，或只测试私有 compact() 来绕过自然生命周期。

最初 sync 探针使用 `vi.spyOn(fs.open)`，与 fault tests 自己安装的 spy 发生递归冲突；该次 sync 结果全部作废。修正为普通 open wrapper 后重新执行一次，全部原断言通过。这个探针故障没有被当作产品失败，也未改原测试解决。

### Projection：停止前再次投递

`daemon A hook -> completion 503 -> handler rejection -> cursor 留在 0 -> retained-head read navigation 回到 ACK -> idle poll 再投递 -> 相同 desired-state 再次调用幂等 hook`。

`long-poll-transport.ts:505-512` 在空页回到 ACK 后使用 idle delay；fixture 配置的 `retryDelayMs: 1000` 不是阻止所有重投的屏障。测试只等待第一个 503，后面仍有异步 readback 和 stop；它假定 stop 会早于下一次投递。

临时复制原测试，只在首个 503 之后等待 `rejectedCompletions >= 2` 再执行原停止/重启流程，保留原 `hookCwds.length === 2` 断言。两边均得到同一失败：**expected 2, got 3**。在失败断言之前，原测试已验证 cloud completion 为 `idempotent`、重启后 cursor 为 1。探针没有改变生产重试逻辑或放宽断言；临时测试副本运行后已移除。

`agent-home.ts:987-1033` 明确让相同 desired-state 再次执行 host 的 atomic/idempotent ensure。额外 hook 本身不是多创建 task 或错误推进 cursor 的证据，不能用“exactly 两次 hook”替代真正的恢复不变量。

## P3：归因与实施边界

- 六个 timeout：共享的真实持久化 I/O 成本与固定 10 秒测试预算不匹配。原失败时的具体磁盘负载没有逐次采样，因此不宣称已量化当时的负载；控制试验证明相同基线也有这个确定边界。
- 一个 projection assertion：基线 fixture 依赖“停止前没有再次投递”的调度假设。等待第二次合法投递即可在两边稳定复现同一错误，而 completion/cursor 断言仍成立。
- 本次证据支持“这七项不是 doctor 特有的功能回归”，不支持“全仓已通过”或“所有 doctor 风险已排除”。原全仓失败记录和独立 acceptance 缺口保持不变。

## 下一步

限定修复上述四个测试文件的证据边界：自然 compaction 场景设独立、有界且覆盖真实同步成本的预算；projection 用明确事件屏障控制首个失败与重启，不依赖等待时间或盲目放宽 hook 次数。保留完整 append/reopen、真实 fsync 故障、completion/cursor 与无 runtime 执行断言。此修复尚未获本次范围授权，未执行。
