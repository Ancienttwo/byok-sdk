# 托管 wire 按数据类别端到端加密（#654 设计草案）

状态：设计草案第二版，等待 owner 决定。本文不改变现行 SDK API、wire、schema、存储或部署。

日期：2026-10-22（Asia/Taipei）。
SDK 基线：`7c0bbebc720de5bebb13b7529ad161b9c19f03bb`。第一版随 [PR #685](https://github.com/Ancienttwo/byok-sdk/pull/685) 合入，基线是 `473cc4c4`。第一版引用的源码文件在两个基线之间没有变化。`docs/spec.md` 的行号已按新基线更新。第二版新增的引用都按新基线核对过。
第二版新增：§2.0 托管 wire 地图；§6.1 的 v1 范围；§7.9 多设备；§8.1 与 §8.6 的填充帧和大内容规则；§9.3 漏列的内容摘要字段；§13.5 故障模式；§13.6 0.28.3 的首个切片；§14 的新决定与 owner 问题。§8.1 的填充帧和 §9.3 的摘要字段来自 PR #685 的两条审查意见。§8.6 的批次上限问题是第二版核对时发现的。
下游源码核对基线：AiphaBee `5b5fc4ce`，只读核对。未核对下游线上部署。
2026-10-23 修订：按 [issue 655](https://github.com/Ancienttwo/byok-sdk/issues/655) 的身份对应决定，更新 §7.2、§7.4、§7.9、§12.1 和 §14（新增 §14.2）。再按设备划分 scope，更新新设备加入（§7.9）和浏览器恢复（§1、§5.4、§7.8、§13.2、§13.5、§14）。
关联：[issue 654](https://github.com/Ancienttwo/byok-sdk/issues/654)。发版台账 [issue 715](https://github.com/Ancienttwo/byok-sdk/issues/715) 把 #654 列进 0.28.3，先出设计。设备身份对应见 [issue 655](https://github.com/Ancienttwo/byok-sdk/issues/655)。H 路径见[双车道 Host 方案](2026-10-21-dual-host-collaboration.md)。托管 Host 的现行契约见 [hosted Host contract](../hosted-host-contract.md)（PR #682 合入）。

## 1. 目标、范围与建议

目标：

- 开启加密的数据类别，在 Host 的云端、数据库、对象存储、日志和备份里只有密文。
- Host 只凭明文元数据完成路由、去重、幂等和配额。
- 缺密钥、解密失败或版本不符时一律拒绝，不回退明文。
- 撤销设备或客户端之后，被撤销的一方读不到之后的内容。
- 用户可以按 scope 删除内容。防重放的 identity receipt 继续有效。

不在范围：

- provider secret 的密封。它已经存在（`packages/core/src/sealed-provider-secret.ts`）。
- 本机 control socket 与 IPC。
- 隐藏元数据：谁在何时与哪台设备通信、内容大致多长。
- 防御 Host 下发的恶意前端代码。见 §5.4。
- 在云端执行的任务（`cloud-do` 托管执行器）。它必须读明文，所以不能使用加密类别。
- 0.28.1 与 0.28.2。

建议（细节见各节，决定见 §14）：

- 加密策略按 task 冻结。Host 在 offer 里写明 scope 和加密类别。类别是固定的字段组：任务输入、Agent 消息、结果与过程、记忆投影。
- 只有不由 Host 生成的内容才能对 Host 加密。产品云端用可读 history 组装的 ContextPack 保持明文。一个 offer 可以同时带两种作者的内容，只有成员写的部分进 C1。
- 密钥分三层：每个 tenant 一条只含公钥的成员链；每个 scope 一组按 epoch 轮换的对称 scope key；每个设备和客户端各有签名密钥与 KEM 密钥。
- 信任锚由用户携带：客户端生成配对验证秘密，经配对码交给设备，不发给 Host。只信 Host 目录的方式与今天的 provider secret 同级，不满足 #654 需求 1。
- wire 在 v3 内做双向 gated addition。设备与 Host 都必须声明 `sealed-payload-v1`。
- 幂等改为比较「明文元数据 + keyed content MAC」，不比较密文字节。
- 删除提供两条路：加密类别用 crypto-shredding；全部类别都可用能在 Workers 上运行的 scoped row-delete。
- Host 按 routine 发起的任务复用成员封装的 routine 模板。模板身份是 `routineId` 加 `definitionVersion`，由设备校验。
- 浏览器成员丢失密钥（例如 Safari ITP 删除 IndexedDB）时，按 scope 恢复：持有某个 scope key 的成员重新批准浏览器，为这个 scope 签署 `scope-policy` 更新，再重发 key package（§7.8）。一个 scope 只有在它的全部成员都丢失密钥时才丢数据。
- v1 只交付 C1 和 C3，C2 按需开启。C4、输入准备和草稿等到 v2（§6.1）。
- 加密前的明文用带长度前缀的帧。16 KiB 以内按 256 字节对齐，更大时用 Padmé。填充后超过 256 KiB 的密文放进 blob（§8.6）。
- 加密类别里，对内容计算的摘要只能是密文的 SHA-256、keyed MAC，或者移进密文（§9.3）。
- 0.28.3 只交付不改 wire 的切片 S0：`docs/security.md` 写托管 surface 的现状威胁模型，再加一个 canary 明文清单测试。E1–E6 进之后的功能版本（§13.6）。

## 2. P1：现状与真实边界

### 2.0 托管 wire 地图

托管 wire 由三个包承载。`@byok-sdk/protocol` 定义 envelope 和 payload schema。`@byok-sdk/cloud` 注册路由，处理 inbound。`@byok-sdk/cloud-dataplane` 把数据存进 Postgres 和 R2。

envelope 的字段（`packages/protocol/src/envelope.ts:22-41`）：

| 字段 | 作用 | Host 怎样使用 |
| --- | --- | --- |
| `v` | 协议版本，必须等于 `PROTOCOL_VERSION`，现在是 3（`packages/protocol/src/version.ts:35`） | 版本门 |
| `id` | envelope 的 UUID | inbound 去重。server → daemon 方向，offer、审批和 steer 把 mailbox 的 `message_id` 用作 envelope id（`packages/cloud/src/cloud.ts:1134-1135`、`:1987`、`:1623`）。content ack 和消息 disposition 的 `message_id` 带命名空间前缀，与 envelope id 不同（`cloud.ts:1857-1859`、`:1890-1893`） |
| `ts` | 带时区的时间 | 传输元数据 |
| `type` | 消息类型 | 选择 payload schema；类型白名单；路由 |
| `task_id` | task 身份 | 所有权、状态机、取消过滤 |
| `session_ref` | 会话引用 | `packages/cloud` 不读它。payload 里的 `sessionRef` 用于绑定检查（`packages/cloud/src/inbound.ts:245`） |
| `seq` | mailbox 序号。server → daemon 的类型必须带 | 排序与 ack |
| `payload` | 由 `type` 选择的内容 | 只需要 §8.5 列出的字段 |

托管 wire 的设备路由（在 `packages/cloud/src/cloud.ts:863-1108` 注册）：

| 路由 | 内容 | 上限 |
| --- | --- | --- |
| `POST /byok/pair`、`/byok/challenge`、`/byok/token` | 配对和设备凭据（`cloud.ts:863-873`） | — |
| `GET /byok/events?cursor&afterSeq` | server → daemon 的 mailbox 行 | 每页 50 行，长轮询最多 50 秒（`cloud.ts:215-218`） |
| `POST /byok/messages` | daemon → server 的 envelope 批次 | 最多 256 个（`packages/protocol/src/http-api.ts:269-271`）；2 MiB（`packages/cloud/src/handlers/messages.ts:87`） |
| `POST /byok/agent-memory-projections` | 记忆快照 | 1 MiB（`packages/cloud/src/handlers/agent-memory-projections.ts:18`） |
| `PUT /byok/input-preparations/:requestId/completion` | 输入准备回执，含 §9.3 的摘要字段 | 没有字节上限（`packages/cloud/src/handlers/input-preparations.ts:58`） |
| `PUT /byok/records/:kind/:key` | truth 记录，走 device proof | 2 MiB（`packages/cloud/src/handlers/truth.ts:37`） |
| `POST /byok/blobs` 与 presigned 的 `PUT /byok/blobs/:id/content` | blob 元数据与字节 | 100 MiB（`cloud.ts:214`） |

排序、去重和 ack 只用元数据：

- server → daemon：outbox 行的主键是 `(tenant_id, device_id, seq)`。`message_id` 在 tenant 和设备内唯一（`deploy/sql/0002_core_domain.sql:95-107`）。`seq` 在设备行锁下分配（`packages/cloud-dataplane/src/stores/core/outbox-writer.ts:112-123`）。`readAfter` 按 `seq` 读 `pending` 行（`packages/cloud-dataplane/src/stores/core/mailbox.ts:145-155`）。
- 读取不算 ack。唯一的 ack 是设备下一次轮询带回的 `cursor`（`packages/cloud/src/handlers/events.ts:8-12`）。`advanceCursor` 单调推进它（`mailbox.ts:195`）。
- task offer 的 `message_id` 由 tenant、taskId、deviceId 和 agentRef 推出（`packages/cloud/src/offer-identity.ts:13-16`）。同一 `message_id` 再次追加时，返回已有的行（`mailbox.ts:111-121`）。
- daemon → server：inbound 按 envelope `id` 去重，范围是 tenant、设备和 Agent（`deploy/sql/0001_cloud_local.sql:109-115`；`deploy/sql/0019_agent_ref_replay_keys.sql:26-28`）。终态另按 `task:<id>:terminal` receipt 去重（`packages/cloud/src/inbound.ts:866-874`）。

Host 今天会解析每个 payload：

- `POST /byok/messages` 用完整的 `EnvelopeSchema` 校验批次（`http-api.ts:271`）。
- `GET /byok/events` 在投递前对每一行调用 `decodeEnvelope`（`events.ts:157`），再读 `type` 和 `task_id`，滤掉已取消的 offer（`events.ts:162-171`）。
- dead-letter 重放也调用 `decodeEnvelope`（§2.3）。

所以 payload schema 必须先认识 `sealed` 对象（§8.3）。否则加密行在投递时就会被拒绝。

`@byok-sdk/cloud-do` 不在托管 wire 上。它是 Durable Object 里的会话宿主（`packages/cloud-do/README.md:3-5`），用平台密钥自己运行模型（`packages/cloud-do/README.md:104-105`）。它把输入文本和结果文本存进 DO 的 SQLite（`packages/cloud-do/src/cloud-state.ts:164-166`、`:274-276`、`:410-414`）。它必须读明文，所以不能处理加密 task（§6.2）。tenant erasure 的表清单也不含 DO 存储（`packages/cloud-dataplane/src/tenant-erasure.ts:25-59`）。

### 2.1 已有的加密与身份

| 事实 | 位置 | 对本设计的意义 |
| --- | --- | --- |
| 唯一的密封是 provider secret。套件固定为 HPKE base mode `DHKEM(P-256, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM`，只用 WebCrypto | `packages/core/src/hpke.ts`；`packages/core/src/sealed-provider-secret.ts:39-42` | 复用这套 HPKE 包装 scope key。info 换成新常量 |
| 设备的 P-256 sealing key 存在 OS credential store，绑定 enrollment，有 epoch | `packages/keys/src/device-sealing-key.ts` | 设备 KEM 密钥沿用同一托管方式 |
| sealing key 用 device proof 登记，operation 为 `provider-secret-sealing-key.register` | `packages/protocol/src/provider-provisioning.ts:37` | 成员密钥用同样方式绑定设备行 |
| 设备身份是 Ed25519，签 nonce、device proof 和 device assertion。proof key epoch 固定为 0，没有轮换 | `packages/client/src/daemon/device-keys.ts`；`packages/cloud/src/auth/plane.ts:32` | 本设计不依赖轮换 Ed25519 身份。重新配对即新成员 |
| Host 用 WebCrypto 验证 device proof | `packages/cloud/src/auth/device-proof.ts:78`；`packages/cloud/src/crypto/web-crypto.ts:87` | Workers 侧已有 Ed25519 验签 |
| SDK 只有 `device` 与 `control-plane` 两种 principal，没有用户客户端。浏览器经 Host BFF 访问 | `packages/core/src/principals.ts` | 客户端身份要新增，由 Host BFF 转交 |
| 配对码由 SaaS 签发，单次使用，约 10 分钟有效 | [protocol §6.1](../protocol.md)；[security](../security.md) | Host 知道配对码，所以配对码本身不能当信任锚 |
| sealed provider secret 的残余信任：Host 的前端代码和它的首个设备公钥目录 | `docs/spec.md:114-120` | 本设计要处理目录被改写的情况 |

### 2.2 托管侧保存内容的位置

| 存储 | 内容 | 哈希 | 删除方式 |
| --- | --- | --- | --- |
| `device_request_receipts` 的 `task-offer:` | 完整 offer payload，含 `instruction` 和其中的 ContextPack（`packages/cloud/src/cloud.ts:1187-1195`） | 无 | 永不过期 |
| `device_request_receipts` 的 `task:<id>:terminal` | 完整终态 envelope：`summary`、`finalMessage`、`document`（`packages/cloud/src/inbound.ts:866-874`） | 无 | 永不过期 |
| `device_request_receipts` 的 `agent-input-preparation-request:` 与 `agent-home-projection-request:` | 准备上下文（inline 最多 64 KiB）；home projection 值 | 无 | 永不过期 |
| `outbox.body`（`deploy/sql/0002_core_domain.sql:100`） | 每个下发的 envelope | `body_hash` 是明文 envelope 的 SHA-256 | 已 ack 的 24 小时后删。未 ack 的 7 天后标 `expired`，正文保留到运维调用 `discardDeadLetter`（`packages/cloud-dataplane/src/cleanup.ts:251-255`）或 tenant erasure |
| `agent_message_admission.payload_body`、`terminal_body`（`deploy/sql/0017_agent_message_admission.sql`） | Agent 消息正文，两列各存一次 | JSON 内的 `contentHash` 是正文的明文 SHA-256（`packages/client/src/daemon/agent-message-outbox.ts:58`） | 只随 tenant erasure 删除 |
| `agent_message_draft.text` | 流式草稿。服务端按 UTF-8 偏移拼接（`packages/cloud-dataplane/src/stores/agent-message-draft.ts:26`） | 无 | 终态时删除；TTL 10 分钟 |
| `agent_egress_event.payload_json` | 可靠 egress 项，每项最多 256 KiB | 明文 JSON 的 SHA-256（`packages/client/src/daemon/agent-egress-spool.ts:94-107`） | 只随 tenant erasure 删除 |
| `activity_tail.entries`；`approval_timeline_tail.entries` | 工具输入输出、进度文本；审批摘要 | 无 | activity TTL 10 分钟；审批由维护步骤删除 |
| `attested_record.body_inline` | truth 记录：`task.terminal`、`profile`、`memory` | `content_hash` 是明文 SHA-256，服务端复算 | 只随 tenant erasure 删除 |
| `agent_memory_projection_head.redacted_snapshot` | 脱敏记忆快照，最多 512 KiB | `redacted_hash` 是明文 SHA-256，服务端复算 | 按 Agent 擦除，留下无正文的 epoch fence |
| R2 `tenants/<tenant>/objects/sha256/<hex>`（`packages/core/src/blob.ts:110`） | 大 instruction、artifact、大准备上下文 | key 就是明文 SHA-256，由设备计算（`packages/client/src/daemon/blob-client.ts:100`）。租户内去重 | 无引用的对象在维护中删除 |
| `task.terminal_cause`；`task.cancel_reason` | 从 `reason` 复制的自由文本；Host 写的取消原因 | 无 | 只随 tenant erasure 删除 |

表中的定时删除都要 Host 调用 `runMaintenance` 才会发生。

`packages/cloud/src/receipt-retention.ts:4-21` 把全部 11 个 receipt 前缀归为 identity。`REQUEST_RECEIPT_PREFIXES` 因此为空。`collectExpired` 在第 48 行直接返回，不删任何行（`packages/cloud-dataplane/src/stores/receipts.ts:45-61`）。

task receipt、task 行、`agent_message_admission` 行和 `agent_egress_event` 行只有 tenant erasure 能删除。admission 行随 task 行级联删除（`deploy/sql/0017_agent_message_admission.sql:20-22`）。tenant erasure 只能在 Node 上运行：`packages/cloud-dataplane/src/tenant-erasure.ts:9` 引入 `node:crypto`，`runtime.ts` 不导出它。它也不处理 Durable Object 存储。

其他删除路径都很窄：

- `revokeDevice` 删除设备行和 presence、nonce、inbound dedup、assertion replay 状态。它有意不删 task、`agent_egress_event`、outbox 和 `device_stream`（`packages/cloud-dataplane/src/stores/devices.ts:71-99`）。
- `discardDeadLetter` 由运维调用，一次删除一条 `expired` outbox 行。它只从包根导出，`runtime.ts` 不导出它。
- `eraseAgentMemoryProjection` 擦除一个 Agent 的记忆投影（`packages/cloud/src/cloud.ts:1782`）。
- 重新签发配对码时，旧的配对完成 receipt 被删除（`packages/cloud-dataplane/src/stores/pairing-codes.ts:145-152`）。

### 2.3 依赖内容的云端逻辑

- `decodeEnvelope` 按类型做完整 payload 校验。投递、终态读取和 dead-letter 重放都调用它（`packages/cloud-dataplane/src/cleanup.ts:533-563`）。
- 幂等比较是 `JSON.stringify` 之后的字符串相等。主要位置：offer receipt（`cloud.ts:1187-1201`）；投递后复核（`cloud.ts:1233`）；Agent 消息 admission（`inbound.ts:262-301`）；终态 disposition（`inbound.ts:337-357`）；egress（`inbound.ts:368-382`）；activity 与审批的重复批次；输入准备请求。
- 大小上限按明文计：inline instruction 64 KiB；Agent 消息 256 KiB；result document 1 MiB；egress 256 KiB；记忆快照 512 KiB；activity 批次 64 KiB；审批摘要 16 KiB；`POST /byok/messages` 2 MiB（`packages/cloud/src/handlers/messages.ts:87`）。
- `agentMessage.consume` 收到含 `body` 的完整 payload（`cloud.ts:303-311`；`inbound.ts:287`）。
- observer 的 `onInboundCommitted` 收到完整 envelope（`inbound.ts:167-172`）。
- `readTaskOffer`、`readTaskResult`、`readDeviceTerminal`、`readTaskAgentMessage`、`readActivity` 等读接口返回明文内容。

### 2.4 AiphaBee 现在的研究任务路径

- 浏览器为每个任务生成 P-256 临时密钥。设备持有 relay 私钥。双方做 ECDH，经 HKDF 派生 AES-256-GCM frame key（AiphaBee `packages/local-execution-protocol/src/index.ts:2276-2330`）。
- 浏览器从产品 Worker 返回的 `LocalDeviceSummary.device_public_jwk` 取得设备公钥（AiphaBee `apps/web/src/lib/api/localExecution.ts:1304`、`:1337`）。
- 浏览器另有一个 loopback 身份检查（AiphaBee `apps/web/src/lib/localAgentIdentity.ts:224`）。它只经 `127.0.0.1` 或 `localhost` 访问 Local Agent，所以只在浏览器和 Local Agent 位于同一台电脑时才能发现公钥被换。AiphaBee 的复核确认它不挡研究任务的加密路径。
- relay 只转发密文，不落库。设备公钥来自 Worker，所以 Worker 可以替换它。这条 relay 不满足 #654 需求 1。

## 3. P2：一条研究任务路径上的明文落点

以 H 拓扑下的一个研究任务为例。顺序与双车道方案 §3 相同。

| 步骤 | 今天的明文落点 | 加密后 |
| --- | --- | --- |
| 1. 浏览器把任务交给产品后端 | 产品后端与它的日志 | 产品后端先给出稳定 taskId、目标设备、agentRef、scope 和策略。浏览器之后只交密文 |
| 2. 产品后端调用 `submitAgentExecution` | `task-offer:` receipt；`outbox.body`；大 instruction 进 R2 | 两处存同一份密文。Host 原样保存，不重新封装 |
| 3. 设备 long-poll 收到 offer | 设备本机 journal | 设备取 key package，解密，校验 MAC 与内层 schema，再 claim |
| 4. 设备上报进度与审批 | `activity_tail`；`approval_timeline_tail` | 每个批次一份密文 |
| 5. 设备上报终态 | `task:<id>:terminal` receipt；`task.terminal_cause`；truth `task.terminal` | 终态正文是密文。`reason` 只留封闭代码 |
| 6. 产品后端读取结果 | `readTaskResult` 返回明文 | 返回状态和密文。浏览器解密 |

`enqueueTaskEnvelope` 在 `cloud.ts:1135`、`:1214` 和 `:1233` 三次调用 `buildEnvelope`，并比较结果。所以封装必须在调用 SDK 之前完成，密文作为输入数据原样传入。若在这条路径里生成 nonce，每次重试都会冲突。

## 4. P3：必须保留的不变量

1. identity receipt 继续是防重放的 fence。同一 taskId 的不同内容仍返回 `coordination_input_invalid`。
2. 第一份事实不被覆写。重复投递仍按元数据去重。
3. Host 不持有任何私钥或 scope key。Host 不封装，也不解密。
4. 一套字节规则。封装格式、AAD、MAC 和签名输入都在 `@byok-sdk/core`，只用 WebCrypto。浏览器和 daemon 用同一份代码。
5. SDK 不新增 Conversation 或 Room 存储（[ADR-038](../architecture/adr-2026-10-13-bot-platform.md) 决策 8）。scope 是 Host 给的不透明标签。
6. 一项事实一个权威（[ADR-027/028](../architecture/adr-2026-09-03-domain-model-and-authority.md)）。成员链是成员公钥的唯一来源。设备行仍是 SDK 认证的权威。
7. 旧接收方不能悄悄丢掉加密内容。每项新增都走 freeze rule 的 gated 路径。
8. 设备仍是执行权威。加密不改变 Host 能下发什么任务（[security](../security.md) 线路表的「Malicious or compromised SaaS」一行）。

## 5. 参与方与威胁模型（任务 1）

### 5.1 参与方

| 参与方 | 包含 | 持有的密钥 |
| --- | --- | --- |
| 设备 | daemon、本机 runtime、OS credential store | Ed25519 设备身份；成员签名密钥；成员 KEM 密钥；所属 scope 的 scope key |
| 用户客户端 | 浏览器页面；嵌入 `ui-runtime` 的宿主应用；移动应用 | 成员签名密钥；成员 KEM 密钥；所属 scope 的 scope key |
| Host 云端 | `createByokCloud`、`cloud-dataplane`、Postgres（含 Hyperdrive）、R2、Durable Object、日志、备份、运维人员 | 没有内容密钥。持有 JWT 签名密钥、公钥目录和密文 |
| 产品后端 | 调用 SDK 的产品代码；`agentMessage.consume`；产品自己的数据库（例如 `BotConversationDO`） | 没有内容密钥。AiphaBee 的产品后端与 Host 云端是同一运营方、同一个 Worker |
| 用户的其他客户端 | 同一用户的其他浏览器和设备 | 被成员链接纳并收到 key package 之后才有密钥 |

### 5.2 攻击者能力

| 位置 | 能 | 不能 |
| --- | --- | --- |
| 被动 Host：读库、读备份、读日志 | 看到元数据、长度区间、keyed MAC 和时间 | 读加密类别的内容；用猜测确认内容（MAC 带密钥） |
| 主动 Host：改库、改目录、重放、扣留 | 下发任意新任务；扣留或重排消息；扣留成员链的新条目；登记假设备行 | 伪造成员链签名；替换已固定的成员公钥；让假设备拿到 scope key；把密文搬到另一个 scope 或 task；把含用户 C1 密文的 task 降为明文 |
| Host 下发恶意前端代码 | 在用户输入时取走明文和配对验证秘密 | 本设计不防这一项（§5.4） |
| 被撤销的设备或客户端 | 继续读它已有的明文和旧 epoch 的密文 | 读撤销后新 epoch 的内容 |
| 被攻破的设备 | 读它所在 scope 的全部内容 | 本设计不防这一项 |

### 5.3 谁能解密每一类

| 类别 | scope 内的设备 | scope 内的客户端 | Host 云端 | 产品后端 |
| --- | --- | --- | --- | --- |
| C1 任务输入（开启） | 能 | 能 | 不能 | 不能 |
| C2 Agent 消息（开启） | 能 | 能 | 不能 | 不能 |
| C3 结果与过程（开启） | 能 | 能 | 不能 | 不能 |
| C4 记忆投影（开启） | 能 | 能 | 不能 | 不能 |
| 未开启的类别 | 能 | 经产品后端能 | 能 | 能 |
| 明文路由元数据（§8.5） | 能 | 能 | 能 | 能 |

同一 scope 的成员共享 scope key，所以都能解密。AAD 绑定目标设备（§8.2）。别的成员设备能读一份 offer，但会拒绝执行它。

### 5.4 接受的泄露与残余风险

- 元数据：tenant、设备、scope、Agent、task、消息 id、时间、频率、填充后的长度、token 用量和 keyed MAC。MAC 只让 Host 看出同一身份（例如同一 taskId）的两次提交是否相同（§9.1）。
- Host 下发的前端代码。浏览器客户端的代码来自 Host。恶意前端可以在输入时取走明文，也可以跳过检查。这与 `docs/spec.md:114-120` 对 sealed provider secret 的说明一致。只有代码来源固定的客户端（原生应用、签名发布的 `ui-runtime` 宿主）能防这一项。
- 主动 Host 可以扣留成员链的 `remove` 条目，让某个发送方继续用旧 epoch。§7.6 能检测这种情况，但不能阻止。
- 撤销不能收回已导出的明文，也不能清除离线设备上的密钥。
- 浏览器成员会丢失密钥。Safari ITP 会删除 7 天没有用户交互的站点的 IndexedDB（按 Safari 的使用天数计）。用户清除站点数据也会删除密钥。这时由仍持有 scope key 的成员重新批准浏览器，按 scope 恢复（§7.8），代价是一次重新批准。scope 按设备划分，所以没有存活的客户端时，一台设备只能恢复它自己的 scope。一个 scope 只有在它的全部成员都丢失密钥时，才会丢数据（§14 D13）。
- Host 仍能下发任意任务，让设备读取本机数据后以明文回传。加密保护内容的存储与转发，不缩小执行权限。

## 6. 数据类别与 wire 字段（任务 2）

### 6.1 类别

| 类别 | 被加密的 wire 字段 | 今天落在 |
| --- | --- | --- |
| C1 `task-input` 任务输入 | `task.offer*` 的 `instruction`（字符串，或 `instruction.blobRef` 指向的 blob 字节），包括其中的 ContextPack（K8 用 `ContextPack:` 分节，`examples/bot-collaboration/src/delegation.ts:36-38`）；`agent.input.preparation` 的 `context`；`task.steer` 的 `text` | `task-offer:` 与 `agent-input-preparation-request:` receipt；`outbox.body`；R2 |
| C2 `agent-message` Agent 消息 | `agent.message.publish` 的 `body`；`agent.egress.reliable` 的 `payload` | `agent_message_admission`；`agent_egress_event` |
| C3 `task-output` 结果与过程 | `task.complete` 的 `summary`、`finalMessage`、`document` 和 artifact blob；`task.artifact` 的 `inline` 和 blob；`task.progress` 的 `events`；`task.await_approval` 的 `summary`；`task.fail`、`task.decline`、`task.cancelled` 的自由文本原因；truth `task.terminal` 正文 | `task:<id>:terminal` receipt；`activity_tail`；`approval_timeline_tail`；`attested_record`；`task.terminal_cause`；R2 |
| C4 `memory-projection` 记忆投影 | 记忆投影的 `snapshot.redactedBytes`；truth `memory` 正文 | `agent_memory_projection_head`；`attested_record` |

v1 保持明文的 Host 内容：`agent.home.projection` 的 persona 值、`agent.content.read` 的路径、skill pack、board 标题、`cancel_reason` 和记忆 intent 通知。这些内容由产品写出，对 Host 加密没有作用。

`agent.message.draft` 不属于 C2。加密任务在 v1 不允许草稿（§10.4）。

v1 的范围（§14 D17）：只交付 C1 和 C3，C2 按需开启。下面三项等到 v2：

- C4 记忆投影。AiphaBee 的首批配置让 Bot 记忆保持明文（D3）。
- `agent.input.preparation` 的 `context`。输入准备的回执带多个对内容计算的摘要（§9.3），要先改 Pi 的准备协议。v1 中，Host 不为带 `sealing` 的 task 发起输入准备。设备收到带 `sealing` 的 prepared offer 时也拒绝。
- 草稿（§10.4）。

### 6.2 开启粒度与作者规则

- 作者规则：一个类别要对 Host 加密，它的作者必须是成员端点。研究任务的输入由浏览器写出，C1 可以加密。产品后端用可读 history 组装的 ContextPack 由 Host 写出，加密后只得到存储层保护，得不到端到端保护。
- 一个 offer 可以同时带两种作者的内容。成员写的部分进 C1。Host 组装的部分放进一个明文字段，只有存储层保护。设备按固定规则把两部分拼成交给 Agent 的 instruction。例如 AiphaBee 聊天里触发的研究：用户输入的问题进 C1；对话来自 `BotConversationDO`，由 Host 组装（AiphaBee `apps/local-agent/src/local-bot-chat-research.ts:63`）。划分表为这个明文字段单列一项（§8.3）。
- 读者规则：产品后端要读的内容不能加密。Bot 对话的回复要写进产品的对话存储，所以 Bot 对话的 C2 保持明文。
- 策略按 task 冻结。offer 带一个明文字段 `sealing`：`{ scopeId, epoch, categories }`。task 创建后它不再变化。这个 task 的每个 envelope 都按它处理。`epoch` 是 offer 里 C1 密文用的 epoch。之后的 envelope 用发送方封装时的当前 epoch，不低于它（§7.5、§13.5）。
- 降级保护：C1 密文的 AAD 包含 `categories`（§8.2）。Host 不能保留用户的 C1 密文，同时把 C3 改成明文。offer 的 `sealing.categories` 与 AAD 不一致时 AEAD 校验失败，设备以 `sealed_open_failed` 做非重试 decline。`sealing` 的 scope 或 epoch 与密文头不符，或类别里没有密文的类别时，设备以 `sealing_policy_mismatch` 做非重试 decline。
- 每个 scope 有一条成员签名的 `scope-policy`（§7.4）。设备拒绝策略低于它的 task。
- `cloud-do` 托管执行器必须读明文。Host 不能把带 `sealing` 的 task 交给它。这是产品的义务：`cloud-do` 与托管 wire 没有连接点（§2.0），SDK 无法替产品检查。
- AiphaBee 的建议配置：研究 scope 开启 C1 和 C3；研究任务发 Agent 消息时再开 C2；Bot 对话和 Bot 记忆保持明文。由 owner 确认（§14 D1、D3）。

### 6.3 Host 发起的 routine 任务

- K4 的 routine 由 Host 调度。每个 occurrence 的每次执行都是新的 SDK task，taskId 由 K4 core 分配（`docs/host-execution-core.md:13-19`、`:64`）。在 H 里，调度在 Host 服务上运行（`docs/host-execution-core.md:25`）。occurrence 发生时不一定有成员在线。AAD 和 MAC 都绑定 taskId（§8.2、§9.1），所以成员事先封装的 C1 不能在下一个 occurrence 上复用。
- 决定：成员封装一份 routine 模板（§14 D15）。模板只含成员写的 routine 输入，例如 AiphaBee 复核提到的 S10 watchlist routine。K8 示例（#953）在 #925 加上明文 Host 字段之前，把 K8 Turn frame 一起封进模板，所以 sealed Turn 没有 ContextPack；#925 之后 frame 改放明文字段。
- 模板身份是 `routineId` 加 `definitionVersion`，与 K4 occurrence key 用同一对值（`docs/host-execution-core.md:176`）。消息族为 `routine.template`。模板的 AAD 和 MAC 用这个身份代替 taskId，不带目标 `deviceId`。AAD 另外绑定 `agentRef`、成员设定的到期时间 `notAfter`，以及成员为这个 routine 选的类别 `categories`。
- Host 把模板密文与 routine 定义存在一起。每次执行的 offer 把模板原样放在 `sealed` 成员里，再加一个明文的 `routineRef: { routineId, definitionVersion, notAfter }`。AAD 绑定 `notAfter`，设备要用它重建 AAD，所以它以明文传输。`definitionVersion` 是整数，`notAfter` 是 core 绑定的规范 UTC 时刻。只有 `task.offer_for_agent_with_egress_fresh_sealed` 带 `routineRef`，而且这个 offer 必须加密 `task-input`。offer 的 `sealing.epoch` 取模板的 epoch。Host 组装的内容按 §6.2 放在明文字段里。
- 设备校验：消息族是 `routine.template`；AAD 身份等于 `routineRef`；`agentRef` 相同；offer 的 `sealing.categories` 等于模板的 `categories`，否则 AEAD 校验失败，返回 `sealed_open_failed`（与 §6.2 的降级保护相同）；没有过 `notAfter`，否则返回 `sealing_policy_mismatch`，Host 不检查这一项；解密后 MAC 相符。任何一项不符，设备做非重试 decline。
- 幂等不变：offer 仍以 taskId 为身份。比较投影带 `routineRef` 和模板的 `contentMac`。同一 taskId 换了模板，返回 `coordination_input_invalid`。
- 成员修改 routine 时封装新版本的模板。用户在线时，成员客户端在 `notAfter` 之前续封。续封按当前 epoch 重新封装。
- scope 的 `scope-policy` 提高类别之后（§6.2），之前封装的模板类别比它少，设备拒绝这份模板，直到成员按新类别续封。
- 模板的 epoch 或链头比设备看到的旧时，设备在 `notAfter` 之前照常接受。§7.3 的「发送方视图过期」标记对模板只作提示。§7.8 的恢复和成员移除都会推进链头和 epoch，所以这种情况常见。
- Host 仍决定执行的时间和次数，也能在 `notAfter` 之前继续用已被替换的旧版本。它不能改模板内容，也不能把模板用到另一个 routine、Agent 或 scope。Host 本来就能下发任意任务（§5.4），所以多执行几次不增加它能读到的内容。
- 模板交付之前，routine 任务只封装 C3，输入对 Host 可读。

## 7. 密钥层级与托管（任务 3）

### 7.1 层级

| 层级 | 密钥 | 算法 | 生成方 | 保存位置 |
| --- | --- | --- | --- | --- |
| tenant | 成员链：成员公钥和撤销记录的签名日志。没有 tenant 级对称密钥 | ECDSA P-256 签名；SHA-256 链接 | 成员 | Host 保存，成员各自验证 |
| scope | scope key `SK(scope, e)`：32 字节随机数，按 epoch `e` 轮换 | 用 HKDF-SHA-256 派生内容密钥和 MAC 密钥 | 一个成员 | 成员本地缓存。Host 只存包装后的 key package |
| 设备 | Ed25519 设备身份（已有）；成员签名密钥；成员 KEM 密钥 | Ed25519；ECDSA P-256；P-256 ECDH | 设备 | OS credential store。KEM 密钥和 provider sealing key 分开存 |
| 客户端 | 成员签名密钥；成员 KEM 密钥 | ECDSA P-256；P-256 ECDH | 客户端 | 浏览器 IndexedDB 里不可导出的 `CryptoKey`，或平台密钥库 |
| 单条内容 | 内容密钥 | HKDF(SK, salt)，再用 AES-256-GCM | 发送方 | 不保存 |

不设 tenant 级对称密钥。原因：那样任何成员都能读全部 scope；撤销一个成员就要为全部 scope 换钥。scope key 把影响限制在一个 scope 内。

### 7.2 信任锚：配对验证秘密

配对码由 Host 签发，Host 知道它。device proof 在 Host 上验证，挡不住 Host 在 enrollment 时换钥。所以信任锚必须是 Host 不知道的值：

1. 客户端显示配对码时，同时生成 128 位随机数 `pv`。显示内容为 `<配对码>.<pv 的 base32>`，或一个二维码。`pv` 不发给 Host。
2. 用户把整串内容交给设备。daemon 只把配对码发给 `/byok/pair`，自己保留 `pv`。
3. 设备登记自己的成员公钥包，并经 Host 转交 `HMAC(pv, 设备成员包 || tenantId || deviceId)`。
4. 客户端验证这个 MAC，签署成员链条目 `add(设备)`，再经 Host 转交 `HMAC(pv, 客户端成员包 || 链头)`。
5. 设备验证 MAC，固定这个客户端的签名公钥。双方删除 `pv`。

Host 没有 `pv`，所以不能替换任何一方的公钥。128 位秘密不能离线穷举。缺点是字符串长，需要二维码或复制粘贴。备选方案是双方各显示 6 位短码，由用户比对（§14 D2）。

配对只用 install-session 流程，方向只有客户端到设备（#655 D-I3）。开启入口在网页上：网页建 install-session 并生成 `pv`，用户把 `<配对码>.<pv>` 交给设备。不做 device-code 方向（设备显示码，用户在浏览器批准），所以 E2 只实现上面这一个方向。只有用户开启云端调度的设备才走这一步（§12.1）。

之后加入的客户端由已有成员批准。用户在已有客户端上比对新客户端显示的指纹，已有成员签署 `add(客户端)`。设备也可以用本机命令批准新客户端。

设备成员包同时用 device proof 登记（新 operation，例如 `e2ee-member-key.register`）。Host 用 `authenticateDeviceProof` 把成员包绑定到设备行。#654 需求 1 的「公钥由 device proof 绑定」由这一层满足。「客户端一侧也要有签名」由成员链签名满足。

AiphaBee 自研的配对和 device grant，在 SDK 里对应 `/byok/pair` 和 `/byok/token`（`packages/cloud/src/cloud.ts:863-873`）。它们发出设备凭据。凭据只认证请求，不是信任锚。成员公钥的信任来自 `pv` 和成员链。

### 7.3 成员链

- 条目：`{ v: 1, tenantId, seq, prev, op, subject, signer, sig }`。`op` 取 `add`、`remove`、`rotate`、`scope-policy` 或 `shred`。
- 签名输入是前缀 `byok-member-chain-v1\n` 加 core 的 canonical JSON。条目哈希是签名输入的 SHA-256。
- Host 按 `(tenantId, seq)` 先写者胜保存条目。同一 seq 的不同条目被拒绝。
- 成员从自己固定的锚点开始验证整条链。签名错误、`prev` 断开或签名者已被移除的条目无效。
- `add` 和 `remove` 改变 tenant 的成员集合。一个 scope 的成员只由这个 scope 最新的 `scope-policy` 条目定义。成员只为 scope 策略里列出的成员生成 key package。
- 加密内容的 AAD 带发送方看到的链头（§8.2）。接收方知道更新的链头时，把这份内容标为「发送方视图过期」。

### 7.4 scope key 与 key package

- scope 由 Host 命名，例如对话 id、Bot id 或研究工作区。SDK 不解释它。
- 按 #655 D-I4，Host 按设备划分 scope：一个 scope 只含一台设备和这个用户的客户端。只有目标设备和用户的客户端能解密，与今天 relay 的性质相同。代价：每个 epoch 的 key package 总数是「设备数 ×（1 + 客户端数）」；按用户划分时是「设备数 + 客户端数」。新设备只得到自己的 scope（§7.9）。浏览器丢失密钥后按 scope 恢复（§7.8）。
- 新建 scope：一个成员生成 `SK(scope, 1)`，签署 `scope-policy` 条目（scopeId、类别、成员列表），再为每个成员生成一个 key package。
- key package：`{ v: 1, tenantId, scopeId, epoch, keyId, recipient, sender, enc, ciphertext, sig }`。用 core 现有的 HPKE 套件封装到接收方的 KEM 公钥。info 为 `byok-sdk.scope-key.v1`。AAD 为其余字段的 canonical JSON。HPKE base mode 不认证发送方，所以再加发送方签名。
- `keyId` 是 `HMAC(SK, "byok-scope-key-id-v1")` 的截断值。它承诺了密钥，但 Host 不能由它推出密钥。
- 设备按 notice-and-fetch 取 key package。mailbox 只放 `{ scopeId, epoch }`，正文从设备认证的路由取。原因与 [protocol §2.3](../protocol.md) 相同：mailbox 行和 journal 行会长期保留。
- 设备只在内存里缓存解开的 scope key。重启后重新取 key package，用 KEM 私钥解开。
- 客户端经 Host BFF 读取成员链和 key package。Host BFF 调用 SDK 的 control-plane 接口。

### 7.5 轮换

- scope epoch 在以下情况前进：成员被移除；scope 成员减少；达到 owner 定的周期或条数上限；怀疑泄露。
- 由下一个发送方轮换。成员在封装前检查链。当前 epoch 包含已移除成员时，它先建 `e+1`，只为剩余成员生成 key package，然后封装。没有成员在线时，没有新内容产生。
- 成员 KEM 密钥轮换：成员登记新公钥（`rotate` 条目），把自己持有的 scope key 重新包装到新公钥，再删除旧私钥。旧 key package 随之打不开。
- 重新包装只处理发送方仍是 scope 策略成员的 key package，发送方换成这台设备。发送方已被移除的 package 保持原样，不带设备的签名（E2d-5）。因此轮换之后，原发送方再被 `remove`，设备缓存的这个 epoch 的 key 不再因此失效。owner 接受这一点：被移除的成员本来就持有这个 epoch 的 key。之后的内容用新 epoch 隔开，`remove` 之后下一个发送方会先轮换 scope epoch（E2d-4）。
- E5b-2（owner batch §77a）：key package 升到 v2，签名字段带收件人的 `recipientKemEpoch`。Host 在追加 `rotate` 时把这个成员的 KEM 下限提到它的 `kemEpoch`，之后拒收包装到更旧 KEM epoch 的包（409 `e2ee_scope_key_package_stale`）。设备按页读自己在一个 scope 的全部包（每页 16 个，最多 4096 个），读 scope 的最新 epoch 决定下一个 epoch。重新包装之后，最后一遍对重新包装过的 scope 只核对持有的和有 freshness 点的 epoch 还在。
- Ed25519 设备身份不轮换（`plane.ts:32` 固定 epoch 0）。重新配对得到新 deviceId，在链上是新成员。旧成员要显式 `remove`。

### 7.6 撤销设备与客户端

撤销设备的顺序：

1. 产品调用 `revokeDevice`。设备行被删除，之后的认证请求返回 401（[protocol §6.3](../protocol.md)）。
2. 一个成员签署 `remove(设备)`，通常是用户的客户端。
3. 该设备所在的每个 scope，在下一次封装前轮换到新 epoch。
4. Host 删除该设备的 key package。这一步只做清理。安全依靠第 3 步的轮换。

效果：

- 被撤销的设备读不到新 epoch 的内容。
- 它仍能读已有的明文和旧 epoch 的密文。它离线时，没有办法清除它的密钥。
- 主动 Host 可以扣留 `remove` 条目，让一个发送方继续用旧 epoch，再把密文交给被撤销的设备。签署 `remove` 的成员能从后续内容 AAD 里的链头和 epoch 看出这种情况，并提示用户。

撤销客户端走同一流程。

带 `machineId` 的重新配对会让 Host 删除旧设备行（[protocol §6.1](../protocol.md)）。Host 不能代签 `remove`，所以产品要提示一个成员补签。

### 7.7 Workers 与只有 WebCrypto 的限制

- Host 侧代码不持有密钥。它只保存密文、比较元数据与 MAC、对密文做 SHA-256。Ed25519 device proof 验证已经走 WebCrypto（`web-crypto.ts:87`）。
- 端点加密代码放在 `@byok-sdk/core`。core 禁止 `node:` 导入（`packages/core/src/__tests__/constraints.test.ts`）。浏览器、Workers、Node 和 Bun 因此共用一份字节规则。
- 只用 WebCrypto 普遍支持的原语：P-256 ECDH、P-256 ECDSA、HKDF-SHA-256、HMAC-SHA-256、AES-GCM、SHA-256 和 `getRandomValues`。客户端不用 Ed25519 和 X25519。spec 写明浏览器上 Ed25519 的端到端矩阵尚未覆盖（`docs/spec.md:137`）。
- 设备另有 ECDSA 成员签名密钥。客户端因此不需要验证设备的 Ed25519 签名。Ed25519 只在 Host 上用于 device proof。
- 浏览器私钥是 IndexedDB 里不可导出的 `CryptoKey`。设备把私钥 JWK 存进 OS credential store，使用时以不可导出方式导入，与 `device-sealing-key.ts` 相同。
- Workers 上不做解密，也不做 HPKE。CPU 开销只有哈希。

### 7.8 客户端丢失密钥

- 浏览器客户端的成员密钥在 IndexedDB 里。Safari ITP 和用户清除站点数据都会删除它（§5.4）。在 Safari 上这会经常发生。
- 恢复流程与 §7.2 中批准新加入客户端的流程相同：
  1. 浏览器生成新的成员密钥，并显示指纹。
  2. 用户在设备上用本机命令，或在另一个仍有密钥的客户端上，比对指纹并批准。批准方签署 `add(新客户端)` 和 `remove(旧客户端)`。
  3. scope 的成员由各自的 `scope-policy` 定义（§7.4），链上的 `add` 不改变它。所以批准方为它持有的每个 scope 签署 `scope-policy` 更新：加入新客户端，移除旧客户端。
  4. 批准方只为这些 scope 生成新的 key package，覆盖浏览器需要的每个 epoch。设备能为它自己的 scope 做这一步：它保留自己的 key package（§14 D5），能解出旧 epoch 的 scope key。
  5. `remove` 让每个相关 scope 在下一次封装前轮换 epoch（§7.5）。旧密钥可能被备份过，所以按移除处理。
- 恢复按 scope 进行。scope 按设备划分（§7.4），所以批准方的范围不同：
  - 另一个仍有密钥的客户端是每个设备 scope 的成员。它批准时，能为全部 scope 重发 key package。
  - 没有存活的客户端时，批准的设备只能恢复它自己的 scope。其他设备的 scope 要经拥有它的设备恢复：每台设备在线时，从已验证的链上看到 `add(新客户端)`。它先为自己的 scope 签署 `scope-policy` 更新，加入新客户端、移除旧客户端，再为这个 scope 重发 key package（fan-out）。没有这条 `scope-policy` 更新，就不重发：只看链上的 `add` 会把 scope key 交给 scope 策略之外的成员。设备签署这条更新之前要不要本机批准，待定（§14.1 问题 8）。定下之前，只承诺批准设备自己的 scope 能恢复。
  - 离线设备的 scope 要等这台设备上线后才能恢复。
- 代价是一次重新批准，并且每个要恢复的 scope 都要有一个持有它的成员在线。浏览器里还没确认的待提交密文也会丢失。产品用新的 taskId 重新提交（§9.2）。
- 一个 scope 的全部成员（拥有它的设备和用户的客户端）都丢失密钥时，这个 scope 的数据无法恢复（§14 D13）。

### 7.9 多设备

- 一个用户可以有多台设备和多个客户端。每台设备、每个客户端都是成员链上的一个成员，各有自己的 KEM 密钥和 key package。
- 新设备加入有两种方式：用新的配对码和 `pv` 配对（§7.2）；或者由已有成员比对指纹后签署 `add(设备)`。
- 新设备加入后，只为它建它自己的 scope（§7.4）：一个成员（新设备或用户的客户端）生成 `SK(scope, 1)`，签署 `scope-policy`（成员为这台设备和用户的客户端），再为每个成员生成 key package。已有成员不把其他设备 scope 的 key package 发给新设备，当前 epoch 和旧 epoch 都不发。所以新设备读不到其他设备的 offer 和历史。
- 重新配对的设备是新成员（§7.5），所以它也只得到新的 scope。旧 scope 的内容仍由用户的客户端读取。
- 同一 scope 的成员都能解密这个 scope 的内容。AAD 绑定目标 `deviceId`（§8.2）。别的设备能读一份 offer，但会拒绝执行它。scope 按设备划分时（§7.4），别的设备不是这个 scope 的成员，读不到它的内容。
- 谁能改一个 scope（owner batch §50f A）：已有 scope 的 `scope-policy` 和 `shred` 只能由这个 scope 当前策略里的成员签署；新 scope 的第一条 `scope-policy` 只能由它的成员列表里的成员签署。其他签名者的条目在走链时无效（`member_chain_signer_invalid`）。所以一个成员不能在链上修改或 shred 一个它不在其中的 scope。这条规则不覆盖两种情况：
  - Host 收到任何形状合法的 `shred` 都删除这个 scope 的 key package，不验签名（owner batch §50g）。这一步删除仍依赖其他成员诚实。
  - 一个 scope id 归第一个建它的成员。不诚实的成员可以抢先建另一台设备要用的 scope id，并把自己列进成员列表。
- E2d 必须满足两条要求（§50f A）：
  1. 客户端为一台设备的 scope 封装内容或发 key package 之前，确认这个 scope 的当前策略恰好是这台设备加上用户的客户端。
  2. 客户端代码追加一条链条目之前，先在本地对它走链。局外签名者的 scope 变更对每个成员都无效，而链只能追加（§7.3），所以这样一条条目会让所有成员的链停在它前面。
- 冻结的 scope：一个 scope 当前策略里的成员全部被移除后，没有人能再更新或 shred 这个 scope。它的数据仍能通过 §7.6 第 4 步和 §11.3 删除。所以要先用新的 `scope-policy` 把 scope 交给别的成员，再移除它当前策略里的最后一个成员。
- 撤销一台设备只移除这一个成员。它所在的每个 scope 在下一次封装前轮换 epoch（§7.6）。其他设备第一次遇到新 epoch 时，取新的 key package。
- v1 的 scope 只含同一个用户的设备和客户端（§14 D10）。多个用户共用一个 scope 需要发送方签名，留到以后。

## 8. Wire 格式、版本与路由（任务 4）

### 8.1 封装对象

每个加密消息用一个新的 message type，例如 `task.complete_sealed`（维护者 2026-10-23 选定的形状 A）。它是明文 type 去掉被加密的字段，再加一个 `sealed` 成员。明文 type 不变。`sealed` 成员如下：

```json
{
  "v": 1,
  "suite": "byok-sealed-v1.hkdf-sha256.aes-256-gcm",
  "category": "task-input",
  "scope": { "id": "<Host 给的 scopeId>", "epoch": 3, "keyId": "<22 字符>" },
  "chainHead": { "seq": 17, "hash": "sha256:<64 hex>" },
  "sender": "<memberId>",
  "salt": "<32 字节 base64url>",
  "nonce": "<12 字节 base64url>",
  "paddedLength": 4096,
  "contentMac": "hmac-sha256:<64 hex>",
  "ciphertext": "<base64url>"
}
```

- 明文是被加密字段组成的对象的 canonical JSON，例如 `{ "instruction": "..." }`。
- 明文的数字按 RFC 8785 序列化：有限的数字按 ECMAScript `Number.prototype.toString` 写出，NaN 和 Infinity 被拒绝。小数和超过 2^53 的整数因此可以封装（#786，owner 2026-10-23 的决定）。这条规则只用于明文。AAD、MAC 里的身份、成员链条目和 key package 仍用 attestation 的 canonical JSON，只接受安全整数。
- 内容密钥为 `HKDF-SHA-256(SK, salt, "byok-sdk.sealed.v1.enc")`。每条内容用新 salt，所以每个内容密钥只用一次。
- 加密前先组帧：`frame = u32be(contentLength) || content || 0x00 × (paddedLength − 4 − contentLength)`。`content` 是明文对象的 canonical JSON 的 UTF-8 字节；blob 时是原始字节。`paddedLength` 是帧长，算法见 §8.6。
- 接收端解密后检查五项：解密得到的帧长等于 `paddedLength`；`contentLength ≤ paddedLength − 4`；`paddedLength = pad(4 + contentLength)`（§8.6）；填充字节全是 0；`contentLength` 不超过这个消息类型的明文上限。任何一项不符，按 `sealed_open_failed` 拒绝。
- 帧在 AEAD 之内，所以原长和填充都受认证。帧是规范的：同一内容只有一个合法的 `paddedLength`，同一份密文只有一种解码结果。发送方不能用 `paddedLength` 另带信息，同一内容的两次提交也不会因长度不同被判为冲突（§9.2）。
- `ciphertext` 与 `ciphertextRef` 二选一。`paddedLength` 超过 256 KiB 时用 `ciphertextRef`（§8.6）。
- 协议字段里的 blob（例如 `instruction.blobRef`、artifact）先按同一规则封装字节，再上传。blob 自己的 `salt`、`nonce` 和 `paddedLength` 与 `BlobRef` 一起放进加密的内层对象。blob 的 AAD 是外层的 AAD 加上字段路径，例如 `/instruction/blobRef`，所以 Host 不能在字段之间互换 blob。字节规则（E1c，owner 2026-10-23 的决定）：
  - blob 在外层内容之前封装。外层的 `paddedLength` 和 `contentMac` 依赖外层明文，所以 blob 的 AAD 不含它们。blob 的 AAD 是外层 AAD 的另外 16 个成员，加上 blob 自己的 `paddedLength`，再加上新成员 `fieldPath`，按同一 canonical JSON 编码。外层 AAD 一定有 `contentMac`、没有 `fieldPath`，所以两种 AAD 不会相同。
  - `fieldPath` 是 RFC 6901 JSON Pointer，根是移走字段组成的对象，指向 BlobRef 节点，例如 `/instruction/blobRef`、`/events/0/spill/blob`、`/artifactRefs/1`。每一段是字段名 `[A-Za-z][A-Za-z0-9]*` 或规范的十进制下标，所以不需要 `~` 转义。接收端按找到 BlobRef 的位置得出它。
  - blob 的明文上限是调用方参数 `maxContentLength`，由各字段的规则决定。
  - 接收端还要按 §9.3 检查 `BlobRef.contentHash` 等于密文的 SHA-256。

### 8.2 AAD

AAD 是下列字段的 canonical JSON：`v`、`suite`、`category`、`tenantId`、`scopeId`、`epoch`、`keyId`、`chainHead`、`sender`、消息族（例如 `task.offer_for_agent`）、方向、身份（`taskId`，或 `requestId`、`messageId`、`mutationId`，或 routine 模板的 `routineId` 与 `definitionVersion`）、目标 `deviceId`、`agentRef`、task 的 `sealing.categories`、routine 模板的 `notAfter`（其他消息族为 `null`）、`paddedLength` 和 `contentMac`。

AAD 不含 envelope 的 `id`、`seq` 和 `ts`。dead-letter 重放会用新 `seq` 重新编码 envelope（`cleanup.ts:533-563`）。AAD 绑定了身份字段，所以 Host 不能把密文搬到另一个 task、设备、Agent 或 scope。唯一的例外是 routine 模板：按设计，它在同一 routine 的多次执行上复用（§6.3）。

### 8.3 字段划分与接收端校验

- `packages/protocol` 新增一张划分表（`SEALED_SPLIT_TABLE`）。每个加密 type 一行：对应的明文 type、类别、身份字段、加密的字段、v1 不带的字段，以及每个摘要字段的规则。它和 `WIRE_ADDITIONS` 一样是唯一权威。
- Host 只校验 `sealed` 的外形：字段、编码、长度，`ciphertext` 与 `ciphertextRef` 恰好有一个，以及 `paddedLength` 与密文长度是否一致。`POST /byok/messages` 和 `GET /byok/events` 都按 payload schema 解析（§2.0），所以这个外形校验要进 schema 本身。
- 接收端解密后，把解密得到的字段并回 payload，再用明文 type 的现有 schema 校验。加密 type 的 schema 里没有这些字段，所以两个键集合不相交。解密得到的对象只能含划分表列出的加密字段。#654 需求 3 的「内容校验挪到接收端」由此完成。
- 接收端失败时一律拒绝，不回退明文：
  - 缺 key package：`sealed_key_unavailable`。
  - AEAD 失败、帧检查失败（§8.1），或 `ciphertextRef` 的 blob 缺失：`sealed_open_failed`。
  - MAC 不符：`sealed_content_mac_mismatch`。
  - 策略不符：`sealing_policy_mismatch`。
  - 未知 `v` 或 `suite`：在 schema 层拒绝。
- 设备侧用非重试的 decline 或 fail 上报这些错误。

### 8.4 版本与能力门

按 freeze rule 的路径 2（gated addition），两个方向都要声明：

- 门按整个 type 设，不按字段设。不认识这个 type 的解码器整条拒绝（`UnknownMessageTypeError`），不会悄悄丢掉 `sealed`。
- server → daemon：offer、steer、输入准备、key package 通知，以及回显 `contentMac` 的 Agent 消息 disposition。门是设备能力 `sealed-payload-v1`。Host 在建 task、写 receipt 和写 mailbox 之前检查它。
- daemon → server：终态、进度、artifact、审批、Agent 消息、egress 和记忆投影。门是 Host 能力 `sealed-payload-v1`，`advertisedBy: 'server'`（`packages/protocol/src/wire-additions.ts:47` 已支持）。设备必须先看到 Host 的声明。
- 加密 type 继承明文 type 的全部门，被加密或不带的字段的门除外。例如 `task.offer_for_agent_sealed` 还要 `agent-home-contract`。加密不能去掉任何门。
- 设备的四个封闭失败代码放在明文 `task.decline` 的 `code` 上，各是一个值门，由 Host 声明。

设备拿到带 `sealing` 的 task 而 Host 没有声明能力时，设备在 claim 前 decline，不发送明文。

`PROTOCOL_VERSION` 保持 3。升到 v4 整体切换是 §14 D7 的备选。

`v` 和 `suite` 是字面量，没有协商。新套件是新常量和新能力，不增加解析分支。provider secret 用的是同一规则（`sealed-provider-secret.ts:41-42`）。

### 8.5 Host 仍能读取并据以路由的字段

- 身份与传输：tenant（来自认证）、`deviceId`、`taskId`、envelope 的 `type`、`id`、`seq`、`ts`，以及 `messageId`、`requestId`、`mutationId`。
- 执行选择：`agentRef`、`sessionRef`、`runtime`、`harnessId`、`dispatchSelection`、`requiredToolsets`、`limits`。
- 策略：`egressPolicy`、`messageEgress`、`terminalProjection`、`sealing`。
- 其他：`approvalId`、`decision`、`usage`、封闭的原因代码、`sealed` 的外层字段和时间。

Host 用这些字段运行现有的 claim、所有权、能力、去重、取消和配额逻辑。加密 type 进 `SERVER_TO_DAEMON_TYPES`、`DAEMON_TO_SERVER_TYPES` 和 `inbound.ts` 的分支。每个加密 type 走它的明文 type 的同一套逻辑，只是不读被加密的字段。E3a 先拒绝所有加密的 daemon → server 消息，E3b 再接上这些分支。

这份清单比 #654 需求 2 列出的范围多。多出的执行选择和策略字段由 Host 自己写出，Host 本来就知道。`sessionRef` 是设备生成的不透明 id。`usage` 是设备上报的 token 计数，属于遥测，会透露工作量的大小（§5.4）。

### 8.6 长度上限、填充与大内容

- 发送方先按今天的上限检查明文。
- 帧长 `paddedLength = pad(n)`，其中 `n = 4 + contentLength` 是帧的原长：
  - `n ≤ 16 KiB`：向上取 256 字节的整数倍。
  - `n > 16 KiB`：用 Padmé 填充。`E = floor(log2 n)`，`S = floor(log2 E) + 1`，`mask = 2^(E − S) − 1`，`pad(n) = (n + mask) & ~mask`。在这个区间，多出的字节少于 6.25%，长度只透露 O(log log n) 位。
- 选 Padmé 的理由是开销。第一版的 2 的幂桶最多多出 100%，而填充字节计入 mailbox 配额和 blob 配额（§12.3）。
- 大内容放进 blob。`paddedLength` 不超过 256 KiB 时，密文内联在 `ciphertext` 里。超过时，发送方把密文作为 blob 上传，`sealed` 里用 `ciphertextRef`（指向密文字节的 `BlobRef`）代替 `ciphertext`。schema 强制这条规则。256 KiB 等于 Agent 消息的上限（`packages/protocol/src/agent-egress.ts:18`）。
- 第一版只允许内联密文，最大的终态会因此发不出去。`task.complete` 的 `summary` 和 `finalMessage` 没有 schema 上限（`packages/protocol/src/messages.ts:1196-1207`），`document` 最多 1 MiB（`messages.ts:962`）。base64url 让内联密文大 33%。不填充时，约 1.5 MiB 的明文就超过 `POST /byok/messages` 的 2 MiB 上限（`packages/cloud/src/handlers/messages.ts:87`）。用 2 的幂桶时，稍过 1 MiB 就超过。`ciphertextRef` 解决这个问题，与填充方式无关。
- 加密终态要有明确的明文上限。今天的明文终态受 2 MiB 请求上限约束，但 `summary` 和 `finalMessage` 本身没有上限。`ciphertextRef` 去掉了请求上限的约束，加密终态最大可以到 blob 的 100 MiB（`packages/cloud/src/cloud.ts:214`）。建议 C3 的明文上限取 2 MiB，与今天的有效上限一致。§8.1 的接收端检查用这个值。由 owner 在 D8 里确认。
- `ciphertextRef` 的规则：
  - Host 接受 envelope 时检查：blob 已经 committed，大小等于 `paddedLength + 16`。schema 看不到 blob 的大小，所以这一步由 Host 做。
  - 引用它的每一行（receipt、outbox、admission、egress、attested record）都写一条 `object_reference`。今天没有任何 task 行引用 blob：云端只在 truth 提交时写引用（`packages/cloud-dataplane/src/truth-committer.ts:596`）。没有引用的 committed 对象在 24 小时宽限后被回收（`packages/cloud-dataplane/src/stores/core/objects.ts:115-118`；`packages/cloud/src/maintenance.ts:19`）。不写引用，终态正文一天后就会消失，而指向它的 receipt 永不过期。
  - 这条引用只由 scoped row-delete（§11.3）或 tenant erasure 释放。crypto-shredding 不改行，所以不释放它。
  - 发送方的持久 outbox（§9.2）保存上传后的 `ciphertextRef`。重试复用同一个 blob，不重新封装。
  - `ciphertextRef` 不进 AAD。它的 hash 覆盖密文，绑定它会形成循环。也不需要绑定：AEAD 已把密文绑定到身份，换掉 blob 就打不开。
- Host 的上限改为对外层计算：内联时是 `base64url(paddedLength + 16)` 加外层字段的上限；用 `ciphertextRef` 时是 blob 的大小上限。
- 批次要按字节分块。daemon 今天只按条数分块，每批最多 256 个 envelope（`packages/client/src/daemon/connection-manager.ts:458`）。服务端对超过 2 MiB 的请求返回 413（`packages/cloud/src/handlers/messages.ts:154-155`）。内联密文的 base64url 之后最多约 342 KiB，约 6 个就到 2 MiB。E3 让 drain 同时按字节分块。
- Agent 消息的 `byteCount` 不再明文出现。Host 用 `paddedLength` 检查 `maxBytes` 的桶上限，精确检查由接收方做。

## 9. 密文上的幂等（任务 5）

### 9.1 keyed content MAC

```text
K_mac(scope, e) = HKDF-SHA-256(SK(scope, e), salt = empty, info = "byok-sdk.sealed.v1.mac")
contentMac      = "hmac-sha256:" + hex(HMAC-SHA-256(K_mac,
                    "byok-content-mac-v1\n" || category || "\n" || family || "\n"
                    || identity || "\n" || canonicalJson(plaintext)))
```

`identity` 是这次写入的身份：offer 用 taskId，Agent 消息用 messageId，输入准备用 requestId，记忆投影用 mutationId，routine 模板用 `routineId` 加 `definitionVersion`（§6.3）。

MAC 只依赖 scope、epoch、类别、消息族、身份和明文，与 salt 和 nonce 无关。同一内容重新加密后 MAC 不变。身份进入 MAC 后，两个不同 task 的相同内容得到不同的 MAC。Host 只能比较同一身份的两次提交。

### 9.2 比较规则

- Host 比较「比较投影」：payload 的明文字段，加上 `sealed` 的 `v`、`suite`、`category`、`scope`、`paddedLength` 和 `contentMac`。salt、nonce、密文、`ciphertextRef` 和 `sender` 不参与比较。
- 投影相同时按重复处理，保留第一份密文。Host 用 receipt 里的第一份密文物化 mailbox 行，所以 `readTaskOffer` 和设备收到同一份字节。
- 投影不同时，同一 taskId 返回 `coordination_input_invalid`，错误代码不变。其他位置沿用各自现有的冲突代码。
- 重复投递的去重只看元数据，不受影响：mailbox 的 `message_id` 由 tenant、taskId、deviceId 和 agentRef 推出（`packages/cloud/src/offer-identity.ts:13-16`）；inbound 去重按 envelope id；admission 按 `(tenant, device, message_id)` 唯一。
- 只封装一次。发送方在第一次发送前，把封装好的字节写进自己的持久 outbox，重试时发送同一份字节。daemon 已经先持久化终态再发送（双车道方案 §3 第 6 步）。浏览器要把待提交的密文存进 IndexedDB。
- 跨 epoch 的重试得到不同的 MAC，被判为冲突。这是 fail closed。重试必须用第一次的 epoch 和字节。
- 接收端解密后重新计算 MAC，与 AAD 绑定的值比较。不符时非重试拒绝。所以对每个接收方，「MAC 相同」就意味着「内容相同」。有缺陷的成员也不能给一份密文配上另一份内容的 MAC。

需要改成比较投影的位置：offer（`cloud.ts:1187-1201` 与 `:1233`）；admission（`inbound.ts:262-301` 与 `task-attempts` 的 SQL 等值条件）；disposition（`inbound.ts:337-357`）；egress（`inbound.ts:368-382`）；activity 与审批的重复批次；输入准备的 `canonicalRequestBody`。in-memory 与 SQLite store 有同样的比较，要一起修改。

### 9.3 明文哈希字段

加密类别里，如果下列字段继续保存明文 SHA-256，Host 就能用猜测确认短内容，例如「是」「否」或一个股票代码。

| 字段 | 今天 | 加密类别中的规则 |
| --- | --- | --- |
| `outbox.body_hash` | 明文 envelope 的 SHA-256 | 代码不变。envelope 里已是密文 |
| Agent 消息与 egress 的 `contentHash` | 设备算的明文 SHA-256 | 不再明文出现。disposition 回显 `contentMac` |
| `redactedHash` | 明文快照的 SHA-256，服务端复算 | 改为密文的 SHA-256。服务端照常复算 |
| `BlobRef.contentHash`、R2 key、`object_manifest.hash` | 明文 blob 的 SHA-256 | 改为密文字节的 SHA-256。租户内去重随之失效 |
| truth `content_hash` | 明文正文的 SHA-256，服务端复算 | 改为密文的 SHA-256 |
| `task.terminal_cause` | 复制自由文本 `reason` | 只存封闭代码。自由文本进密文 |
| 审批 `summary` | 明文 | 进密文。`approvalId` 和 `decision` 保留明文 |

第一版漏掉了一组字段（PR #685 的审查意见）。它们都是设备对内容算的明文 SHA-256，随回执或终态交给 Host。Host 知道周围的字段时，可以用猜测确认短内容。

| 字段 | 位置 | 摘要的对象 | 加密类别中的规则 |
| --- | --- | --- | --- |
| `artifact.requestDigest`、`artifact.envelopeDigest` | 输入准备回执（`packages/protocol/src/input-preparation.ts:546-549`、`:603`） | 编译后的 provider 请求和 transcript，含解密后的 context（`packages/client/src/adapters/pi/input-preparation.ts:329-350`） | keyed MAC |
| `binding.requestDigest` | 同一回执（`input-preparation.ts:581`） | 整个准备请求，含 inline context 或它的 blobRef（`packages/client/src/daemon/input-preparation-service.ts:1056-1061`） | keyed MAC |
| `artifact.projection.digest`；`counter.providerEvidence.projectionDigest` | 同一回执（`input-preparation.ts:523`、`:443`） | provider 请求体的投影 P(D) | keyed MAC |
| offer binding 的 `requestDigest`、`artifactDigest` | `task.offer_prepared`，Host 原样回传（`input-preparation.ts:656-662`） | 上面两个值的副本 | 跟随原值 |
| `preparedObservation.requestDigest` | `task.complete` 与 `task.fail` 的终态（`packages/protocol/src/messages.ts:1103-1105`） | 同 `artifact.requestDigest` | keyed MAC |
| 观察到的 `revision`；intent 的 `baseRevision`、`targetRevision` 和 `operationDigest` | 记忆 intent 的回执与请求（`packages/protocol/src/agent-memory-intent.ts:169-173`、`:109-113`） | 设备上记忆文件的字节；`targetRevision` 是 Host 写的正文的摘要；`operationDigest` 覆盖两个 revision（`packages/core/src/agent-memory-intent.ts:20-31`） | v2 设计 C4 时确定 |
| 输入准备 blob context 的 `contentHash` | `agent.input.preparation`（`packages/protocol/src/messages.ts:679-680`） | blob 字节，设备用它核对解码后的字节 | 密文的 SHA-256，与 blob 规则相同 |

输入准备和 C4 在 v1 不开放（§6.1），所以这几行在 v2 生效。v1 的加密 task 不会是 prepared offer，终态也不会带 `preparedObservation`。

记忆 intent 的正文由 Host 写出，按作者规则保持明文（§6.1）。但 `revision` 和 `baseRevision` 是设备上整个文件的摘要，文件里可能有设备写入的内容。v2 开启 C4 时，要一起决定这几个字段和终态里 `agentHomeMemoryChange.paths`（改动过的记忆文件路径）的处理。

规则（§14 D16）：加密类别里，每个摘要字段都归入下面四类之一。

1. 密文的 SHA-256。Host 要校验它存下的字节时用，例如 blob key、truth `content_hash` 和 `redactedHash`。
2. keyed MAC：`HMAC-SHA-256(K_mac, 域分隔串 || 身份 || 内容)`。`K_mac` 与 §9.1 相同，每个字段用自己的域分隔串。两端要比较相等时用。Host 只原样转交。
3. 移进密文。只有端点用到它时用。
4. 不由内容推出的摘要，保持明文。例如 `toolManifestDigest`、`toolBindingDigest`、`closureDigest`、`profileRevision`。

§8.3 的划分表为每个加密消息类型列出全部摘要字段和它的类别。E3 加一个 schema 测试：加密消息类型里，名字含 `digest`、`hash` 或 `revision` 的字段（不区分大小写），都必须在划分表里归入一类。

device proof 的 `bodySha256`（`packages/core/src/attestation.ts:190`）对整个 HTTP 请求体求摘要。truth 正文加密之后，它的输入已是密文，不用改。

## 10. `agentMessage.consume`（任务 6）

### 10.1 现状

`consume` 在写入前调用，决定 `accepted`、`held` 或 `refused`（`cloud.ts:303-311`；`inbound.ts:212-302`）。它收到含 `body` 的完整 payload，以及 offer 时冻结的 Host 上下文 `{ destinationBinding, freshnessCursor? }`。投递至少一次，产品按消息身份和 payload 去重。`consume` 抛错时 reservation 保持 pending，SDK 会对同一 reservation 再次调用 `consume`（`inbound.ts:269-287`）。

### 10.2 加密后的输入

- 开启 C2 的 task，`consume` 收到另一种输入。它没有 `body`，带 `sealed`、`contentMac`、`paddedLength`、`contentType`、`contract`、`messageId`、`cursor`、`agentRef`、`sessionRef` 和冻结上下文。类型上与明文输入分开，产品代码不能把密文当正文用。
- `sealed` 里是 `ciphertext` 或 `ciphertextRef`（§8.6）。接近上限的 Agent 消息填充后约 264 KiB，总是走 `ciphertextRef`。产品存密文时，要么存 `BlobRef` 并为它写引用，要么把 blob 字节复制进自己的存储。
- 产品要显式声明能处理加密消息。三条写 Agent 消息 offer 的路径都检查这个声明：`submitAgentExecution`、`enqueuePreparedOffer` 和 `enqueueAgentEgressOffer`。没有声明时，它们拒绝开启 C2 的 offer。今天只有 `submitAgentExecution` 检查有没有 `consume`（`cloud.ts:1940-1942`），另外两条不检查（`cloud.ts:2021-2047`）。
- inbound 再检查一次，因为 offer 和 `POST /byok/messages` 可以在不同的部署上运行。加密消息到达时，如果没有能处理加密输入的 consumer，Host 走今天的无 consumer 路径：新 reservation 记 `held`，原因代码是 `consumer_unavailable`（`inbound.ts:278-282`）。明文 consumer 收不到密文输入。
- 产品的去重键改为 `(tenant, device, task, agentRef, messageId, contentMac)`。

### 10.3 产品后端仍能做的事

- 用身份和冻结上下文授权：目标对话是否存在、是否已关闭、`freshnessCursor` 是否过期。
- 检查 `contract` 和 `contentType`，并按 `paddedLength` 检查长度的桶上限。
- 按条数和长度做配额与限流。
- 把密文原样存进产品自己的存储，交给 scope 成员的客户端解密。
- 通知客户端「有新消息」。通知不带内容。
- 返回 `held` 或 `refused`，原因代码保持封闭。

### 10.4 产品后端不能再做的事

- 内容审核、凭据扫描、关键词路由、摘要、搜索和索引。
- 带内容的推送预览和服务端渲染。
- 跨 Bot 中继时读正文。要读正文的一方必须是同一 scope 的成员设备，否则这个 scope 保持明文。
- 草稿流。`agent_message_draft` 在服务端按 UTF-8 偏移拼接，密文上做不到。v1 对加密任务拒绝 `agent.message.draft`。以后可以改成加密帧的追加日志（§14 D9）。

AiphaBee 现在在 Worker 里扫描记忆快照中的凭据。开启 C4 后，这一步要移到设备上，在封装之前做。

## 11. 删除：crypto-shredding 与 scoped row-delete（任务 7）

### 11.1 identity receipt 不能直接删

identity receipt 是防重放的 fence，同时保存了正文，而且永不过期。

- `task-offer-delivered:` 存在后，同一 taskId 不能再次投递（`cloud.ts:1174-1181`）。
- `task-offer:` 防止投递前换正文。
- 终态 receipt 保证第一份事实不被覆写。

删掉这些行，复用的 taskId 就能再执行一次。

### 11.2 crypto-shredding（加密类别）

- 一个成员签署 `shred(scopeId)` 链条目。各成员删除本地缓存的全部 epoch scope key。Host 删除这个 scope 的全部 key package。这个 scopeId 之后不能再建新 epoch。
- 数据库行、R2 对象、副本、备份和日志里的密文都无法再解开。行本身不动。
- fence 照常工作。比较投影只用元数据和 MAC，不需要密钥，Host 本来也没有密钥。同一 taskId 的新内容仍返回 `coordination_input_invalid`。
- MAC 密钥一起销毁。留下的 MAC 不能再用来确认猜测。
- 备份缺口：备份里可能还有 key package。只要某个成员的 KEM 私钥还在，就能打开它们。处理方法是 shred 之后每个成员轮换 KEM 密钥，并删除旧私钥（§7.5）。另一个选项是 key package 只在投递窗口内保留，代价是成员丢失本地密钥后无法恢复（§14 D5）。
- 不覆盖：明文类别；已导出或截图的明文；元数据。
- E5b-2 的设备部分（owner batch §74c）：设备的 keyring 在 catch-up 应用 shred 时清零这个 scope 的 key，并删掉它的 freshness 点和轮换过的 epoch。链上有一条 shred 晚于本设备最新的 `rotate`（没有就是 `add`），而且那个 scope 的 policy 包含本设备，就欠一次 KEM 轮换。Host 声明 `e2ee.member.kem-epoch` 时，设备在后台做这次轮换；失败的不在同一轮重试。设备只在取包、封装、收到通知或启动时读链，Host 不为 shred 发通知。
- E5b-1 的 Host 部分（owner batch §50g A、§50h A）：Host 在追加链条目的同一个事务里识别 `op: 'shred'`（协议把它的主体限定为严格的 `{ scopeId }`），先删这个 scope 的 key package，再删它的 epoch，把 scope 记进 `e2ee_scope_shred`（迁移 0028），并写 `e2ee-scope-shred:<scopeId>` 审计 receipt。之后对这个 scope 的 key package 写入返回 409 `e2ee_scope_shredded`。Postgres 里 shred 和写入都先拿 `(tenant, scope)` 的事务 advisory 锁。Host 不验签名，`docs/security.md` 记录了这个代价。

### 11.3 scoped row-delete（脱敏删除）

- 新增 control-plane 操作，例如 `redactTasks(tenant, { taskIds })` 和 `redactScope(tenant, { scopeId })`。
- 操作把正文列换成无正文的 tombstone，保留 key、摘要、长度、时间、状态和 disposition。它删除只被这些行引用的 R2 对象，并写一条审计 receipt。
- 摘要：加密行保留 `contentMac`。明文行保留正文的 SHA-256；Host 本来就能读明文行，所以 SHA-256 不增加泄露。同一 taskId 的新内容仍能与摘要比较，返回 `coordination_input_invalid`。
- 覆盖范围：§2.2 表中存 task 正文的列，即 receipt、admission、egress、attested record、task 自由文本和 R2 对象。outbox 行属于 core mailbox。操作不直接改写它们，理由与 `revokeDevice` 不删 outbox 相同（`packages/cloud-dataplane/src/stores/devices.ts:71-99`）：`acked` 行按保留期删除；`expired` 行调用 `discardDeadLetter`；task 还有 `pending` 行时，操作返回可重试的拒绝，这些行最迟 7 天后变成 `expired`。记忆投影继续用 `eraseAgentMemoryProjection`。草稿和 activity 行等 TTL 到期删除。
- 选择行：加密行带明文 `scopeId`，可以按 scope 选。明文行由 Host 提供 taskId 或 agentId。SDK 不保存对话与 task 的对应关系（ADR-038 决策 8）。
- 运行环境：必须能在 `cloud-dataplane/runtime` 上运行。它按批次执行，可以续跑，每个请求管理自己的连接池。它不能像 tenant erasure 那样只支持 Node。
- 先例：`AgentMemoryProjectionStore.erase` 已经删除正文并保留 epoch fence（`packages/cloud-dataplane/src/stores/agent-memory-projection.ts:237-238`）。新操作沿用这个模式。
- 不覆盖：备份、副本和已经写出的日志。它们要等各自的保留期结束。
- E5a 实现与本节的偏差（PR #782，待维护者确认）：
  - outbox：E5a 直接把 `acked` 和 `expired` 行的正文换成 tombstone，行保留。原因：不改写时，canary 扫描在保留期结束前不能到零；`discardDeadLetter` 只在 Node 上运行，所以 Workers 上不能处理丢失设备的 task。行保留，所以 `recoverableFrom` 下限和 message-id 唯一键不变。有 `pending` 行时仍返回可重试的拒绝。
  - 草稿、activity 和 approval 行：E5a 直接删除，不等 TTL。
  - 摘要：明文 SHA-256 让能读数据库的人确认一个猜测的正文。`docs/security.md` 记录这个代价。
- E5b 与本节的偏差（owner batch §50i A）：不做 `redactScope`。明文行不带 `scope_id` 列，做它要加列并从 JSON 正文回填。Host 改为用这个 scope 的 taskId 调用 `redactTasks`。

### 11.4 对比

| 方面 | crypto-shredding | scoped row-delete |
| --- | --- | --- |
| 适用类别 | 只适用加密类别 | 全部类别，包括明文 |
| 备份与副本 | 立即不可读（要同时处理 key package，见 §11.2） | 等保留期结束 |
| fence | 行不变，fence 不变 | 保留摘要，fence 不变 |
| 存储空间 | 不释放 | 释放正文和对象 |
| 依赖 | 至少一个成员在线签署；成员删除本地密钥 | 只需要 Host |
| 证据 | Host 从未持有密钥；销毁有签名记录 | 审计 receipt。不能证明备份已删 |
| 运行位置 | 成员端点；Host 只删 key package | Workers 和 Node |

### 11.5 建议

两条路都提供。加密类别先用 crypto-shredding 删除内容，再用 scoped row-delete 回收空间。明文类别（例如 Bot 对话）只能用 scoped row-delete。Workers 上的整 tenant erasure 另开 issue。

[hosted Host contract](../hosted-host-contract.md) 第 6 节（PR #682 合入）把一项现状记为 Gap：task receipt 和 admission 行没有 TTL，也不能按 task、设备、Agent 或时间删除。scoped row-delete 补的就是这个 Gap。明文行的 scoped row-delete 不依赖加密，可以在 E1 之前单独交付（§13 E5）。

明文类别也能用 Host 持有的 per-scope 静态加密密钥做 crypto-shredding。它需要 KMS，也挡不住 Host 本身，所以 v1 不建议（§14 D6）。

## 12. 迁移、Topology L 与性能（任务 8）

### 12.1 从明文迁移

- 已有明文行不做事后加密。Host 若持有密钥来加密，就违反 §4 第 3 条；那些明文也已经暴露过。旧数据按 §11.3 删除。
- 按 scope 切换。成员建立 scope key 和 `scope-policy`，之后提交的 task 带 `sealing`。之前的 task 保持明文直到结束。一个 task 不在运行中改变策略。
- 上线顺序：
  1. 数据库迁移只做加法：成员链、key package、`scopeId` 索引列。
  2. Host 部署并声明 `sealed-payload-v1`。
  3. daemon 升级并声明同名设备能力。
  4. 产品为 scope 打开策略。
- 设备没有声明能力时，Host 在提交时拒绝加密 offer，不降级。
- AiphaBee 研究任务：relay 保留到托管路径有 Workers 和两台设备的验收证据为止（双车道方案 D3）。relay 的概念可以一一对应：浏览器临时密钥对应客户端 KEM 密钥；设备 relay 密钥对应设备 KEM 密钥；route id 对应 scopeId；frame 元数据对应 AAD。
- 云端调度由用户开启，默认只在本地运行（opt-in cloud scheduling; local by default）。按 #655 D-I1，只有开启云端调度的设备才做 hosted enrollment。默认设备不接触 hosted SDK，继续用产品自己的凭据。
- 一台设备只运行一个 daemon。同一进程里的两个 daemon 实例也算两个。所以开启云端调度时，这台设备的 daemon 整体改为和 hosted 配对（#655 R2）。
- relay 在条件满足后对开启云端调度的设备退场。默认设备能否从浏览器收研究任务：待定，保持现状。relay 继续为默认设备服务，到安排删除 relay 时再按数据决定。

### 12.2 Topology L

- L 里 Host 和 daemon 都在设备上。SDK 存储是本机 SQLite，没有要隐藏内容的云端。L 不需要 SDK 存储加密。
- L 里远端客户端经产品 relay 访问设备时（AiphaBee 的现状），产品 relay 可以直接用同一套封装格式和成员链。
- embedded server（`packages/server`）应接受同样的 `sealed` 字段和能力门。一个 Bot 在 L 和 H 之间切换时，加密契约不变。
- 成员链和 scope key 属于成员，不属于 L 或 H 的 Host。切换车道（双车道方案 §4.1）不换钥，也不能关闭已开启的类别。

### 12.3 性能

| 项 | 成本 |
| --- | --- |
| 发送方封装一条内容 | 一次 HKDF、一次 HMAC、一次 AES-GCM。64 KiB 以内不到 1 ms |
| 新 epoch | 每个成员一次 HPKE 封装，即一次 P-256 ECDH，约 1 ms |
| 设备首次处理某个 epoch | 多一次取 key package 的往返。之后在内存命中 |
| Host 与 Workers | 只对密文做 SHA-256。没有解密，没有 HPKE |
| 体积 | 内联密文的 base64url 增加约 33%；16 KiB 以上的填充少于 6.25%；超过 256 KiB 的密文走 blob，不用 base64url；外层字段约 400 字节 |
| 存储 | 密文和今天的明文一样存两份（receipt 与 outbox）；租户内 blob 去重失效；新增 key package 行，数量为成员数 × scope 数 × epoch 数，每行约 400 字节 |
| 配额 | mailbox 字节上限按密文计。同样数量的任务更早触顶 |
| 产品体验 | 服务端不能生成预览、搜索或摘要。客户端负责解密和渲染 |

## 13. 实施切片、验收与回退

### 13.1 切片

以下是设计时建议的交付物。各切片的合入状态以 #654 issue 为准。

- S0（0.28.3）：现状威胁模型和 canary 明文清单测试。不改 wire（§13.6）。
- E1 字节规则：`@byok-sdk/core` 的封装对象、AAD、MAC、成员链条目、key package 和测试向量。同一组向量在 Chromium、WebKit、Gecko、Node 和 Bun 上运行。
- E2 成员与密钥：daemon 的成员密钥托管和配对验证秘密；客户端参考库；成员链校验；key package 通知；客户端丢失密钥后的重新批准（§7.8）。
- E3 wire 与存储：划分表、两个能力门、Host 的比较投影和长度上限。memory、SQLite 和 Postgres 三种 store 一起修改。routine 模板的 `routineRef`、比较投影和设备校验也在这一片（§6.3）。填充帧、`ciphertextRef` 和摘要规则的 schema 测试也在这一片（§8.6、§9.3）。
- E4 读写接口：`consume` 的加密输入；读接口返回密文；对加密任务拒绝草稿；文档写明产品不能把加密任务交给 `cloud-do`。
- E5 删除：crypto-shredding 流程；Workers 上的 scoped row-delete。明文行的 scoped row-delete 不依赖 E1 到 E4，可以先交付；加密行的部分随 E3 一起做。
- E6 conformance 与文档：把 S0 的 canary 清单改为加密类别零命中；在 `docs/security.md` 补加密后的威胁模型（#654 需求 6）；同步 spec 和 protocol。

每个切片单独合入。不带 `sealing` 的 task 行为不变。

### 13.2 验收

- canary：在 C1–C4 中各放一段 canary。用 `createByokCloud` 加 `cloud-dataplane`（Postgres 与 R2）跑通配对、任务下发、结果回传、Agent 消息和记忆投影。然后扫描每个表、每个列和每个对象，查找 canary 的 UTF-8、JSON 转义、base64、base64url 和 hex 形式。命中数必须为零。表清单以 `TENANT_ERASURE_TABLES` 及其 schema drift 检查为准。
- 同一组 canary 在 `cloud-dataplane/runtime` 的 Workers 加 Hyperdrive 组合上再跑一次。
- fail closed：缺 key package、epoch 错误、MAC 不符、未知版本、旧 Host、旧设备、Host 把加密 offer 改成明文、Host 把密文搬到另一个 task。每一项都必须被拒绝，且不留明文。
- 幂等：同一 taskId、同一内容重新加密后重试，结果为重复；同一 taskId、不同内容，返回 `coordination_input_invalid`；重复投递被去重。
- 撤销：移除成员后，新 epoch 的内容对它不可读。Host 扣留 `remove` 时，签署方能检测到。
- routine 模板：同一份模板用于同一 routine 的多次执行。换 routine、换 Agent、关掉 C3 或过了 `notAfter` 时，设备拒绝。
- 客户端丢失密钥：浏览器清除站点数据后，旧客户端被移除。有另一个仍有密钥的客户端时，经它重新批准，并为每个 scope 签署 `scope-policy` 更新，浏览器能读到全部设备 scope 的旧 epoch 内容。没有存活的客户端时，经一台设备重新批准，并为它的 scope 签署 `scope-policy` 更新，浏览器能读到这台设备 scope 的旧 epoch 内容。只有链上的 `add`、没有 `scope-policy` 更新时，任何成员都不为这个 scope 重发 key package。其他设备 scope 的 fan-out 定下之前（§7.8），不验收它们的恢复。
- 未开启的类别：现有测试套件全部通过，行为不变。

本 PR 没有运行这些测试。

### 13.3 与 issue 654 的对应

| #654 条目 | 本文位置 |
| --- | --- |
| 需求 1 密钥 | §7 |
| 需求 2 明文只留元数据 | §6、§8.5、§9.3 |
| 需求 3 云端逻辑只看元数据 | §8.3、§9、§10 |
| 需求 4 fail closed | §8.3、§8.4 |
| 需求 5 conformance | §13.2。S0 先交付测量部分（§13.6） |
| 需求 6 文档 | §5 先给出威胁模型。S0 在 `docs/security.md` 写现状，E6 补加密后的状态 |
| 验收 | §13.2 |

### 13.4 回退

- 两版都只改这一份文档。还原文档即可回退，不涉及数据。
- 实现切片都在能力门之后。不声明 `sealed-payload-v1` 的部署行为不变。
- Host 没有密钥，不能把已加密数据转回明文。关闭加密只影响新 task：成员更新 `scope-policy` 后，新 task 才回到明文。已加密的数据仍只对成员可读。

### 13.5 故障模式

| 情况 | 谁发现 | 处理 | 后果 |
| --- | --- | --- | --- |
| 设备没有声明 `sealed-payload-v1` | Host | 提交时拒绝加密 offer。不建 task，不写 mailbox（§12.1） | 等设备升级 |
| Host 没有声明 `sealed-payload-v1` | 设备 | claim 前 decline（§8.4） | 不发明文 |
| 缺 key package | 设备或客户端 | `sealed_key_unavailable`。设备做非重试 decline | task 不运行 |
| AEAD 失败、帧检查失败，或 `ciphertextRef` 的 blob 缺失 | 接收端 | `sealed_open_failed` | 拒绝这条内容 |
| MAC 与内容不符 | 接收端 | `sealed_content_mac_mismatch` | 拒绝这条内容 |
| `sealing.categories` 与 AAD 不符 | 设备 | AEAD 失败，`sealed_open_failed`，非重试 decline（§6.2） | Host 的降级被挡住 |
| `sealing` 的 scope 或 epoch 与密文头不符、低于 `scope-policy`，或 routine 模板过了 `notAfter` | 设备 | `sealing_policy_mismatch`，非重试 decline（§6.2、§6.3） | Host 的降级被挡住 |
| 同一身份跨 epoch 重试 | Host | MAC 不同，按冲突处理。offer 返回 `coordination_input_invalid`，其他身份用各自现有的冲突代码（§9.2） | 发送方必须重发第一次的字节 |
| task 运行中有成员被移除 | 设备 | 封装输出前检查链，按 §7.5 轮换到新 epoch 再封装。已发出的密文不变 | 被移除方读不到之后的输出 |
| Host 扣留成员链的 `remove` | 签署 `remove` 的成员 | 从后续内容 AAD 的链头和 epoch 发现，提示用户（§7.6） | 被撤销方可能读到扣留期间的内容 |
| 浏览器丢失成员密钥 | 浏览器 | 由持有 scope key 的成员重新批准。每个要恢复的 scope 先签署 `scope-policy` 更新，再重发 key package（§7.8） | 一次重新批准。没有存活的客户端时，批准设备只恢复自己的 scope。浏览器里未确认的待提交密文丢失 |
| 一个 scope 的全部成员都丢失密钥 | — | 无法恢复（D13） | 这个 scope 的数据丢失 |
| 被撤销的设备一直离线 | — | 无法清除它的密钥（§5.4） | 它仍能读旧 epoch 的内容 |
| routine 模板过了 `notAfter`，或与 offer 不符 | 设备 | 非重试 decline（§6.3） | 这次执行不运行 |
| 产品没有声明能处理加密消息 | Host | 拒绝开启 C2 的 offer。inbound 记 `held`，原因是 `consumer_unavailable`（§10.2） | 消息不交给产品 |
| 加密 task 被交给 `cloud-do` | 产品 | 产品的义务是不这样做。SDK 无法检查（§6.2） | 明文进入 DO 存储 |
| `ciphertextRef` 的 blob 没有引用 | — | E3 为引用它的行写 `object_reference`（§8.6） | 不写时，blob 一天后被回收，正文丢失 |
| 一批 envelope 超过 2 MiB | 服务端 | 返回 413（`packages/cloud/src/handlers/messages.ts:154-155`）。E3 让 drain 按字节分块（§8.6） | 分块之前，这一批发不出去 |

### 13.6 0.28.3 的首个切片

0.28.3 是补丁版本。这一班的规则是：没有 owner 确认，不改 wire、API budget、依赖或 CI 映射（发版台账 #715）。E1–E6 都要改 wire 或 API。

建议 0.28.3 只交付 S0。S0 不改 wire、API、依赖或 SQL：

- S0-a 文档：在 `docs/security.md` 加「托管 surface 的威胁模型」一节，写今天的状态。按数据类别列出 Host 的运营方、Postgres、R2、日志和备份能读到什么，以及每类数据怎样删除。内容取自 §2.0、§2.2 和 hosted Host contract 第 6 节。这是 #654 需求 6 的现状部分。
- S0-b 测试：canary 明文清单。它放在 `cloud-dataplane` 的真实 Postgres 加 S3 测试里（`packages/cloud-dataplane/src/__tests__/support/dataplane.ts`）。用一段 canary 跑通配对、任务下发、结果回传、Agent 消息和记忆投影。然后扫描每个表、每个列和每个对象。
  - 表清单用 tenant erasure 的同一个查询从 `pg_class` 读出（`packages/cloud-dataplane/src/tenant-erasure.ts:266-284`），不用常量。新表因此也会被扫描。
  - 查找 canary 的 UTF-8、JSON 转义和 hex 形式。base64 和 base64url 形式按三种字节偏移各生成一次；也可以先解码能解码的列，再查找。
  - 测试有一份期望清单，它断言两件事：扫描命中的 `(表, 列)` 集合等于清单；`docs/security.md` 的表格列出同一个集合。以后新增存内容的列而不更新清单和文档，测试就失败。
  - 摘要列不会命中 canary。`docs/security.md` 把它们单独列出（§9.3）。
  - S0-b 的清单只记明文任务，以后也不改。E6 另跑一次加密任务：`examples/hosted-bot-collaboration/src/sealed-zero-hit.test.ts` 用真 daemon 经 E2EE 配对，跑加密任务和同形状的明文孪生，复用 S0 的扫描器。加密 canary 必须零命中，密文落点要等于 `docs/security.md` 的 `hosted-sealed-inventory` 块，成员要能打开 Host 读接口返回的密文。这是 #654 需求 5 的测量部分。

S0-b 是已有测试目录里的一个新文件，预计不改 CI 映射。实现时在 PR 里确认。

可选的 S0+：明文行的 scoped row-delete（§11.3，E5 的前半）。它补 hosted Host contract 第 6 节的「retention and scoped deletion」Gap。它不依赖加密，但新增 control-plane API，可能还要 SQL 迁移，所以要 owner 先定 D6 和 API budget。

必须等待的部分：

| 切片 | 等待的原因 |
| --- | --- |
| E1 字节规则 | 依赖 D2（AAD 里的成员身份和链头）、D7、D8、D10、D12、D16。字节格式发布以后很难再改。决定之后可以开工，随 E3 一起发布 |
| E2 成员与密钥 | 依赖 D2、D4、D5、D13。配对体验会变 |
| E3 wire 与存储 | 依赖 D7、D8、D16、D17。双向 gated addition，是 wire 改动。memory、SQLite、Postgres 三种 store 要一起改 |
| E4 读写接口 | 依赖 D11。`consume` 和读接口的形状会变 |
| E5 后半：crypto-shredding | 依赖 D5、D6 和 E2 |
| E6 零命中与文档 | 依赖 E1–E4 |
| routine 模板 | 依赖 E3 和 D15 |
| C4、输入准备、草稿 | 等到 v2（D17） |

建议 E1–E6 进一个功能版本，例如 0.29.0。发布条件是 Workers 加 Hyperdrive、两台设备和浏览器矩阵的验收证据。浏览器矩阵要在 Chromium、WebKit 和 Gecko 上跑 E1 的测试向量。仓库的 `package.json` 里现在没有浏览器测试运行器，加它属于依赖改动。删除 AiphaBee 自研的 relay 之前，先定 #655 的身份对应（D14）。

## 14. 待 owner 决定的事项（任务 9）

| 编号 | 决定 | 选项 | 建议 |
| --- | --- | --- | --- |
| D1 | 开启粒度（#654 交给维护者） | 按 task 冻结，由 scope 策略决定；按 envelope 类型；按 Agent | 按 task 冻结，由 scope 策略决定。类别为 C1–C4 |
| D2 | 信任锚 | 配对验证秘密（128 位，随配对码携带）；6 位短码比对（需要先承诺、再揭示的交换）；只信 Host 目录 | 配对验证秘密。只信 Host 目录不满足 #654 需求 1 |
| D3 | AiphaBee 首批类别与作者规则 | 研究 scope 开 C1、C3，按需开 C2；Bot 对话与记忆保持明文 | 采用。同时确认 Host 组装的 ContextPack 不属于端到端加密 |
| D4 | 成员链、key package 和设备路由由谁实现 | SDK 提供存储与设备路由；Host 自己实现（provider provisioning 的先例） | SDK 实现。canary 和 conformance 才能覆盖它 |
| D5 | key package 保留方式 | 长期保留，shred 后成员轮换 KEM 密钥；只在投递窗口内保留 | 长期保留。浏览器丢失密钥后，靠它按 scope 恢复旧 epoch（§7.8）。scope 按设备划分后，新设备和重新配对的设备不读旧 scope（§7.9） |
| D6 | 删除 | crypto-shredding 加 Workers 上的 scoped row-delete；明文类别也用 Host 持有的密钥做 shredding | 前者。明文行的 row-delete 可以先于 E1 交付。Workers 上的整 tenant erasure 另开 issue |
| D7 | wire 版本 | v3 内的双向 gated addition；升到 v4 | v3 内的 gated addition |
| D8 | 填充与大内容 | 长度前缀帧，16 KiB 以内 256 字节对齐、以上用 Padmé，超过 256 KiB 走 `ciphertextRef`；第一版的 2 的幂桶，只能内联；固定桶；不填充 | 第一项（§8.1、§8.6）。Padmé 的开销少于 6.25%，2 的幂桶最多 100%。只能内联时，最大的终态超过 2 MiB 的批次上限。加密终态的明文上限取 2 MiB |
| D9 | 加密任务的草稿 | v1 拒绝；加密帧追加日志 | v1 拒绝 |
| D10 | 多用户 tenant 与发送方认证 | v1 只支持单用户 scope；每条内容加发送方签名 | v1 只支持单用户 scope |
| D11 | `consume` 的形状 | 独立的加密输入加显式声明；同一函数加判别字段 | 独立输入加显式声明 |
| D12 | 设备 KEM 密钥 | 新的 credential 条目；复用 provider sealing key | 新条目。两者的用途和轮换周期不同 |
| D13 | 成员丢失密钥 | 设备或其他客户端重新批准，并重发 key package；增加恢复密钥；接受数据丢失 | 单个浏览器丢失密钥（Safari ITP、清除站点数据）时，按 scope 由持有它的成员恢复：先签署这个 scope 的 `scope-policy` 更新，再重发 key package（§7.8）。代价是一次重新批准。这依赖 D5 的长期保留。一个 scope 的全部成员都丢失密钥时，先接受这个 scope 的数据丢失。恢复密钥另行设计 |
| D14 | 发版位置 | E1–E6 进 0.28.3；E1–E6 进之后的功能版本；与 #655 的先后 | 0.28.3 只交付 S0（D18）。E1–E6 进之后的功能版本，例如 0.29.0。先定 #655 的身份对应，再删 AiphaBee 的自研 relay。#655 已定，见 §14.2 |
| D15 | Host 发起的 routine 任务的 C1 | 成员封装的 routine 模板，身份为 `routineId` 加 `definitionVersion`，由设备校验；routine 任务只封装 C3 | 模板（§6.3）。模板交付之前，routine 任务只封装 C3 |
| D16 | 加密类别里对内容的摘要 | 密文 SHA-256、keyed MAC 或移进密文三选一，加 schema 测试；保留明文摘要 | 前者（§9.3）。明文摘要让 Host 能确认猜测 |
| D17 | v1 范围 | C1、C3，C2 按需，C4、输入准备和草稿等到 v2；一次做完 C1–C4 | 前者（§6.1）。AiphaBee 首批只需要 C1 和 C3 |
| D18 | 0.28.3 的切片 | S0（现状威胁模型加 canary 清单测试）；S0 加 S0+（明文 scoped row-delete）；不交付 | S0（§13.6）。S0+ 要先定 D6 和 API budget |

### 14.1 请 owner 回答的问题

AiphaBee 已同意第一版 D1–D14 的建议（PR #685 的评论）。第二版改了 D8 和 D14 的建议，要请 AiphaBee 再确认。D15 按 AiphaBee 的选择写入。下面的问题请 owner 以 SDK 维护者的身份回答。

1. D1、D3–D7、D9–D13、D15：是否把这些建议定为 SDK 的决定？
2. D2：信任锚是否用随配对码携带的 128 位验证秘密 `pv`？代价是配对时要传一长串或扫二维码。
3. D18：0.28.3 是否只交付 S0？还是同时交付 S0+？S0+ 新增 control-plane API，可能加 SQL 迁移。
4. D17：v1 是否只交付 C1 和 C3，C2 按需开启，C4、输入准备和草稿等到 v2？AiphaBee 的研究任务用不用输入准备？
5. D8：填充是否改为长度前缀帧、256 字节对齐加 Padmé，并让填充后超过 256 KiB 的密文走 blob？加密终态的明文上限是否取 2 MiB？
6. D16：加密类别里对内容的摘要，是否一律改为密文 SHA-256、keyed MAC 或移进密文，并用 schema 测试守住？
7. D14：E1–E6 是否进之后的功能版本，例如 0.29.0？发布条件是否为 Workers 加 Hyperdrive、两台设备和浏览器矩阵的证据？是否先定 #655？
8. 浏览器恢复的 fan-out（§7.8）：没有存活的客户端时，其他设备从链上看到 `add(新客户端)` 后，要为自己的 scope 签署 `scope-policy` 更新，再重发 key package。设备签署这条更新是自动进行，还是每台设备都要本机批准？

### 14.2 #655 身份对应的决定（2026-10-23）

维护者按建议决定。前提是 opt-in cloud scheduling; local by default：云端调度由用户开启，默认只在本地运行。

| 编号 | 决定 |
| --- | --- |
| D-I1 | 只有开启云端调度的设备才做 SDK hosted enrollment。默认设备不接触 hosted SDK，继续用产品自己的凭据（§12.1） |
| R2 | 一台设备只运行一个 daemon，同一进程里的两个 daemon 实例也算两个。开启云端调度的设备把这个 daemon 整体改为和 hosted 配对 |
| D-I2 | SDK tenant 对应 account 加 workspace 的组合。前提是一个 account 只属于一个用户（D10）。如果一个 account 会有多个用户，要在 E2a 之前再确认 |
| D-I3 | 只用 install-session，只做客户端到设备一个方向，开启入口在网页上（§7.2） |
| D-I4 | scope 按设备划分（§7.4） |
| 默认设备的研究任务 | 待定，保持现状。relay 继续为默认设备服务，到安排删除 relay 时再按数据决定（§12.1） |
