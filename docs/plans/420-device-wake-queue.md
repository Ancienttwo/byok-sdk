# #420 设计：embedded server 的设备端 wake 队列（routine K2）

> 状态：设计草案，只含设计，不含实现。实现需要 owner 按 PRD §16 单独放行。
> 依据：byok-sdk `main@bfa7de5c`；[ADR-038](../architecture/adr-2026-10-13-bot-platform.md) 决策 5、6；[Bot 平台 PRD](../researches/2026-10-13_bot-platform-prd.md) §7（K2 契约草案）、§12（Host 指南）、§13.1（路线图）、§14.1（routine 验收矩阵）；issue [#420]。
> 权威关系：[docs/spec.md](../spec.md) 仍是产品权威。本文把 PRD §7 的契约落到 `@byok-sdk/server` 的具体模块、表结构、状态机和测试上。实现 PR 在同一个 PR 中修改 spec、api-surface 和 README。

## 0. 结论

- 在 `@byok-sdk/server` 中加一个只属于 embedded server 的 wake 队列：`createByokServer({ wake: { consume } })` 加 `server.wakes.{schedule, cancel, pending}`。公开 API 与 PRD §7.2 一致，这里不改形状。
- 队列是 server 本地的组件，不进 `@byok-sdk/cloud` 的 kernel 端口（O7、ADR-038 决策 6）。memory 和 SQLite 两种组合用同一个调度器，只换存储。
- SQLite schema 从 4 升到 5，只新增一张 `wake` 表。迁移选择器整体换成 target-v5（`v1-to-v5` … `v4-to-v5`），删除 target-v4 选择器，不留别名，做法和 v3→v4 相同（spec「Embedded SQLite device and receipt authority」）。
- 本文在 PRD 契约之内做了五处实现取舍（§5），其中两处偏离 #420 正文的实现细节，但不改公开 API 和可观察语义：`delivering` 状态不落盘；冲突检测直接比较列，不存内容摘要。另有三项需要 owner 或 Codex 判断（§9）。

## 1. P1：架构地图

| 层 | 现状（`main@bfa7de5c`） | K2 之后 |
|---|---|---|
| 公开入口 | `createByokServer(opts)`（`packages/server/src/index.ts:317`），`opts.agentMessage` 透传给 kernel（`:371`） | 新增 `opts.wake`。它不进 kernel，由 server 自己的调度器消费 |
| 存储选择 | `ByokServerStorage = memory \| sqlite`（`packages/server/src/types.ts:29-39`）；`composeFacadeStores` 按 `storage.kind` 组合（`packages/server/src/stores.ts`） | 组合结果多一个 `wakes: WakeStore` |
| SQLite 权威 | 单一 `SqliteCoordinator` 串行化所有事务（`stores/sqlite/index.ts:189`、`run`/`transaction` 在 `:331` 起）；`SQLITE_SCHEMA_VERSION = '4'`（`:70`）；开库时校验每张表的投影（`:231-241`） | 同一个 coordinator 管 `wake` 表；schema 5；开库时多校验一个投影 |
| 单一 owner | #403 已合并：同一文件第二次打开抛 `SqliteOwnershipError`（`sqlite-support.ts`） | 不变。队列依赖它保证只有一个进程投递 |
| 时钟 | `systemClock()` 只给墙钟（`stores.ts:58`）；server 里唯一的定时器是 relay 的回收定时器，带 `unref()`（`relay.ts:334-337`） | 新增一个调度定时器，同样 `unref()` |
| 生命周期 | `stop()`（同步）和 `close()`（等待存储释放）（`index.ts:873-881`） | 两者都先停调度器，再走原来的释放路径 |
| hosted | `@byok-sdk/cloud`、`@byok-sdk/cloud-dataplane` 没有定时能力 | 不变（O7） |

不在范围内：cron 或其他周期规则（I2）、消息和回调进入队列（PRD §4 不纳入）、合批投递、hosted 定时器、`cloud-do` 的 inbox。

## 2. P2：一条真实路径

以 Aiphabee（Topology L，PRD §6）的一个 routine 为例：

1. Host 进程启动 `createByokServer({ storage: { kind: 'sqlite', path }, wake: { consume } })`。SQLite 开库事务里校验 schema 5 和 `wake` 表投影，并同步检查有没有未完成的行（§5.3）。构造返回后，调度器异步读出最早的投递时间，设一个定时器。
2. Host 算出下一个时点 t，调用 `server.wakes.schedule({ dedupKey: 'r1:v3:t', availableAt: t })`。调度器在 coordinator 事务里按 `dedupKey` 插入或比较已有行，提交后重新计算定时器。
3. 定时器触发（最多等 60 秒就醒一次）。调度器用墙钟 `Date.now()` 和最早的 `due_at` 比较。没到期就重新设定时器。
4. 到期后，调度器在一个事务里把这一行的 `deliveries` 加 1，然后调用 `consume(dueWake, signal)`。`dueWake.delivery` 就是加 1 之后的值。
5. Host 的 hook 在自己的账本事务里写 occurrence、推进 t'、调用 `wakes.schedule('r1:v3:t\'')`，再调用 `recurring.submit`（K5 之后是 `executions.submit`），然后 resolve。
6. 调度器在事务里把这一行标为 `done`，记录完成时间，再投递下一个到期的 wake。

失败路径：

- hook reject：事务里设置 `retry_at = now + 60s`，写入 `last_error`。行保持 `queued`。
- hook 60 秒不 settle：调度器中止 `signal`，按 reject 记录，然后继续下一个。旧 promise 之后 settle，调度器用投递令牌识别它是旧的，忽略结果。
- 进程在第 4 步之后、第 6 步之前崩溃：`deliveries` 已经加 1，行仍是 `queued`。重启后这一行照常到期，再投递一次。Host 用 occurrence key 去重。

压力点：第 4 步和第 6 步之间是至少一次投递的窗口；hook 的幂等是正确性的前提（PRD §7.3 第 3 条）。

## 3. P3：设计决定

### 3.1 为什么放在 server，不进 kernel

- 时钟必须在执行端（ADR-038 决策 5）。hosted 真相层不计时（决策 6）。kernel 端口会被 hosted 组合实现，放进去就违反 O7。
- embedded server 只有一个 tenant（`index.ts:319` 的 `serverTenantId`），调度器不需要 tenant 维度的路由。

### 3.2 为什么只有一个定时器，并且每次最多等 60 秒

- 一个 Host 的待投递 wake 数量大约等于 routine 数。一个定时器加按 `due_at` 排序的索引就够了，不需要每行一个定时器。
- 系统休眠时，单调时钟可能不前进，长定时器会晚到。每 60 秒醒一次、用墙钟比较，设备醒来后最多晚 60 秒投递（PRD §7.3 第 2 条）。
- 队列为空时不设定时器，所以空闲的 Host 没有周期唤醒（§7.5）。
- 定时器 `unref()`，和 relay 的回收定时器一致，不让调度器单独撑住进程，也不让测试挂住。

### 3.3 不变量

- W1：一个 `dedupKey` 最多一行。完成后保留 7 天，期间同样内容的调度返回 `accepted: false`，不再投递。
- W2：只有当前投递令牌的 settle 能改变行的状态。
- W3：每次调用 `consume` 之前，`deliveries` 已经在一个已提交的事务里加 1。所以 `DueWake.delivery` 单调递增，崩溃后也不会重复编号。
- W4：SDK 不丢弃过期的 wake，也不限制投递次数。放弃由 Host 决定：Host 在 hook 里记下放弃并 resolve。
- W5：没有配置 `wake` hook 时，SDK 不接受新 wake，也不打开一个有未完成 wake 的库（§5.3）。

### 3.4 10 倍规模时先坏的地方

- 逐个投递加 60 秒期限：如果 hook 普遍挂起，1000 个同时到期的 wake 要 1000 分钟才能轮完。PRD 选择逐个投递，本文保持不变，把它列为 §9 的待判断项。
- 挂起的 hook promise 不会被 SDK 回收。一个每次都挂起的 hook 每 60 秒多留下一个未 settle 的 promise。SDK 只持有 settle 回调，不持有 hook 的资源；资源清理靠 Host 响应 `signal`。
- `pending()` 不分页。每个 routine 最多一个待投递 wake，数量和 routine 数同阶，暂不分页。

## 4. 模块与接口

### 4.1 新文件

| 文件 | 内容 |
|---|---|
| `packages/server/src/wakes/types.ts` | 公开类型：`WakeScheduleInput`、`WakeScheduleResult`、`DueWake`、`WakeRecord`；错误类 `WakeHookMissingError`、`WakeConflictError`、`WakeInputError` |
| `packages/server/src/wakes/store.ts` | 内部端口 `WakeStore` 和 memory 实现 |
| `packages/server/src/stores/sqlite/wakes.ts` | `WakeStore` 的 SQLite 实现，走现有 `SqliteCoordinator.transaction` |
| `packages/server/src/wakes/scheduler.ts` | `WakeScheduler`：定时器、投递循环、投递令牌、期限、清理 |

`WakeStore` 只在 server 内部使用，不导出：

```ts
interface WakeStore {
  schedule(input: ValidatedWakeInput, now: number): Promise<WakeScheduleResult>;
  cancel(dedupKey: string): Promise<boolean>;
  /** 未完成的行，按 (due_at, wake_id) 排序。 */
  pending(): Promise<readonly StoredWake[]>;
  /** 最早的 due_at；没有未完成的行时为 undefined。 */
  nextDueAt(): Promise<number | undefined>;
  /** 取出 due_at <= now 的最早一行，并在同一个事务里把 deliveries 加 1。 */
  beginDelivery(now: number): Promise<StoredWake | undefined>;
  complete(wakeId: string, now: number): Promise<void>;
  reject(wakeId: string, retryAt: number, lastError: string): Promise<void>;
  collectExpired(now: number, limit: number): Promise<number>;
}
```

### 4.2 公开 API

与 PRD §7.2 相同，不重复。补充三点：

- 选项名 `wake`，成员名 `wakes`。`wakes` 在 memory 组合里也存在；memory 组合的行在进程退出时丢失（PRD §7.1）。
- 输入校验失败抛 `WakeInputError`，`code` 是封闭枚举：`WAKE_DEDUP_KEY_INVALID`（不是 1–256 个字符的字符串）、`WAKE_AVAILABLE_AT_INVALID`（不是安全整数，小于 0，或者比当前墙钟晚 366 天以上）、`WAKE_PAYLOAD_TOO_LARGE`（UTF-8 超过 4 KiB）。`availableAt` 可以早于当前时间，这时立即到期。
- `WakeRecord.state` 的 `delivering` 由调度器的内存状态投影（§5.1）。

### 4.3 SQLite 表

```sql
CREATE TABLE wake (
  tenant_id TEXT NOT NULL,
  wake_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  available_at INTEGER NOT NULL,
  payload TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'done')),
  due_at INTEGER NOT NULL,          -- queued 时等于 retry_at ?? available_at；done 时不再使用
  retry_at INTEGER,
  deliveries INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  done_at INTEGER,
  PRIMARY KEY (tenant_id, wake_id),
  UNIQUE (tenant_id, dedup_key)
);
CREATE INDEX wake_due ON wake (tenant_id, state, due_at, wake_id);
CREATE INDEX wake_done ON wake (tenant_id, state, done_at);
```

- `tenant_id` 和其他表一样放在主键第一列。embedded server 只有一个 tenant，这一列保持全库一致的键布局。
- 时间用 epoch 毫秒的 `INTEGER`。现有表用 ISO 文本，是因为它们镜像 kernel 的 `Date`；wake 的公开 API 本身就是毫秒数，存毫秒避免一次往返转换。
- 开库时的投影校验加一行 `SELECT tenant_id, wake_id, dedup_key, available_at, payload, state, due_at, retry_at, deliveries, last_error, done_at FROM wake`。

### 4.4 迁移

- `SQLITE_SCHEMA_VERSION` 改为 `'5'`。
- 选择器换成 `'v1-to-v5' | 'v2-to-v5' | 'v3-to-v5' | 'v4-to-v5'`，删除 target-v4 选择器，不留别名。错误消息相应改为 target-v5。
- v1–v3 的现有检查和补表步骤不变，最后多建 `wake` 表。v4 只建 `wake` 表，不改已有行。
- 已经存在 `wake` 表的 v4 库视为无效 schema，抛 `SQLITE_SCHEMA_INVALID`，和 v1 库里出现 `device_directory` 的处理一致。
- 表和版本在同一个事务里推进；失败时旧库保持原样。
- 回滚：恢复 adoption 前的备份。旧版本拒绝 schema 5。

与其他工作流的冲突：K1（#411、#412）如果也给 SQLite 加表，两边谁后合并谁把版本号顺延一位，不让同一个版本号有两种含义。K7 的 wire v3 只改 `PROTOCOL_VERSION` 和 pending 行检查（`stores/sqlite/index.ts:291-301`），不改 schema 版本，和 K2 互不影响。

## 5. 实现取舍

### 5.1 `delivering` 不落盘

#420 正文写的是"启动时 `delivering` 状态的 wake 回到 `queued`"。本文改为：表里只有 `queued` 和 `done`，`delivering` 是调度器内存里的投递令牌。

- 可观察行为相同：崩溃后行仍是 `queued`，重启后再投递一次；`pending()` 仍返回 `delivering`。
- 省掉启动时的一次批量改写，也不存在"进程活着但行停在 `delivering`"的可能。
- `deliveries` 在调用 hook 之前加 1 并提交（W3），崩溃后的投递编号仍然正确。

### 5.2 冲突检测直接比较列

#420 的存储一节列了"内容摘要"。`payload` 最多 4 KiB，直接比较 `available_at` 和 `payload` 两列就是精确的，不需要摘要列。

### 5.3 没有 hook 时拒绝打开有未完成 wake 的库

PRD 只规定"没有 hook 时 `schedule` 抛错"。本文再加一条：构造时如果库里有 `queued` 行而没有配置 `wake` hook，`createByokServer` 抛 `WakeHookMissingError`。`createByokServer` 是同步的，所以这项检查放在 SQLite 开库时同步完成，形状和现有的 `scanTaskAttemptsAtOpen`（`stores/sqlite/index.ts:184`）一样，不经过异步的 `WakeStore`。memory 组合在构造时总是空的，不需要检查。理由：否则 Host 少传一个选项，routine 就静默停止，和 PRD 的成功标准 1 冲突。只读查看库的工具不受影响，因为它们不走 `createByokServer`。这一条需要 owner 确认（§9）。

### 5.4 期限到达和 `close()` 的处理

- 期限到达：先中止 `signal`，再在事务里按 reject 记录（`last_error = 'wake_delivery_deadline_exceeded'`），然后作废令牌，继续投递。
- `stop()` 和 `close()`：清除定时器，中止当前投递的 `signal`（reason 为 server 关闭），作废令牌，不写任何行。这一行保持 `queued`，`deliveries` 已经加 1，下次启动再投递，和崩溃的处理相同。之后 settle 的旧 promise 因为令牌失效，不会去碰已经关闭的存储。

### 5.5 时钟与测试

- 不加公开的 clock 选项。调度器用 `Date.now()` 和 `setTimeout`。
- 测试用 vitest 的假定时器：`vi.setSystemTime` 只移动墙钟，`vi.advanceTimersByTime` 只移动定时器。两者分开调用，就能模拟"墙钟前跳 3 天、单调时钟不动"。
- 清理：`collectExpired(now, 100)` 在构造后的第一次调度和每投递完一批之后调用。#412 的 `runMaintenance` 落地后调用同一个方法。

## 6. 状态机

```text
schedule ──▶ queued(due_at = available_at)
queued ──到期──▶ [事务: deliveries += 1] ──▶ 投递中（内存令牌 T）
投递中 ──resolve(T)──▶ done(done_at = now)
投递中 ──reject(T) / 期限──▶ queued(due_at = retry_at = now + 60s, last_error)
投递中 ──settle(旧令牌)──▶ 忽略
投递中 ──崩溃 / close──▶ queued（行未变；deliveries 已加 1）
queued ──cancel──▶ 删除
done ──7 天后 collectExpired──▶ 删除
```

## 7. 测试计划

`packages/server/src/__tests__/wakes.test.ts`，memory 和 SQLite（`:memory:`）各跑一遍，使用假定时器。覆盖 #420 验收标准的全部十条，另加：

- `schedule` 的三种 `WakeInputError`，以及 `availableAt` 早于当前时间时立即投递。
- `stop()` 和 `close()` 中止当前投递，行保持 `queued`；旧 promise 在关闭后 settle，不抛错，不写存储。
- 投递令牌：reject 之后、重投之前，旧 promise resolve 不把行标为 `done`。

`packages/server/src/__tests__/wakes-sqlite.test.ts`，真实文件：

- 子进程在 `consume` 中被 SIGKILL，重启后再投递一次，`delivery` 为 2。用 `sqlite-ownership.test.ts` 已有的子进程模式。
- 第二个进程打开同一个库得到 `SqliteOwnershipError`，不投递。
- schema 4 的库没有选择器时拒绝打开；`v4-to-v5` 后保留已有的行并新建空的 `wake` 表；v4 库里已有 `wake` 表时得到 `SQLITE_SCHEMA_INVALID`。
- 有 `queued` 行、没有 `wake` hook 时构造失败（§5.3）。

现有 `sqlite-composition.test.ts` 和其他引用 `v*-to-v4` 的测试随选择器改名一起更新。

## 8. 交付清单（实现 PR）

- 代码：§4.1 的四个文件；`types.ts` 的 `CreateByokServerOptions.wake` 和 `ByokServerStorage.migration`；`index.ts` 的组合、`wakes` 成员和生命周期；`stores.ts` 的 `wakes` 组合；`stores/sqlite/index.ts` 的 schema 5。
- api-surface：`api-surface/server.d.ts` 新增 `wake`、`wakes`、三个错误类，更新选择器；`bun run check:api-surface` 通过。
- spec：新增「Embedded wake queue」一节（放在「Embedded SQLite device and receipt authority」之后）；把该节的 schema v4 和 target-v4 选择器改为 v5；「Recurring Host composition requirements」加一句，设备端时钟用 wake 队列。
- 文档：`packages/server/README.md` 写明 `wakes` 只在 embedded server 中提供，memory 组合重启后丢失；CHANGELOG 记录 schema 5 和选择器改名（破坏性）。
- 检查：

```sh
bun run build
bun run typecheck
bun run test
bun run check:api-surface
bun run check:version-authority
```

## 9. 待判断项

1. 常量（#420「需要 owner 决定」）：等待上限 60 秒、投递期限 60 秒、拒绝后 60 秒重投、`availableAt` 最远 366 天、完成记录保留 7 天、payload 4 KiB、`dedupKey` 256 个字符、每次清理 100 行。本文按这些值设计。
2. §5.3：有未完成 wake、没有 hook 时构造失败。需要 owner 确认这条 fail-closed 规则。
3. §3.4：逐个投递在 hook 普遍挂起时有队头阻塞。可选的改法是有界并发（例如同时最多 4 个投递）。PRD 选了逐个投递，本文没有改，请 Codex 评估是否值得在 K2 里就改。

## 10. 风险

- 没有在真实系统休眠中测量 Node 定时器的延迟。设计只依赖"60 秒内至少醒一次"和墙钟比较。
- 投递语义是至少一次，期限还会产生同一个 wake 的并发调用。Host 的去重是正确性前提。
- 已部署的 embedded server（例如 Aiphabee）升级到 schema 5 时要停止 writer、备份，并改用 `v4-to-v5`。旧的 `v*-to-v4` 配置会在启动时失败。
- 设备关机或休眠时 wake 不运行。错过和离线的可见性由 Host 在读取时推导（PRD §12.8）。

---

**Codex should review this design before implementation.** 请重点看 §5 的五处取舍和 §9 的三个待判断项。

[#420]: https://github.com/Ancienttwo/byok-sdk/issues/420
