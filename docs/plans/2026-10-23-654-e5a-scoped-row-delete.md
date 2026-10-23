# #654 E5a：明文 task 的 scoped row-delete

状态：实施计划。下一个版本的 draft PR。0.29.0 发布前不合入。

日期：2026-10-23。基线 `91f5c531`（origin/main）。
依据：[#654 设计](2026-10-22-654-hosted-wire-e2ee.md) §11.3、§11.5、§13.1 E5、§14 D6。[hosted Host contract](../hosted-host-contract.md) §6 的 Gap「retention and scoped deletion」。

## 1. 目标与范围

Host 能删除一个 task 的正文。操作在 Node 和 Workers（Hyperdrive）上都能运行。删除后，task 的 identity fence 仍然有效。

- 做：`ByokCloud.redactTasks(tenant, { taskIds })`。按 taskId 选行。
- 不做：`redactScope`。明文行没有 `scopeId` 列。E3b 加这一列以后，再按 scope 选行。
- 不做：整个 tenant 的 erasure（另开 issue）；加密类别的 crypto-shredding（E5b，等 E2）。

## 2. P1：要处理的行

redaction 只处理带 taskId 的行。下表来自现状代码。

| 位置 | 选行方式 | 处理 |
| --- | --- | --- |
| `device_request_receipts` 的 `task-offer:<messageId>` | messageId 由 tenant、taskId、deviceId、agentRef 推出（`packages/cloud/src/offer-identity.ts`）。cloud 读 task 行后算出 key | 正文换成 tombstone |
| `device_request_receipts` 的 `task:<taskId>:terminal` | key 含 taskId | 正文换成 tombstone |
| `device_request_receipts` 的 `agent-message-offer:<deviceId>:<taskId>` | key 含 taskId | 正文换成 tombstone |
| `agent_message_admission.payload_body`、`terminal_body` | `task_id` 列 | 两列都换成 tombstone |
| `task.terminal_cause`、`task.cancel_reason` | 主键 | 置 NULL。status、cancel 时间和 cancel message id 不变 |
| `activity_tail`、`approval_timeline_tail`、`agent_message_draft` | 主键含 `task_id` | 删除行。这些行本来就按 TTL 删除 |
| `outbox.body` | 设备是 task 的 `device_id` 或 `owner_device_id`，正文里的 `task_id` 等于 taskId | `acked` 和 `expired` 行的正文换成 tombstone，同时更新 `body_hash` 和 `byte_size`。有 `pending` 行时拒绝，可以重试 |
| R2 `tenants/<tenant>/objects/sha256/<hex>` | 上面各正文里的 BlobRef（带 `blobId` 和 `contentHash` 的对象） | 按现有 orphan GC 的条件删除：`ref_count = 0`，没有 `object_reference`，没有 `reserved` 的 reservation |

不处理，写进文档：

- `agent_egress_event.payload_json`：没有 task 列，payload 里也没有 taskId。按 Agent 删除另开 issue。
- `attested_record`（`task.terminal` truth 记录）：设备经 truth 路由读回正文。改读回路径不在本切片。
- `agent-input-preparation-*`、`agent-home-projection-*`、`agent-content-*` receipt：key 里没有 taskId。
- `device.device_name`：属于设备。`revokeDevice` 和 tenant erasure 处理它。
- `agent_memory_projection_head`：继续用 `eraseAgentMemoryProjection`。
- 备份、副本、日志和 `cloud-do` 的 Durable Object 存储。

## 3. P2：tombstone 后的读者

tombstone 是一个 JSON 对象。它只由原正文推出，所以同一正文总是得到同一个 tombstone：

```json
{"byokRedacted":1,"sha256":"<原正文 UTF-8 的 hex>","bytes":<原正文字节数>,"type":"<原正文顶层 type，可选>"}
```

`type` 只在原正文的顶层 `type` 是字符串时保留。它是 envelope 类型，不是自由文本。`reason`、`summary` 等自由文本都不保留。

格式只在 cloud 里定义一次。store 在事务里通过 cloud 传入的回调生成 tombstone。这个模式与 `mailbox.append` 的 `materialize` 相同。

| 读者 | 现在对 tombstone 的行为 | 改法 |
| --- | --- | --- |
| offer fence（`cloud.ts` 的 `enqueueTaskEnvelope`） | 整串比较，相同正文也冲突 | 存的值等于新正文，或等于新正文的 tombstone，都算相同。不同正文仍返回 `coordination_input_invalid` |
| agent-message offer fence（`cloud.ts` 的 `agentMessageOfferWriter`） | 整串比较 | 同上。不同正文仍返回 `agent_content_request_mismatch` |
| admission 的 reserve、read、finalize | 整串比较 | 不改。binding receipt 与 admission 在同一事务里换成 tombstone，设备的重放在 binding 检查处就被拒绝，到不了 admission |
| Host 的 `readAgentMessageDisposition` | 比较不上，返回 `undefined` | 返回 `undefined` 前读 admission。正文是 tombstone 时抛 `task_content_redacted` |
| `recordTerminal` | 抛普通 `Error`，路由返回 500 | 认出 tombstone 后直接返回。task 已经是终态 |
| claim gate、recovery gate | `JSON.parse(...).payload.x` 抛 `TypeError` | 认出 tombstone 后拒绝，用现有原因 `claim_offer_mismatch`、`recovery_offer_mismatch` |
| `agent.message.publish` 重放 | 读 tombstone 的 `agentRef` 时抛 `TypeError`，路由返回 500 | 认出 tombstone 后拒绝，用现有原因 `agent_message_binding_mismatch`。不调用 consumer，不进 admission |
| 已 redact 的终态 task 收到 `task.progress`、`task.await_approval`、`task.approval_resolved` | 重新写入 activity 或 approval 行 | 有审计 receipt 时不写入，按已处理完成。只在 task 已是终态时多读一次 receipt |
| `cancelTask` | `decodeEnvelope` 读 tombstone 失败 | 取消 envelope 是 tombstone 时，跳过 seq 检查，返回 attempt |
| `readTaskOffer`、`readDeviceTerminal`、`readTaskResult`、`readTaskAgentMessage`、`readTaskAgentMessageDraft` | 抛各种错误 | 抛新的 `ByokCloudError('task_content_redacted')` |
| `readTerminalReceipt` | 返回原始 receipt | 正文是 tombstone 时抛 `task_content_redacted`，与其他读接口一致 |
| 没有终态 receipt 的 task（例如 claim 前被取消）收到迟到的 `task.decline` 或 `task.cancelled` | 新建一条明文终态 receipt | 写阶段在终态 key 不存在时写入 `codec.absent` tombstone（`ON CONFLICT DO NOTHING`）。迟到的终态按重放处理，不写任何内容 |
| `listDeadLetters` | 返回 tombstone 正文 | 不改。正文已无内容；重放被拒绝，`discardDeadLetter` 可以删除该行 |
| `readTaskAttempt` | 正常 | 不改。status 仍可读 |
| dead-letter 重放（`cleanup.ts`） | tombstone 不是 envelope，抛 `cleanup_invalid_input` | 不改。拒绝重放是正确结果 |

wire 不变。设备看到的拒绝原因都是现有的值。

## 4. P3：设计决定

### 4.1 API

```ts
interface ByokCloud {
  redactTasks(tenant: TenantId, input: { readonly taskIds: readonly string[] }): Promise<TaskRedactionResult>;
}
interface TaskRedactionResult {
  readonly tasks: readonly TaskRedactionTaskResult[];
}
type TaskRedactionTaskResult =
  | { readonly taskId: string; readonly outcome: 'redacted' | 'already_redacted'; readonly counts: TaskRedactionCounts }
  | { readonly taskId: string; readonly outcome: 'not_found' }
  | { readonly taskId: string; readonly outcome: 'refused'; readonly reason: 'task_not_terminal' | 'pending_delivery' };
```

- 新的可选 port `taskRedactionStore`，与 `agentMemoryProjectionStore` 相同。没有配置时抛 `task_redaction_unavailable`。
- 一次最多 100 个 taskId，不能为空，不能重复。否则抛 `coordination_input_invalid`。
- 每个 task 单独处理，单独提交。一个 task 被拒绝，不影响其他 task。
- `not_found`：本 tenant 没有这个 task。结果不说明别的 tenant 有没有它。

### 4.2 权限

- 这是 Host 的 control-plane 调用，与 `cancelTask` 和 `eraseAgentMemoryProjection` 一样，不是设备路由。
- 每条 SQL 都带 `tenant_id = $1`。别的 tenant 的同名 taskId 不受影响。

### 4.3 前提

- task 必须是终态：`complete`、`failed` 或 `cancelled`。`cancel_requested` 不算。否则返回 `refused: task_not_terminal`。
- task 不能有 `pending` 的 outbox 行。否则返回 `refused: pending_delivery`。设备 ack 后，或 7 天后变成 `expired` 后，可以重试。

### 4.4 事务与幂等

Postgres store 分两步：

1. 读阶段，不加锁：读 task 行，检查前提，读各个正文，找出 BlobRef 的 hash。按 orphan GC 的条件，逐个 hash 删除 R2 对象并结算 `storage_usage`。
2. 写阶段，一个事务：`SELECT ... FROM task ... FOR UPDATE`，与 admission 和 cancellation 用同一个锁。再检查一次前提。终态 key 不存在时，先写入 `codec.absent` tombstone，再读 receipt。顺序不能反：反过来时，设备终态可能在读和写之间提交，留下明文。把还不是 tombstone 的正文换成 tombstone。置 NULL 两个自由文本列。删除 activity、approval 和 draft 行。写审计 receipt。提交。

先删对象，再写 tombstone。中途失败时，正文还在，重试会重新找到 hash；对象已删时返回 `absent`。

两步之间的缺口（写进 `docs/security.md`）：

- 第一步删了对象，第二步失败或拒绝时，正文里的 `artifactRefs` 指向已删的对象。重试完成 redaction，审计记录 `objectsDeleted: 0`。
- 两步之间写入的正文，其对象留给 orphan GC。
- 入站门控不加锁读审计 receipt。redaction 进行中到达的 progress 或 approval 报告可能在第二步之后写入一行。再调用一次 `redactTasks` 会删除这行。彻底关闭需要给 `ActivityStore` 和 `ApprovalTimelineStore` 加 `delete`，这是公开 port 的改动，等维护者决定。

审计 receipt：key 是 `task-redaction:<taskId>`，正文是 `{ redactedAt, counts }`，不含正文。它是 identity 类，在 `receipt-retention.ts` 登记。第一次写入为准。

第二次调用：没有要改的行，返回 `already_redacted`，计数为零，不改任何行。

### 4.5 R2 对象与同 hash 共享

task 不写 `object_reference`，所以 task 的对象 `ref_count` 为 0。orphan GC 本来就会在 1 天的 grace 之后删除它们。同一 tenant 里，两个 task 的内容相同时，共用一个对象。redaction 删除这个对象后，另一个 task 也读不到它。没有 redaction 时，它也会在 grace 之后被删除。这一点要维护者确认（§6 第 4 项）。本切片不开始写 `object_reference`。

### 4.6 观测

- 返回值给出每个 task 的计数：`receiptsRedacted`、`admissionsRedacted`、`outboxRedacted`、`rowsDeleted`、`objectsDeleted`。
- 审计 receipt 保存同样的计数和时间。
- 不写日志，不把正文放进错误消息。

### 4.7 运行环境

store 是 `PostgresTaskRedactionStore`，从 `@byok-sdk/cloud-dataplane/runtime` 和包根导出。它只用 `pg` 和 `R2ObjectMaintenanceStore`（`fetch` 加 `aws4fetch`）。sha256 用 cloud 的 `CloudCrypto`（WebCrypto）。`runtime` 的 `platform: 'neutral'` 构建保证没有 node 内置模块。

### 4.8 与 §11.3 的差别

§11.3 写的是 outbox 行不由 redaction 处理：acked 行等保留期，expired 行调用 `discardDeadLetter`。本切片改为把 acked 和 expired 行的正文换成 tombstone，行本身留下。理由：

- 不替换正文，canary 扫描在保留期结束前不能零命中。
- `discardDeadLetter` 只在 Node 上运行。丢失设备的 task 只剩 expired 行，在 Workers 上就无法删除正文。
- 行留下，`recoverableFrom` 的下限（`mailbox.ts` 的 `#recoverableFrom`）和 message id 的唯一约束都不变。mailbox 用量是对现存行求和，所以 `byte_size` 随 tombstone 更新即可。

## 5. 测试

- cloud 单元测试（in-memory store，直接写入 tombstone）：tombstone 是确定的；fence 对相同正文放行，对不同正文冲突；`recordTerminal`、claim gate 和 `cancelTask` 遇到 tombstone 不抛错；读接口抛 `task_content_redacted`；没有 store 时抛 `task_redaction_unavailable`；输入检查。
- Postgres（dataplane job）：task A 和 task B 各带不同的 canary，只放在 task 内容里。redact A 以后：
  - 扫描每个表、每个列和每个对象，A 的 canary 零命中；
  - B 的每一行和每个对象，hash 与 redaction 前相同；
  - 另一个 tenant 里同名 taskId 的行不变；
  - 第二次调用返回 `already_redacted`，不改任何行；
  - `task.complete`、`agent.message.publish` 和 `task.progress` 的重放不报错，扫描仍为零命中；
  - Host 用相同正文和不同正文重新提交；
  - `pending_delivery` 和 `task_not_terminal` 的拒绝；
  - redaction 后调用 `cancelTask`。
- Workers：`wrangler dev` 下的 fixture Worker 通过 `@byok-sdk/cloud-dataplane/runtime` 和 Hyperdrive 运行 `redactTasks`。Node 写入数据，并扫描结果。门控沿用 `BYOK_TEST_WORKER_DATAPLANE`，dataplane job 已设置 `BYOK_REQUIRE_WORKER_DATAPLANE=1`。
- S0 的扫描函数移到 `__tests__/support/plaintext-scan.ts`，两个测试共用。S0 的断言不变。
- 终态 fence：task D 在 redaction 后收到带 canary 的 `task.decline` 和 `task.cancelled`，canary 仍零命中，`readTerminalReceipt` 和 `readDeviceTerminal` 抛 `task_content_redacted`，`readTaskResult` 仍是 `cancelled`。
- 两步之间失败：第二步的 tombstone 回调抛错。对象已删，内容行不变，没有 fence 和审计行。重试返回 `redacted`，`objectsDeleted` 为 0，canary 零命中。

## 6. 要维护者确认

1. API 形状（§4.1）和两个新错误码 `task_content_redacted`、`task_redaction_unavailable`。
2. api-surface budget：cloud、cloud-dataplane 和 cloud-dataplane/runtime 的字节数。实测数字写在 PR 正文。`api-surface/entries.json` 也被 #768 修改，所以 budget 改动先放在补丁里，等协调会话决定。
3. 不加 SQL migration。tombstone 放进现有的 `text NOT NULL` 列。审计记录放进 `device_request_receipts`。
4. outbox 处理与 §11.3 不同（§4.8）；同 hash 共享的对象会一起删除（§4.5）。
5. 不加新依赖，不改 CI selector 映射，不改 wire。
