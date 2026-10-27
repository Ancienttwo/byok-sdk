# #1016 设计稿：`.byok/runtime-sessions` session ledger 的保留规则

状态：owner 于 2026-10-27 按推荐答案批准 O1–O10（#1016 的 issue 评论）。实施起点是 #1019 和 #1021 合入后的 `main`。
`packages/` 的行号取自 #1019 分支 `origin/claude/925-wire-v4-stage1-e245ba`（`f2bf679ac`），特别注明的取自 `main`（`990abd602`）。AiphaBee 的事实取自本机 checkout `~/Projects/aiphabee`（`ba42bad6`，钉 0.30.2）。没核实的标 `[inferred]` 或 `[unverified]`。

## 结论

- 新增一个 SDK 自己执行的 expiring 类 `session-ledger`，管 `.byok/runtime-sessions/<runtime>-<sha256>.jsonl`。只在 Agent home 空闲时（`withIdleHomeLease`）删，按文件 mtime（也就是最后一次 append 的时间）判断年龄，默认超过 30 天删，经现有的 `storage.retention.ttlMs['session-ledger']` 可配（最小 0）。不加条数上限，压力下照常清，在类列表里排最后，`-task-` 终态证据不动。
- 年龄只看最后一次 append，不看 `terminalCause`。daemon 崩溃留下的 ledger 永远不会补上 terminal（`recordTerminal` 只有 `task-runner/finish.ts:164` 和 `task-runner/terminal-evidence.ts:127` 两个调用点，启动恢复不写），按「终态且无引用」删会让这些 ledger 永远留着。
- reader 会话本来就有上限：reader-run 保留只保护 7 天内被 handoff 更新过的运行目录（`docs/spec.md:2190-2193`，`agent-home-readers.ts:76-80`），目录没了 resume 就非重试 decline（`task-runner/offer-workspace.ts:93-94`）。30 天的 ledger TTL 不给 reader 增加新的失败。真正的契约变化在 writer：今天 writer resume 没有任何时间上限（spec、cloud、server 都没有，见 Q1.4），这一条要 owner 签进 spec。
- ledger 被删以后，所有读者都已经 fail closed：resume 是非重试 decline，`agent.content.read` 是 `identity-mismatch` deny，可靠 egress 抛错。实现只给「ledger 不存在」换一句清楚的 reason 文本，不加 wire `code`，不加错误类。
- 契约影响：`ExpiringClassId`/`RetentionClassId` 多一个 `'session-ledger'`，`DEFAULT_RETENTION_TTL_MS` 和解析后的 `ttlMs` 多一个键，`client.d.ts` golden 变，和 #1018 同类的 breaking 类型变化。没有 wire、SQL、CI selector 变化。closure 增长估计 1–1.5 KB，落在 `@byok-sdk/client` 和 `bin:byok-agent` 两个 entry `[inferred]`。
- 只改 client，和阶段 2 的 client 文件清单（stage2 稿 Q5 client 表）不重叠。#1019 合入后任何时候都能做，一个 PR，约 150 行代码加 250 行测试 `[inferred]`。
- AiphaBee 还有一块增长不归 SDK：它把 `piByokLauncher.sessionDir` 设在自己的数据目录（`apps/local-agent/src/pi-provider-launcher.ts:60`），每个 turn 大概留一个 Pi session 文件 `[inferred]`，这个目录也计入用量扫描（`retention/producers.ts:234`）。所以验收标准写成「ledger 条目数有界」，不写「用量测量不再 truncated」。

## Q1 现状

### 1.1 写入方

ledger 名由 `sessionFileName` 生成：`<runtime>-<sha256(sessionRef)>.jsonl`，runtime 段把非 `[a-z0-9._-]` 字符换成 `_`，截到 64 字符（`agent-session-handoff-store.ts:268-272`）。同目录还有 `<runtime>-task-<sha256(taskId)>.jsonl` 的终态证据文件（`:274-278`）。

| 写入 | 调用点 | 什么时候 | 是否持有 execution lease |
| --- | --- | --- | --- |
| `record` | `task-runner/offer-activation.ts:130-140` | 每个 Attempt 的 runtime `start()` 返回后、`task.started` 之前。fresh 新建文件，resume 往同一个文件追加 | 是，包在 `mutateExecution` 里 |
| `recordTerminal` | `task-runner/terminal-evidence.ts:127`、`task-runner/finish.ts:164` | 终态时追加一行带 `terminalCause` 的记录 | 是。`finish.ts:157-159` 的注释写明在 writer lease 释放前；`terminal-evidence.ts` 在 active task 期间调用 `[inferred]` |
| `recordTaskTerminal` | `task-runner/finish.ts:44-55` | handoff 还没写成功就失败的任务，写 `-task-` 文件 | 是，包在 `mutateExecution` 里 |

所有写入都是 append + fsync（`:609-639`），会更新文件 mtime。ledger 没有临时文件。prepared Execution 也写 ledger，它走同一条 `record` 路径，虽然它永远不 resume（`packages/protocol/src/messages.ts:409-411`）。

### 1.2 读取方

| 读者 | 调用点 | 用的 key | key 从哪来 | 是否持有 lease |
| --- | --- | --- | --- | --- |
| writer resume（strict） | `task-runner/offer-workspace.ts:67-83` → `requireMatch` | (agentRef, sessionRef, runtime, home, cwd, homeAccess) | offer 的 `sessionRef`，由 Host 的 resume 调用填（`dispatch({ agentRef, sessionRef })`、`enqueueAgentOffer`，spec `:2631-2634`）。Host 的 sessionRef 来自之前 `task.complete.sessionRef`（`messages.ts:1209`） | 是，在 `acquireExecution` 之后 |
| reader resume 找运行目录 | `offer-workspace.ts:25-38` → `readerSessionCwd` | 同上，homeAccess 固定为 `memory-reader` | 同上 | 否，在 lease 之前；`:69` 的 `requireMatch` 在 lease 下再查一次 |
| 可靠 egress 发布 | `create-daemon/egress.ts:57-68` → `requireMatch` | (agentRef, sessionRef, runtime, canonical home) | 公开 publisher 的调用方（运行中的 Agent 一侧）传入 | 是，`agentHomeManager.acquire` |
| `agent.content.read` | `create-daemon/start-envelopes.ts:154-174` → `requireMatch` | (agentRef, sessionRef, runtime, cwd = canonical home) | wire 上 `AgentContentReadPayload.sessionRef`，必填（`messages.ts:548`），由 Host 发起 | 否 |
| reader-run 保留 | `retention/producers.ts:151` → `readerRunReferences` | 遍历整个目录 | 无 | 是，maintenance lease |

`history()` 和 `getTaskTerminal()` 只有测试调用（`__tests__/14-4-recovery-handoff-durability.test.ts:75`、`__tests__/agent-home-contract.test.ts:380`、`:582`、`:633`）。support bundle、doctor、Agent memory 投影都不读这个目录：`runtime-sessions` 在 `packages/*/src` 里只出现在 store 和 `producers.ts`（`git grep` 结果）。

所有读者遇到不存在的文件都已经 fail closed：`loadAll` 把 `ENOENT` 当空（`:571`），`get` 返回 `undefined`，`requireMatch` 和 `readerSessionCwd` 抛 `AgentSessionHandoffMismatchError`（`:340-345`、`:357-361`）。offer 路径把它变成非重试 decline（`offer-workspace.ts:35`、`:80`），content read 变成 `identity-mismatch` deny（`agent-content-read.ts:777-782`）。问题出在文本：ledger 不存在时，writer resume 报「does not match ... exactly」，reader resume 报「is not a memory-reader session」，两句都会让人以为是身份对不上。

AiphaBee 不用前四种读者。它所有执行都走 `executions.submit` fresh（`apps/local-agent/src/research-pass-host.ts:465`，bot chat 每个 turn 一次，`plans/plan-20261017-bot-chat.md:49`），不发 reader offer（`research-pass-host.ts:1080`），`apps/local-agent/src` 里没有 content read 或 resume 调用（grep）。它的 ledger 只被 reader-run 保留的 `readerRunReferences` 逐个读。其他 Host 会不会用旧 sessionRef 做 content read 或 resume，本仓库看不到 `[unverified]`。

### 1.3 读取依赖的另一半：runtime 自己的会话

resume 除了 ledger，还要 runtime 本身还留着那个会话。Pi 按 cwd 找 `--session <id>`，找不到就退出（`adapters/pi/pi-adapter.ts:280-292`）；Codex resume 不存在的 thread 会失败（spec `:405`）。Pi 会话文件在 `piByokLauncher.sessionDir`（Host 提供，`pi-adapter.ts:348`、`:951`），没配时在 Pi 自己的设置目录（`bin/pi-session-runtime.ts:78` 的 `getSessionDir()`，具体位置 `[unverified]`）。SDK 不知道 runtime 会话什么时候没了，所以 ledger 的保留期定不出「runtime 还能 resume」的上限，只能定 SDK 承诺的上限。

### 1.4 有没有 resume 窗口

- spec：resume 要求 exact 身份，mismatch fail closed（`:2165-2167`），没有时间上限。reader 例外，见下一条。
- reader：运行目录在 handoff 7 天没更新、且目录本身也超过 7 天后可以删，超出 32 个时删最旧的（`:2190-2193`，`agent-home-readers.ts:20-22`、`:96-105`）。目录删了，resume 就非重试 decline，reason 带 session 名（`offer-workspace.ts:93-94`）。所以 reader 的可 resume 时间实际是 7 天左右。
- cloud、server：resume lane 只要求 `sessionRef` 非空（`packages/cloud/src/cloud.ts:511-518`，`packages/server/src/index.ts:518-520`、`:566-568`），不看时间。
- 文档：`docs/researches/2026-09-09_conversation-turn-mode-design.md:85-90` 推荐 Host「间隔短就 resume，超时或换设备就 fresh 加摘要」，fresh 回退由 Host 决定。
- writer 今天没有任何上限。

### 1.5 retention 在 #1019 之后怎么运作

- 类是封闭的两组：`EXPIRING_CLASS_IDS`（可删）和 `PROTECTED_CLASS_IDS`（只测量），registry 构造时检查每个类正好出现一次、protected 类没有 sweep（`retention/registry.ts:1-12`、`:56-63`）。#1019 删了 `workspace` 类（`registry.ts:7`）。
- `createRetentionRegistry` 里一个类有三处：`classify` 决定扫描到的文件归哪个类（`producers.ts:237-274`），`authority` 给出 roots、owner、scope、`ttlMs`、`maxEntries`（`:314-331`），`sweep` 表把类映射到删除函数（`:204-209`）。ledger 今天归 `byok-authority`（`:271`），`-task-` 文件归 `terminal-evidence`（`:269`），都受保护。
- home 内的类走 `sweepHome`：对每个 home 拿 `withIdleHomeLease`，拿不到就跳过这个 home（`agent-home.ts:1294-1303`），每个 home 临界区 250 ms 软期限，用完就 `budget.truncate()`（`producers.ts:147-149`）。`entries()` 是跨 pass 续读的目录游标（`:44-60`）。
- `agent-result` 的接法（#1018）：`classify` 一行（`:267`），`sweepHome` 一个分支调 `pruneAgentResults`，删除走 `remove(home, file, budget)`，字节数由 `removeOwnedPath` 算进 `bytesReclaimed`（`:160-165`、`:70-74`），`authority` 加 `maxEntries`（`:330`），默认 TTL 在 `retention/config.ts:49`。prune 函数本身在 `agent-result-store.ts:216-239`，按 mtime 判断，不解析内容。
- sweeper 按 `EXPIRING_CLASS_IDS` 的顺序逐类清，压力下跳过 `confirmed-journal`、`reader-run`、`home-temp`、`skill-pack-old`（`retention/sweeper.ts:100-103`），`agent-result` 照常清。一次 pass 的报告是 `SweepReport`（`registry.ts:25-33`），失败走现有 `retention-failure` 事件，classId 校验直接用两个常量数组（`bin/audit-log.ts:312-317`）。
- 用量扫描最多 65 536 个条目，超过就把相关类标 `truncated`（`producers.ts:217-221`、`:294-304`）。

### 1.6 ledger 增长已经拖住 reader-run 保留 `[inferred]`

`readerRunReferences` 每次读完整个目录的每个 ledger（`agent-session-handoff-store.ts:380-395`），读不完 250 ms 就返回 `undefined`，整个 home 的 reader-run 保留跳过（`producers.ts:151-152`）。一个 ledger 损坏时它直接抛错（`:550-563`），`sweepHome` 抛出，`reader-run` 在这一 pass 剩下的 home 上都不清。外层 `for await` 抛错时生成器收到的是 `return()`，`entries()` 的 catch（`producers.ts:57-58`）不执行，游标留在 map 里，下一 pass 从这个 home 之后接着读，所以每轮完整遍历卡一次 `[inferred]`。ledger 上万的 home 在 250 ms 内读不完，reader-run 保留就一直不跑。所以新的 prune 不能建在 `readerRunReferences` 上，要用 `entries()` 游标。

### 1.7 `piByokLauncher.sessionDir` 确实不归 SDK

- SDK 只把这个路径传给 Host 的 launcher（`pi-adapter.ts:348`、`:951`），不在里面建或删文件。
- 用量里它是 `pi-session-dir` 类，owner `host`、scope `host`、受保护（`producers.ts:238`、`:327-328`，`registry.ts:8`），接线在 `create-daemon.ts:762`（`main` 上是 `:791`）。
- 后果：ledger 过期以后，Host 目录里的 Pi 会话文件还在，但已经不能经 SDK resume。SDK 不替 Host 清这个目录；AiphaBee 要不要清自己的 `sessionDir`，是 AiphaBee 的事。

## Q2 方案

### 2.1 候选

| 方案 | 做法 | 取舍 | 结论 |
| --- | --- | --- | --- |
| A | 按最后一次 append 的年龄删，默认 30 天，TTL 可配 | 规则和流量无关：resume 能不能成只看这个 session 多久没用过。条目数 ≈ 每天新 session 数 × TTL。写进 spec 就是明确的 resume 窗口 | **选这个** |
| B | 每个 home 或每个 runtime 保留最新 N 个 | 条目数严格有界。但一个 session 能不能 resume 取决于之后又跑了多少别的 session：繁忙的 home 上，一个聊了两小时的对话可能已经被挤掉。reader 的 ledger 被提前挤掉时，它的运行目录也提前失去保护 | 不做，列为 owner 问题 O3 |
| C | 只删已终态、且没有被引用的 ledger | 「引用」在 Host 和 cloud 那边（Host 存着 `task.complete.sessionRef`），SDK 看不到。终态的 session 恰好是正常可以 resume 的那些。崩溃留下的 ledger 永远不终态，会一直留着 | 不做 |
| D | 终态时立刻删不能 resume 的 ledger（prepared Execution） | 只覆盖 prepared。fresh 的 ledger 照样增长。终态后的 content read 还要用这个 ledger 证明身份 | 不做 |

### 2.2 资格规则

一个文件被 `session-ledger` 删，要同时满足：

1. 在 `<home>/.byok/runtime-sessions/` 里，是普通文件，名字匹配 `^[A-Za-z0-9._-]{1,64}-[a-f0-9]{64}\.jsonl$`，且不匹配 `-task-[a-f0-9]{64}\.jsonl$`。
2. `now - mtime >= ttlMs['session-ledger']`。
3. 删的时候持有这个 home 的 maintenance lease（`withIdleHomeLease`）。

几点说明：

- 第 1 条的名字规则要和 `classify` 用同一个导出的谓词，测量和删除不会各说各话。runtime 段可以是自定义 harness 的 id（`types.ts:254` 的 `id: string`，`offer-runtime.ts:47`），所以名字规则没法做到精确。一个 sanitize 后以 `-task` 结尾的自定义 harness，它的 ledger 会被当成终态证据留下，只会多留，不会误删。今天的 `classify`（`producers.ts:269`）也是这么归的。要不要为这种情况读首行判断 kind，见 O7。
- 第 2 条看 mtime，不解析内容，和 #1018 一样。append 会更新 mtime，所以 mtime 就是最后一次 append。`readerRunReferences` 用的是解析出来的 `updatedAt`，两者只差一次 fsync 的时间，而 reader 的保护期（7 天）不长于 ledger TTL，所以这点差别不会让运行目录提前失去保护。损坏的 ledger 一样按 mtime 过期，删掉以后 `readerRunReferences` 不再在它上面抛错。
- 第 3 条覆盖了所有写入：三个写入点都在 execution lease 下（1.1）。每个 execution lease（writer 和 reader 都是）所在的 group 持有一个 base lease，`AgentHomeLeaseManager.held` 记着它（`agent-home.ts:910-920`、`:644-647`）；`acquireMaintenance` 看到 `held` 里有这个 home 就抛 busy（`:761`），另一个进程的 lease marker 也让它抛 busy（`:774-777`）。可靠 egress 用的 `acquire` 走同一个 `held`（`:1306-1309`）。所以清理时不会有 append 正在进行。`producers.ts:154` 给 `pruneReaderRuns` 传空的 `active` 也依赖这一点。执行中的 session 一定在租约下，所以不会被删。崩溃留下的 ledger 在 home 空闲后按年龄删。
- 不需要额外加锁的读者：`readerSessionCwd` 在 lease 外读，删掉以后它报不存在，就算它读到了，lease 下的 `requireMatch`（`offer-workspace.ts:69`）也会再查一次。content read 不拿 lease，unlink 是原子的，它看到的要么是完整文件，要么是 `ENOENT`。

### 2.3 ledger 被删以后各读者的行为

| 读者 | 现在的行为（已经 fail closed） | 实现后 |
| --- | --- | --- |
| writer resume | 非重试 decline，reason `Agent session handoff mismatch: Agent session handoff <ref> does not match ... exactly` | 仍是非重试 decline，没有 `code`。`requireMatch` 在 `entry === undefined` 时改报 `Agent session handoff <ref> does not exist on this device: it was never recorded here, or retention removed it`，类还是 `AgentSessionHandoffMismatchError`。文本里不带 TTL 数值：store 无参构造（`create-daemon/workspaces.ts:33`）、是公开导出（`index.ts:47`），拿不到 retention 配置，为一句文本改公开构造函数不值得。runtime 不启动 |
| reader resume | 非重试 decline，reason 里是「is not a memory-reader session」 | `readerSessionCwd` 的 `entry === undefined` 分支用同一句「does not exist」 |
| `agent.content.read` | deny，reason `identity-mismatch`，写 receipt | 不变。`AgentContentReadReason` 是 wire 上的枚举，不加新值 |
| 可靠 egress 发布 | `requireMatch` 抛错，publisher 拒绝 | 不变，只是错误文本换成「does not exist」。实际上发布方是运行中的 session，ledger 在租约下不会被删 |
| reader-run 保留 | — | 被删的 reader ledger 早已超过 reader 保护期，运行目录的保护状态不变 |

decline 的 `code` 只有两个 home busy 值和 sealed 值（`messages.ts:875-882`），加新值就是 wire 变更，不做。阶段 2 的 O4 也是「不新增 decline code，只写 reason」。

### 2.4 配置

不加新字段，用现有的 `storage.retention.ttlMs`（`retention/config.ts:21-27`）：

- `DEFAULT_RETENTION_TTL_MS['session-ledger'] = 30 * 86_400_000`，和 `confirmed-journal` 的默认一样（`config.ts:48`）。
- 最小值 0，和 `agent-result` 一样，不加跨字段校验。TTL 比 `reader-run` 短也不会出数据问题：ledger 没了，reader 本来也 resume 不了，运行目录只是按自己的年龄晚一点删。设 0 的 Host 等于宣布自己从不 resume，也不用旧 session 做 content read，这是 Host 的产品决定。
- 不加 `maxEntries`。

### 2.5 测量与记账

- `classify`：`relative` 在 `.byok/runtime-sessions/` 下、名字过 2.2 第 1 条的谓词 → `session-ledger`；`-task-` 文件仍归 `terminal-evidence`；目录里其他东西仍归 `byok-authority`。
- `authority`：`session-ledger` 加进 `homeScoped` 列表（`producers.ts:316`），owner `sdk`，scope `agent-home`，带 `ttlMs`，不带 `maxEntries`。它是 SDK 自己的类，空的时候也算 measured（`:303` 的排除列表不加它）。
- 删除走 `remove(home, file, budget)`，字节数进 `bytesReclaimed`，条数进 `deleted`，和 `agent-result` 完全一样（`producers.ts:164`）。`SweepReport` 形状不变，不加事件，失败走现有 `retention-failure`，classId 自动被 `audit-log.ts:314` 接受。
- 顺序：`EXPIRING_CLASS_IDS` 里把 `'session-ledger'` 放在最后。一次 pass 的删除和检查共用一个预算（`maxDeletionsPerPass` 默认 256、8 192 次检查，`sweeper.ts:64`），预算用完 sweeper 就停，后面的类这一 pass 都不清（`:104`）。升级后第一批过期 ledger 可能有上万个，放在前面的话，`reader-run`、`agent-result`、`home-temp`、`skill-pack-old` 要等它清完才轮得到。放在最后，现有的类不受影响，ledger 用剩下的预算慢慢清。代价是清完之前 `readerRunReferences` 仍可能读不完大目录（1.6），这在今天就是这样，不是新问题。
- 压力：不进 `sweeper.ts:103` 的跳过列表。只删已经过期的 ledger，压力不缩短 TTL。

### 2.6 代码形状（复用 #1018）

prune 函数放在 `agent-session-handoff-store.ts`，作为模块级函数，不从 `index.ts` 导出（`index.ts:46-51` 是具名导出，加模块函数不改公开 d.ts）。不加成 `AgentSessionHandoffStore` 的方法，否则会改这个导出类的 d.ts。

```ts
/** A session ledger `<runtime>-<sha256 hex>.jsonl`; a `-task-` name stays terminal evidence. */
export function isAgentSessionLedgerName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}-[a-f0-9]{64}\.jsonl$/u.test(name) && !/-task-[a-f0-9]{64}\.jsonl$/u.test(name);
}

/** Removes ledgers whose last append is at least `maxAgeMs` old. Content is never parsed. */
export async function pruneSessionLedgers(input: {
  readonly directory: string;
  readonly entries: AsyncIterable<Dirent>;
  readonly nowMs: number;
  readonly maxAgeMs: number;
  readonly remove: (file: string) => Promise<boolean>;
}): Promise<void> {
  for await (const entry of input.entries) {
    if (!entry.isFile() || !isAgentSessionLedgerName(entry.name)) continue;
    const file = path.join(input.directory, entry.name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || input.nowMs - stat.mtimeMs < input.maxAgeMs) continue;
    if (!await input.remove(file)) return;
  }
}
```

`sweepHome` 里加一个分支，目录是 `path.join(home, '.byok', 'runtime-sessions')`，游标用 `entries('session-ledger', directory, homeBudget)`。`entries()` 在目录不存在时直接返回（`producers.ts:45`），不像 `evidenceDirectory`（`agent-session-handoff-store.ts:280-304`）那样会建目录。

## Q3 契约影响

| 面 | 变化 | 需要谁签 |
| --- | --- | --- |
| 公开类型 | `EXPIRING_CLASS_IDS` 多 `'session-ledger'`，`ExpiringClassId`、`RetentionClassId` 跟着变；`DEFAULT_RETENTION_TTL_MS` 和解析后的 `ttlMs` 多一个键；`api-surface/client.d.ts:7796`、`:7835` 附近的 golden 变。和 #1018 同类的 breaking（`990abd602` 的提交说明） | owner |
| 公开行为 | writer resume 第一次有了时间上限：最后一次使用后 30 天（可配）。content read 用超过这个期限的 sessionRef 会被 deny | owner，写进 spec |
| 配置 | 只多一个 `ttlMs` 键，没有新字段 | — |
| api-surface 字节 | `@byok-sdk/client`、`bin:byok-agent` 各增约 1–1.5 KB `[inferred]`（#1018 是 2 873 / 2 902 字节，包含测量截断和 `pruneAgentResults`，这次更小）。#1019 删了不少代码但没降这两个 budget（两个分支上都是 2 357 735 / 2 293 164），检查只在超过时失败（`scripts/api-surface/entry-closure.mjs:250`），所以合入 #1019 后可能还有余量，要 build 后才知道 `[unverified]`。没有余量就要 owner 签一次 bump | owner（如需 bump） |
| wire | 无。decline 不加 `code`，content read 不加 reason 值 | — |
| SQL/DDL、CI selector | 无 | — |
| spec 与文档 | `docs/spec.md:2165-2167` 加 writer resume 窗口；`:2611-2612` 表格的 Resume 行加「过期被 retention 删除」；`:2190-2193` 后加一句 ledger 本身的保留；`docs/host-local-storage-layout.md:20-22` 的目录树、`:102` 的受保护列表例外、`:117` Sessions 行；`docs/architecture/sdk-architecture.md:1608`（压力下照常清）、`:1610`（例外里加 `.byok/runtime-sessions/` 的 ledger）；`agent-session-handoff-store.ts:321` `history()` 注释里的「every historical terminal remains visible」改成「在保留期内」；CHANGELOG；budget 有 bump 时 README 的 budget 表由脚本重新生成 | — |

## Q4 实施切片与排期

### 文件

| 包 | 文件 | 改动 |
| --- | --- | --- |
| client | `daemon/retention/registry.ts` | `EXPIRING_CLASS_IDS` 末尾加 `'session-ledger'` |
| client | `daemon/retention/config.ts` | 默认 TTL 30 天 |
| client | `daemon/agent-session-handoff-store.ts` | `isAgentSessionLedgerName`、`pruneSessionLedgers`；`requireMatch`、`readerSessionCwd` 的「不存在」文本；`history()` 注释 |
| client | `daemon/retention/producers.ts` | `classify` 一行、`authority` 的 `homeScoped`、`sweepHome` 一个分支、`sweep` 表一项 |
| client | 测试 | `__tests__/retention.test.ts`、`__tests__/agent-home-contract.test.ts`、`__tests__/agent-home-readers.test.ts`，或照 #1018 在 store 的测试文件里加 |
| — | `api-surface/client.d.ts`、`api-surface/entries.json`（如需）、`CHANGELOG.md`、上面列的 docs | |

### 和其他工作的重叠

- #1019 必须先合：它改了 `producers.ts`、`registry.ts`、`agent-session-handoff-store.ts`（diff 见 `git diff origin/main...origin/claude/925-wire-v4-stage1-e245ba`）。本设计的行号都按它合入后的状态。
- 阶段 2：client 改动表（stage2 稿 Q5 client 节）没有 retention、handoff store、`offer-workspace.ts`。两者共同碰的只有 `CHANGELOG.md`、`api-surface/client.d.ts`、`docs/spec.md`，rebase 时的冲突是文本级的 `[inferred]`。
- #1018 的 `agent-result` 代码就是模板，不用改它。

### 推荐顺序

1. #1019 合入。
2. owner 回答 Q6 的问题（至少 O1、O2、O4）。
3. 一个 PR，两个 commit：`fix(client)`（代码和测试）、`docs`（spec、layout、architecture、CHANGELOG、golden）。和阶段 2 谁先合都行。
4. 放进 0.31.0 的话，类型 break 跟着这个 major 的其他 break 一起发；放到之后的版本，就要单独再出一次 client breaking 说明。由 owner 决定（O8）。

### 测试计划

单元测试：

- `pruneSessionLedgers`：过期的删、没过期的留；`-task-` 文件留；以 `-task-<hex>` 结尾的会话名留；内容损坏但过期的删；目录项、符号链接跳过；`remove` 返回 false 时停下。
- `classify`：ledger 归 `session-ledger`，`-task-` 归 `terminal-evidence`，目录里别的文件归 `byok-authority`。
- 配置：默认 30 天，接受 0，拒绝负数和非整数（现有 `integer()` 校验）。
- sweep：home 忙时不删（`withIdleHomeLease` 返回 false）；压力下照常删；排在最后，前面的类用完预算时这一 pass 不清 ledger；`bytesReclaimed` 等于被删文件的大小；大目录分多次 pass 也能清完（游标续读）。
- 一个 home 里有损坏的旧 ledger 时，`session-ledger` 删掉它以后，下一 pass 的 `reader-run` 不再在这个 home 上失败。

daemon 级测试（`agent-home-readers.test.ts`、`agent-home-contract.test.ts` 的 harness，假时钟）：

- writer session 完成 → 时钟拨过 TTL → 跑一次 pass → 用原 sessionRef resume：非重试 decline，reason 匹配「does not exist」，`startCalls` 不增加。
- reader session 同上。
- 对同一个 sessionRef 发 `agent.content.read`：deny，`identity-mismatch`，receipt 照写。
- TTL 内 resume 一次以后 mtime 刷新，再过一个 TTL 才会删。

不需要 conformance：`packages/conformance` 只测 cloud 和 core 的 retention（`conformance/src/cloud/retention.ts`、`core/retention.ts`），没有 client daemon 的 retention 套件。

要改的现有断言（PR 里逐条说明）：类的总数从 22 变 23，`__tests__/journal-pressure-matrix.test.ts:324`、`__tests__/retention.test.ts:214`、`:215` 断言 `classes` 长度是 22。这是封闭类集合的大小，加类就要跟着改，#1018 也改过 `journal-pressure-matrix.test.ts`、`retention.test.ts`、`bin-audit-log.test.ts`、`bin-format.test.ts`（`git show 990abd602 --stat`）。不用改的：`agent-home-readers.test.ts:378`、`:393` 测的是 ledger 存在但模式不对，走的不是「不存在」分支；`__tests__` 里没有按下标或顺序断言 `EXPIRING_CLASS_IDS` 的（grep）。

### 大小

代码约 60 行（store 25、producers 15、registry/config 3、文本 10），测试约 250 行，文档约 40 行 `[inferred]`。一个车道半天左右。

## Q5 风险与未核实的假设

### 风险

1. **writer resume 有了上限**：一个 Host 隔 30 天以上再 resume 同一个对话会被 decline。它本来就要处理 runtime 会话丢失时的 decline（1.3），处理路径一样：开 fresh。spec 要写清楚，升级说明要提。
2. **content read 跟着受限**：用超过 TTL 的 sessionRef 读 Agent 文件会被 deny。Host 可以换成这个 home 最近的 writer sessionRef（任何 writer session 都通过，`start-envelopes.ts:157-167`）。会不会有 Host 拿很旧的 sessionRef 读内容，本仓库看不到 `[unverified]`。
3. **条目数是流量 × TTL**：每台设备每天 1 000 个新 session、TTL 30 天，就是 3 万个 ledger，还在 65 536 的扫描上限以内，但 `readerRunReferences` 大概读不完 250 ms `[inferred]`，用 reader 的 Host 的 reader-run 保留仍可能跳过。这时 Host 可以调低 TTL，或者 owner 选 O3 的条数上限，或者另开一个 issue 让 `readerRunReferences` 可以续读。
4. **自定义 harness 名以 `-task` 结尾**：它的 ledger 永远不删（2.2）。只是多留，不会误删。
5. **升级后的积压要清很久**：ledger 排在最后，每 pass 最多删 256 个，周期 15 分钟（压力下 5 分钟，`config.ts:85-86`）。一台积压 3 万个过期 ledger 的设备，在别的类没有删除时要约 118 个 pass，也就是约 30 小时（压力下约 10 小时）才清完。这期间不出错，只是条目数降得慢。升级说明要写。
6. **mtime 不可靠的文件系统**：mtime 不随 append 更新的话，活跃的 session 也可能按创建时间过期。本地 APFS、ext4、NTFS 都会更新 `[inferred]`；`agent-result` 和 reader-run 也依赖 mtime。

### 未核实的假设

- `terminal-evidence.ts:127` 的 `recordTerminal` 一定在 execution lease 下执行 `[inferred]`。
- 合入 #1019 后两个 entry 的 closure 余量 `[unverified]`，要 build 后看。
- AiphaBee 每天的执行数没有测过，3 万是假设的数字。
- Pi 没配 `sessionDir` 时会话写在哪里 `[unverified]`。如果写在 home 里，那是 `agent-content`，归 Host。

## Q6 要 owner 决定的问题（每条带推荐答案）

| # | 问题 | 推荐 |
| --- | --- | --- |
| O1 | 保留规则：按最后一次 append 的年龄（A），还是条数（B）、终态且无引用（C）、prepared 终态即删（D） | A。规则和流量无关，能写成一句 spec；C 让崩溃留下的 ledger 永远不删，D 只覆盖 prepared |
| O2 | 默认 TTL：30 天，还是和 reader-run 一样 7 天 | 30 天，和 `confirmed-journal` 一致，给做对话 resume 的 Host 留余地；reader 的实际窗口仍是 7 天。只做 fresh 的 Host（AiphaBee）可以自己调低 |
| O3 | 要不要再加每 home 条数上限（比如 4 096） | 不加。失败模式：每天上千个新 session 的设备，ledger 多到 `readerRunReferences` 读不完（Q5 风险 3）。可能性：低，按 AiphaBee 的用法要每天上千个 turn。代价：resume 能不能成开始依赖流量，reader 的运行目录也会提前失去保护。真碰到了再加 |
| O4 | spec 里写不写 writer resume 窗口：「writer session 在最后一次 attempt 之后 `ttlMs['session-ledger']`（默认 30 天）内可以 resume；之后 resume 非重试 decline，content read deny」 | 写，加在 `docs/spec.md:2165-2167` 那段 |
| O5 | 压力下清不清 | 清，和 `agent-result` 一样。只删过期的，压力不缩短 TTL |
| O5b | 在 `EXPIRING_CLASS_IDS` 里排第几 | 排最后。排在 `reader-run` 前面能让 `readerRunReferences` 早点读得完，但升级后的积压会占满每 pass 的删除预算，现有的类要等几十个小时（Q5 风险 5） |
| O6 | ledger 不存在时换 reason 文本（不加 wire `code`、不加错误类） | 换。今天的文本让人以为是身份对不上 |
| O7 | 自定义 harness id 以 `-task` 结尾时名字有歧义，要不要对过期文件读首行判断 kind | 不读，保守地当终态证据留下。可能性很低（内置 id 只有 `pi`、`claude`、`codex`，`packages/protocol/src/constants.ts:12`），代价是删除路径要读文件内容 |
| O8 | 进不进 0.31.0 | 进。0.31.0 已经是 breaking 版本，类型变化可以一起发；它只改 client，不卡阶段 2。不进也行，代价是之后单独一次 client breaking |
| O9 | `-task-` 终态证据文件要不要一起过期（它们在生产代码里只写不读，`getTaskTerminal` 只有测试调用） | 这次不动，仍受保护。它们只在 handoff 写入前就失败时产生，增长慢；要删的话另开 issue，先确认它们作为审计证据要留多久 |
| O10 | AiphaBee 的 Pi `sessionDir` 增长 | 不归 SDK。在 AiphaBee 那边开 issue，由 AiphaBee 自己定 |

## 验证

```bash
(cd packages/client && bun run test -- retention agent-home-contract agent-home-readers agent-result-store)
bun run build && bun run typecheck && bun run check:api-surface && bun run check:version-authority
git grep -n "'session-ledger'" -- packages/client/src docs api-surface   # registry、config、producers、golden、spec、layout、architecture 都有
```

按仓库约定，完整测试在 GitHub CI 上跑，本地只跑受影响的包。

RECOMMENDATION: 新增 SDK 执行的 expiring 类 `session-ledger`，在 home 空闲时按最后一次 append 的 mtime 删超过 `ttlMs['session-ledger']`（默认 30 天，可配）的 ledger，不加条数上限，压力下照常清，`-task-` 终态证据不动，resume 和 content read 沿用现有 fail-closed 路径，只换「不存在」的 reason 文本，并把 writer resume 窗口写进 spec — confidence: MEDIUM
