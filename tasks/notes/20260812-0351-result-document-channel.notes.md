# Implementation Notes: result-document-channel

> **Status**: Active
> **Plan**: plans/plan-20260812-0351-result-document-channel.md
> **Contract**: tasks/contracts/20260812-0351-result-document-channel.contract.md
> **Review**: tasks/reviews/20260812-0351-result-document-channel.review.md
> **Last Updated**: 2026-08-12 04:20
> **Lifecycle**: notes

## Falsifier Result (run BEFORE implementation)

契约的方向性证伪先跑：宽容 `z.object()` 解析含未知 `document` 的 `task.complete` payload 时，
到底是剥离还是透传。若透传，flag 门控的前提就不成立。

- 红/绿故事：在**未改动**的 `TaskCompletePayloadSchema` 上跑
  `expect('document' in parsed).toBe(false)` → **PASS**（1 passed，
  `vitest run src/__tests__/result-document.test.ts`）。旧 server 确实静默剥离。
  加上 `document` 字段后同一断言 **FAIL**（`expected true to be false`）——两侧行为差异被实测钉死。
- 前提成立 → flag 门控必要（结构化主结果被静默剥离＝无声数据丢失），实现继续。
- 永久形态：`result-document.test.ts` 里保留一份改动前 schema 的逐字复刻
  `PreDocumentTaskCompletePayloadSchema` 断言剥离，另一条断言新 schema 保留字段；
  两半故事都常驻断言，不依赖这份笔记的口述。

## Golden Regeneration Justification

只重生成 `golden/v1.frozen.json`，`golden/v1.envelopes.ndjson` **未动**。

重生成前先证明改动是纯 additive：freeze-guard 指纹 diff 只有 5 处**新增**、零删除、零改型：

```
+ "result-document"          (capabilityFlags)
+ "document": {}             (task.complete payload schema，在 4 处嵌套渲染中各一次)
```

`required: ["summary","sessionRef"]` 未变（新字段 optional）；`PROTOCOL_VERSION` 仍为 1；
`.strict()` 面（`PermissionPolicySchema`、instruction blob-ref）零接触。
golden 文件的 git diff 里 5 行删除全部是 `}` / `]` 的逗号换行重排，无内容变更。

重生成方式：临时把 `freeze-guard.test.ts` 的 `buildFrozenSnapshot()` 导出，用一次性测试文件
调用它写回 `golden/v1.frozen.json`（`JSON.stringify(x, null, 2) + '\n'`，与原格式一致），
随即删除临时文件并还原 export。金样本因此来自**活 schema 本身**，不是手改出来的——
避免「为了让测试过而编辑金样本」这一被 version.ts 头注释明令禁止的路径。

`v1.envelopes.ndjson` 保持不动是刻意的：它是「一个 v1 peer 真实发过的历史 wire bytes」语料，
其回归价值正来自于**不含** `document` 的旧 task.complete 行今天仍能原样解析并 field-for-field
deep-equal。往那行里补 `document` 会销毁这个证据，而且 corpus 断言「每个 message type 恰好一行」，
也不允许新增一行。旧行今天仍全绿（改动后 freeze-guard 只有指纹一条失败，corpus 三条全通过）。

## Codex Adversarial Review — Findings And Dispositions

双轨验收的 codex 对抗二审给出 3×P1 + 1×P2，全部属实，全部已修（coordinator 2026-08-12 裁定）。

| # | 等级 | 问题 | 处置 |
|---|---|---|---|
| F1 | P1 | root 处 `JSON.stringify` 成功 ≠ 无损。`{required: undefined, n: NaN, arr:[undefined]}` 旧实现**接受**，出去变成 `{"n":null,"arr":[null]}`——格式合法、低于 cap、且不是产品持有的值 | 修复：canonical snapshot + 结构深等 |
| F2 | P1 | `toJSON(key)` 是上下文相关的：root（`key === ''`）可以答小、嵌在 `document` 键下答大，root-only 度量对上线字节毫无约束。不稳定 getter 同理 | 与 F1 同一机制一并修掉：度量原件、**发送快照** |
| F3 | P1 | 能力检查发生在 `await observeGit(...)` **之前**，该窗口内重连到 N-1 server 会把已排队的 task.complete 投给会 strip 的对端 | (a) 已修：最后一个 await 之后、交给 send 之前重查 flag；(b) outbox drain guard 评估后**不做**，见下 |
| F4 | P2 | 投影测试里超限帧与后续合法帧用了相同 summary/sessionRef，accept-and-strip 的实现也能过 | 已修：两帧值不同 + 超限帧后先断言仍 Running/result 未 settle |

F3(b) 评估结论（按裁定「seam 不干净就不要 hack」）：`ConnectionManager` 的 outbox 是
`private readonly outbox: Envelope[]`，`onAcked(capabilities)` 里先写 `serverCapabilities`
再 `void this.drainOutbox()`——挂钩点本身是有的。但要在那里把一条 task.complete 转成 task.fail，
需要让纯传输层的队列 (1) 理解 task.complete 的 payload 语义，(2) 自行铸造替代终态消息，
(3) 而此时 `TaskRunner.finish()` 早已执行、任务已从 `this.tasks` 移除、本地 observer/journal
都认为它成功了。等于把「终态结论」的第二权威放进发送队列里，比它关掉的窗口更坏。故不实现，
残余窗口写进 `docs/protocol.md` §7.2 与本文件：**回滚恰好落在单次 in-flight 发送内**。

## Design Decisions

- **单一权威 + canonical snapshot**（F1/F2 后的最终形态）：`checkResultDocument(document)`
  导出自 `packages/protocol/src/messages.ts`，返回
  `{ok:true,bytes,canonical}` / `{ok:false,reason:'not-serializable'}` /
  `{ok:false,reason:'over-cap',bytes}` / `{ok:false,reason:'not-plain-json'}`。
  步骤：stringify（非 undefined）→ 字节 cap → `JSON.parse` 得 canonical snapshot →
  原件与 snapshot 递归结构深等（自有可枚举 string key 集合相同、数组按长度与元素、
  基本类型严格相等，因此 `NaN` 天然不可能通过）。schema 的 refine 调它，client 的发送前门
  也调它，且 **client 把 snapshot 而非原对象放上 wire**——纯数据在 root 与嵌套下序列化结果
  相同，「量的是什么就发的是什么」成为结构性保证，contextual `toJSON(key)` 与不稳定 getter
  一起失效。对纯数据幂等，所以 server 在已解析 payload 上重跑必然与 daemon 一致。
- **深等实现零 node 内置**（protocol 包约束）：手写 `isSameJsonData`，只覆盖纯 JSON 能表达的
  三种形状；比较的不对称性正是要点——`b` 恒为 `JSON.parse` 输出的纯数据，凡 `a` 侧是 JSON
  表达不了的东西（Date/函数/undefined/NaN/symbol/被 toJSON 改写/二次读取变化的 getter）都会
  在这里表现为形状或值不匹配而被拒。
- **数据不在自有可枚举 key 上的容器另立一条规则**（coordinator 2026-08-12 裁定，原为我上报的
  残余）：结构比较看不见「数据藏在别处」——`new Map([['a',1]])` 序列化成 `{}`，与 `{}` 结构相等，
  会把空文档当作任务真实结果交出去，正是 F1 那一类静默错误。故：**自有可枚举 string key 为空、
  且 prototype 既非 `Object.prototype` 也非 `null` 的对象一律拒**，在每个对象节点上生效
  （函数递归），嵌套的 Map/Set/异类实例与顶层一样死。边界：有自有可枚举字段的类实例**接受**
  （数据确实完整往返），`Object.create(null)` 带数据**接受**（null prototype 也是纯数据），
  但值来自 **prototype 级 getter** 的类实例**拒**——那些属性 JSON 根本看不见，按定义就不是
  plain JSON data。该字段是本刀新增，验证语义与字段同批出厂，不构成 post-freeze 收紧。
- **度量实现用 `TextEncoder`，不是 `Buffer`**（与 brief 的字面写法有出入，语义完全等价：
  `new TextEncoder().encode(s).length === Buffer.byteLength(s,'utf8')`）。理由：protocol 包目前
  零 node 内置依赖，同文件既有的 64KB inline 限额也正是用 `TextEncoder` 测的
  （`isWithinInlineByteLimit`）——同一文件里两套字节度量口径才是真的第二权威。
- **`document` 用 `z.unknown()` 而非 `Record<string, unknown>`**：合法 JSON 根不止对象。
- **可序列化的判定按 wire 编码器的实际行为定义**：`JSON.stringify` 既不抛（循环引用/BigInt/
  抛错的 toJSON）也不返回 `undefined`（函数/symbol/undefined 根）。不做额外的 parse 回读——
  1 MiB 上再跑一次 parse 是纯开销，且 stringify 成功即等价于能过 envelope 编解码。
- **client 四个 fail-closed 分支顺序**：extractor 抛错 → 返回 thenable → cap/可序列化/
  plain-JSON → server 能力。能力放最后是刻意的：document 本身非法是宿主自己的 bug，即使对面
  server 根本收不下也值得如实报出来。四个分支共用同一个稳定 reason 前缀，且测试用统一的
  `expectFailClosed` 断言完整契约（task.fail + 前缀 + retryable:false + 零 task.complete +
  任何 envelope 里都没有 `"document"`），避免各分支断言强度漂移（gatekeeper addendum）。
- **能力在完成路径两端各读一次**（F3(a)）：`resolveResultDocument` 里读一次，`observeGit`
  之后、`send` 之前再读一次；两处都走 `hasResultDocumentCapability()` 这一个私有方法，
  语义（缺失即 fail-closed）不会分叉。
- **extractor 入参窄化**：`(finalOutput: string, task: {taskId, sessionRef})`。不给 session
  句柄、不给 workspaceDir、不给 adapter——这个缝是「把 runtime 已产出的文本变成产品 JSON」，
  不是通用的 end-of-task 回调。
- **同步契约由运行时强制，不止写在注释里**（coordinator 2026-08-12 裁定）：返回值不会被 await，
  promise 经 `JSON.stringify` 是 `{}`——格式合法、远在 cap 之下、且**完全错误**的文档，会被
  server 收下、落库、当成产品真实终态结果交付。自信地交付错误结果比失败更坏，正是本刀要防的
  静默错误类，所以 thenable 与抛错同级 fail-closed（`typeof value?.then === 'function'`）。
- **document 解析位置**：放在 `observeGit(active,'completed')` **之前**。这样交付失败的任务走
  `fail()` 自带的 salvage 观测，而不是先被观测成 completed 再失败（否则一个任务会产生两次 git 观测）。
- **payload 用条件展开** `...(document !== undefined ? {document} : {})`：未配置 extractor 时
  `task.complete` payload 与改动前逐字节一致，不带一个显式的 `document: undefined` 键。
- **server 侧不做持久化改动**：`TaskResult` 整体以 `result_json` 单一 JSON blob 落库
  （`sqlite-task-store.ts:269/334`），`summary`/`artifactRefs` 本就在里面，`document` 自动同权威
  同 parity，无需新列、无迁移、无第二权威。已用 SqliteTaskStore 往返测试钉住。
- **conn.ack 广播**：`ws-server.ts:16` 的 `SUPPORTED_CAPABILITIES = [...CAPABILITY_FLAGS]`，
  新 flag 自动流出；全仓再无第二处手工维护的广播列表（已 grep 确认）。

## Deviations From Plan Or Spec

| 偏差 | 原因 |
|---|---|
| 度量用 `TextEncoder` 而非 brief 字面的 `Buffer.byteLength` | 语义等价；protocol 包保持零 node 内置依赖，且与同文件既有 inline 限额度量口径统一 |
| `v1.envelopes.ndjson` 未重生成 | 它是历史 wire bytes 回归语料，旧行不含 `document` 恰是 additive 的证据；corpus 断言也不允许加行 |
| 新增导出 `RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX` | 沿用本仓既有的稳定 reason 前缀约定（`MAX_DURATION_EXCEEDED_REASON_PREFIX` 等），让四个 fail-closed 分支对 embedder 可机器识别 |
| 第四条 fail-closed 分支：extractor 返回 thenable | coordinator 2026-08-12 裁定加入。brief 原定三条，但 promise 编码成 `{}` 是「静默交付错误结果」，比失败更坏，属于本刀要防的同一类问题 |
| `checkResultDocument` 语义从「stringify 成功 + cap」升级为「canonical snapshot + 结构深等」，返回值增 `canonical` | codex F1/F2（P1），coordinator 裁定。旧语义可被 contextual `toJSON(key)` 绕过，且不能证明无损 |
| F3(b) outbox drain guard 不实现 | 裁定即含「seam 不干净就不要 hack」。评估见上；残余窗口已写进 protocol.md §7.2 |
| 零可枚举 key + 非 plain prototype 的对象一律拒（Map/Set/prototype-getter 类实例） | 我上报的残余，coordinator 裁定 APPLY。理由：Map-equals-`{}` 与 F1 同属静默错误输出类；`document` 是本刀新增字段，验证语义与字段同批出厂，不是 post-freeze 收紧 |

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| 无 flag 时静默省略 document | 拒绝 | 结构化主结果被静默丢失＝兼容回退，仓库纪律禁止 |
| 截断超限 document | 拒绝 | 截断产物必非法 JSON，下游明确要求 reject-at-boundary |
| client 侧自建 cap 度量 | 拒绝 | 第二权威；两端度量一旦漂移就是「本地拒了 wire 能收的」或反之 |
| 运行时检测 extractor 返回 thenable 并 fail | 采纳（coordinator 裁定） | 起初按 brief 的三分支范围留作注释契约并上报；裁定后落地——promise 会 stringify 成合法但错误的 `{}` 并被当作真实结果交付，这不是防御性冗余，是防静默错误输出 |

## Open Questions

- None（此前上报的 Map-equals-`{}` 残余已由 coordinator 裁定并落地，见 Design Decisions 与
  `docs/protocol.md` §7.2）。

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
