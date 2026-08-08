# S4A 数据面实施方案裁定（Postgres + R2 + 共用 conformance 套件）

> **状态**：设计提案，待 orchestrator 确认后转 plan
> **日期**：2026-08-08
> **范围**：Sprint S4A（`plans/sprints/20260807-byok-platform-raft-aligned.sprint.md:620-707`）的 O-001~O-006
> **不在范围**：S4B 的 quota enforcement、reservation-bound presign、R2 GC/reconcile、dead-letter 语义

---

## 0. 本方案依赖的已核实事实

以下每条都在本轮读过源码或跑过命令，是后面裁定的地基：

| 事实 | 证据 |
| --- | --- |
| `deviceId` 是**云端铸造**的 UUID，不是设备自选 | `packages/cloud/src/auth/plane.ts:92` 的 `deviceId: \`dev_${crypto.randomUuid()}\``；`PairRequestSchema`（`packages/protocol/src/http-api.ts:24-29`）没有 deviceId 字段 |
| `runCoreConformance` 是**全有全无**的 | `port-inventory.ts` 断言 `Object.keys(stores).sort()` 等于全部七个 `CORE_STORE_NAMES`，缺一个 port 整套跑不起来 |
| route 挂载已经是 capability 驱动 | `packages/cloud/src/cloud.ts:143/155/159` 按 `declares(...)` 条件 `register`；`capabilities.ts` 明确写「不声明 `blobs.presigned` 就完全不挂 blob routes」 |
| `MailboxStore.collectRetired` 与 `MailboxRetentionInput/Result` 已在 core 定型 | `packages/core/src/mailbox.ts:94-131` |
| `check-deploy-sql-order` 只做四位前缀严格递增 + `tests/sql/control_plane_invariants.sql` 存在时的 `grep -F` 引用检查 | helper 源码 `scripts/check-deploy-sql-order.sh:85-108` |
| PGlite 是**单连接**数据库，多连接靠 multiplexer 串行化 | 官方 `pglite-socket` 文档：`default: 1, no concurrent connections`、`not all use cases are guaranteed to work` |
| 候选依赖当前版本 | `pg@8.22.0`、`postgres@3.4.9`、`@electric-sql/pglite@0.5.4`、`@testcontainers/postgresql@12.1.0`、`aws4fetch@1.0.20`、`@aws-sdk/client-s3@3.1105.0`（`npm view` 实测） |
| CI 现状 | `.github/workflows/ci.yml` 六 job，无任何 `services:` 或 docker step；`build-test` 跑 Node [20,22] 的 `pnpm -r build/typecheck/test` |

---

## 1. Postgres 测试策略

**选项**

- A：GitHub Actions `services: postgres` 容器
- B：testcontainers（`@testcontainers/postgresql`）
- C：`docker compose` 单文件，CI 与本地同一份
- D：嵌入式 PGlite（WASM）

**裁定：C。** 仓库根 `docker-compose.test.yml` 同时起 `postgres` 与 `minio`，CI 与本地跑同一条 `docker compose -f docker-compose.test.yml up -d --wait`。可用性以环境变量为闸：`BYOK_TEST_POSTGRES_URL` / `BYOK_TEST_S3_ENDPOINT` 存在则跑，缺失则 `describe.skipIf` 明示跳过；**但当 `BYOK_REQUIRE_DATAPLANE=1` 时缺失就是硬失败**，该变量只在 CI 的 dataplane job 里设置。

**理由**

- D 直接出局：`claim/status CAS`、`transaction atomicity: native`、S4B 的并发不超卖，全部要求 N 个连接真并发争一行。PGlite 把并发串行化，这些断言在它上面**永远绿但零证明力**——正是 no-silent-downgrade 要禁的形状。
- A 只能解决 Postgres，MinIO 因为 GH service container 不能覆盖 CMD 而挂不上，最后仍要第二套机制。C 用一份文件同时定义两个后端，符合一源真相。
- B 的 docker 依赖不比 C 少，还要多装一个中等体量的依赖来做 C 用十行 YAML 做完的事。
- 「CI 上必跑」的执行方式不用 `process.env.CI`（`pnpm -r test` 在 `build-test` job 里也会带着 `CI=true` 跑到这个包，会误伤）。改用专用旗标 + 一条**源码扫描 constraint 测试**钉住 `.github/workflows/ci.yml` 里确实存在设置 `BYOK_REQUIRE_DATAPLANE` 的 job——这个 idiom 仓库已经在 `packages/*/src/__tests__/constraints.test.ts` 用熟了，不是新发明。

**风险与回退**

- 风险：本地没 docker 的开发者只能看到 skip，容易误以为绿。缓解：skip 消息直接给出 `docker compose -f docker-compose.test.yml up -d --wait` 命令，且 PR 模板/runbook 里点名 dataplane job 是唯一权威。
- 风险：dataplane job 被人删掉或改名 → constraint 测试立刻红。
- 回退：compose 文件是纯附加物，删掉即回到今天的状态；不存在半套 schema 卡住的路径。
- **明确排除**：不提供 PGlite 作为「本地便捷替身」。两个引擎宣称同一个 conformance 标签就是稳态相容路径。

---

## 2. Postgres client 与 migration runner

**选项**

- client：`pg` / `postgres`(postgres.js) / kysely / drizzle
- runner：手写 ordered runner / node-pg-migrate / drizzle-kit / kysely migrator

**裁定：`pg` + 手写 ordered runner。**

runner 契约（约 120 行，落在 `@byok/cloud-postgres/src/migrate.ts`）：

1. 读 `deploy/sql/NNNN_*.sql`，按四位前缀排序（和 `check-deploy-sql-order` 同一套文件名约束，不另立目录）；
2. 取 `pg_advisory_lock(<常量>)`，保证同时只有一个 runner；
3. runner 自己 bootstrap `byok_schema_migration(version text primary key, checksum text not null, applied_at timestamptz not null)`——这是「所有 DDL 都在 `deploy/sql/`」的**唯一例外**，写在注释里；把它塞进 `0001` 会让 runner 需要一段「表还不存在」的特判，等于两处真相；
4. 每个文件与它的 ledger insert 在**同一个 transaction** 里执行，单文件原子；
5. 已应用文件的 sha256 与 ledger 不符 → `MigrationChecksumMismatchError`，fail-closed 停机。forward-only 的意思是「已发布的文件不可改」，没有这条检查就只是一句口号；
6. 不生成、不执行 `down`。rollback 策略是「应用代码回退，表留着」（S4A.6 原文）。

**理由**

- node-pg-migrate 自带 `migrations/` 目录约定与 JS migration 形态，要把它掰成 `deploy/sql/NNNN_*.sql` 就是跟工具对抗；而 harness 的 `check:deploy-sql` 已经是本仓的 migration 排序权威，两个排序权威不能并存。
- drizzle/kysely 是 query builder + 各自的 migration 故事。本仓写裸 SQL，引入 builder 等于给 schema 再加一层 TS 侧真相。
- `pg` 对 `postgres.js`：postgres.js 零依赖更漂亮，但 (a) migration 文件是多语句裸 SQL，`pg` 的 `client.query(bigString)` 原生支持，postgres.js 要 `sql.unsafe().simple()`；(b) transaction + advisory lock 需要显式 `PoolClient` 借出，`pg` 的模型更直白；(c) 生态/托管文档默认 `pg`。差距不大，但 friction 更低的一侧赢。
- `bigint`（`byteSize`、`releasedBytes`）必须显式配 int8 parser（`types: { getTypeParser }` 传给 Pool，**不改全局** `pg.types`），否则 int8 默认回字符串，quota 的 `bigint` 契约会在运行期悄悄退化成字符串比较。

**风险与回退**

- 风险：手写 runner 的 bug 直接等于生产 schema 事故。缓解：runner 自身有单测（乱序文件、checksum 漂移、并发两个 runner、部分失败回滚），且 dataplane job 每次都从空库跑一遍 `migrate-up`（就是 S4A.5 的「fresh install + migrate-up」）。
- 回退：runner 与 SQL 文件都是新增；未执行过的环境删掉即可。已执行环境按 S4A.6 forward-only，不做 destructive down。

---

## 3. R2 SDK 与测试替身

**选项**

- client：`@aws-sdk/client-s3` + `s3-request-presigner` / `aws4fetch` / 手写 SigV4
- 替身：MinIO 容器 / `s3rver` 之类进程内 fake / 自写 in-process fake

**裁定：`aws4fetch` 签名 + 原生 `fetch` 收发；测试对 MinIO 容器跑，transient error 用一层可注入的故障 wrapper。**

**理由**

- S4A 只需要五个动作：presign PUT、presign GET、HEAD、（S4B 才用的）DELETE/LIST。为此拖进 `@aws-sdk/client-s3` 的上百个传递包不划算；更实际的问题是 AWS SDK 默认的 credential provider chain 会去读环境里的 AWS 凭据，等于给这个包一条我们没要的隐式授权来源。`aws4fetch` 是单文件 WebCrypto SigV4，失败模式是 R2 返回 403，很响。
- 手写 SigV4 出局：安全敏感且无收益，`aws4fetch` 已经是那 150 行的成熟版本。
- 替身必须是**真的 S3 实现**，否则 presign 相关断言是自证：我们签、我们自己验，测不出 signature 绑定错了。MinIO 独立执行 SigV4 与过期，`tenant/resource-bound presign` 和 `expired presign` 才是真断言。
- 九项 object test 分两类，替身策略也分两类：
  - 打**我们自己逻辑**的（hash/size/type mismatch、no key traversal、cross-tenant 不产生 existence oracle、same hash duplicate idempotent）→ MinIO 上跑真流程即可；
  - 打**重试语义**的（R2 transient error/backoff/idempotency）→ 用一层包在 `fetch` 外的故障注入器确定性地吐 500/503，不需要也不应该去伪造一个 S3。这是 fault injector，不是 shadow S3。
- presign 的完整性绑定：签名里必须带 `Content-Length`（SigV4 signed header，R2 侧强制），这样错误大小的上传在对象存储层就被拒。**S4A-c probe 已裁定 checksum header 不签**：MinIO 支持该测试路径，但 R2 的 SHA-256 只支持 `COMPOSITE`、不支持单次 PutObject 需要的 `FULL_OBJECT`；签入会形成「测试基底过、生产失败」的假保证。`Content-Type` 同样签入；`HEAD` 仍无条件复核存在性、size 与 content type，但不观测 SHA-256。Hash authority 见 ADR-024（`r2-hash-authority-decision.md`）。

**风险与回退**

- 风险：S4B 的 reconciler 需要 `ListObjectsV2`，`aws4fetch` 路线要自己解 XML 分页。这是本裁定最实在的代价，写在这里让 S4B 知道。若 S4B 判定 List/multipart 的手写成本超过 SDK 的依赖成本，换回 `@aws-sdk/client-s3` 只影响这一个 adapter 文件。
- 风险：MinIO 与真 R2 的行为差异（条件请求、checksum header 支持面）。缓解：checksum 仅采用两者共同支持的生产能力；当前 SHA-256 `FULL_OBJECT` 不在交集，因此不签、不加 fallback。把 `HEAD` 复核作为无条件步骤，但只承诺它真实观测的存在性、size 与 content type。

---

## 4. 新代码的包归属

**选项**

- A：放 `@byok/cloud` 内新目录
- B：新 workspace 包
- C：放 `@byok/core`

**裁定：B —— 新建 `@byok/cloud-postgres`，Postgres stores 与 R2 adapter 都在里面。**

**理由**

- C 直接出局：`pg` 是 `node:` 依赖，`@byok/core` 的 protocol-free/Node-free 是 `constraints.test.ts` 机检的（ADR-003）。
- A 出局：`@byok/cloud` 是要发布的 handler 包，`hono` 用户不该被迫装 `pg`。更重要的是它会毁掉「cloud 是无状态骨架」这条 S3a 红线的**依赖表述**——handlers 包一旦直接依赖数据库驱动，红线就只剩注释在守。
- 命名族是 `@byok/cloud-<transaction authority>`：将来的可选 D1 adapter 叫 `@byok/cloud-d1`。R2 adapter 住在 `@byok/cloud-postgres` 里不是妥协——manifest 在 Postgres、bytes 在 R2，两者由 reservation/finalize 协议绑成**一个 transaction authority**，拆成两个包等于给同一个协议造一条跨包边界。
- 依赖边：`@byok/cloud-postgres → @byok/core + @byok/cloud（类型）+ pg + aws4fetch`。反向零依赖。
- 从第一天就带 `README.md` 与 `LICENSE`——`tasks/todos.md` 已经记了「package 声明 license 却没有文件」这个坑，不要再犯一次。

**风险与回退**：新包纯附加，`pnpm -r` 各命令自动纳入；删包即回退。

---

## 5. 九个 cloud-local port 的 durable 归属（S4A 定案点）

**裁定：接口留在 `@byok/cloud/src/stores/ports.ts` 不搬家；S4A 只定 durable 实现的家和表。** 把接口搬进 `@byok/core` 会让 core 长出设备配对/nonce/attempt 这些 hosted-surface 概念，还会逼 `@byok/server` 去实现一组它根本没有的 port——那是扩大 core 契约，不是给它找家。

### port → table 映射

| port | 归属 | table | 键与索引 |
| --- | --- | --- | --- |
| `cloud.devices` | Postgres | `device` | PK `(tenant_id, device_id)`；`UNIQUE (device_id)` |
| `cloud.pairingCodes` | Postgres | `pairing_code` | PK `(code)`，行内存 `tenant_id`/`product_id` |
| `cloud.nonces` | Postgres | `auth_nonce` | PK `(tenant_id, device_id, nonce)`，无裸索引 |
| `cloud.dedup` | Postgres | `inbound_dedup` | PK `(tenant_id, device_id, envelope_id)` + 有界回收 |
| `cloud.tasks` | Postgres | `task` | PK `(tenant_id, task_id)` |
| `cloud.receipts` | Postgres | `device_request_receipts` | PK `(tenant_id, key)` |
| `cloud.sequence` | Postgres | `device_stream` | PK `(tenant_id, device_id)`，持 `next_seq` |
| `cloud.blobs` | Postgres(manifest) + R2(bytes) | 见 §6 | — |
| `cloud.rateLimiter` | **in-memory，不建表** | — | — |
| `core.mailbox` | Postgres | `outbox` + `device_stream.acked_seq` | `outbox` PK `(tenant_id, device_id, seq)` |
| `core.board` | Postgres | `board_item` + `tenant_stream` | PK `(tenant_id, item_id)`；`tenant_stream` PK `(tenant_id)` 持 `board_seq` |
| `core.truth` | Postgres | `attested_record` | PK `(tenant_id, kind, subject_id)` |
| `core.presence` | Postgres | `device_presence` | PK `(tenant_id, device_id)` |
| `core.activity` | Postgres | `activity_tail` | PK `(tenant_id, task_id)` |
| `core.objects` | Postgres | `object_manifest` + `object_reference` | PK `(tenant_id, hash)` / `(tenant_id, hash, ref_kind, ref_id)` |
| `core.quota` | Postgres | `storage_entitlement` / `storage_usage` / `storage_reservation` | 全部 PK 以 `tenant_id` 开头 |

**三处需要解释的裁定**

1. **`rateLimiter` 不建表。** S3a 的实现是 allow-all，注释写明真限流是 edge/infra 的事。给一个 allow-all 建表是造一张永远空的表；真限流落地时它也不会是一张 Postgres 表（那正好是每请求一次写的反模式）。composition 直接供 in-memory 实例，port bundle 依然完整。
2. **`device` 的 `UNIQUE (device_id)` 不违反「no naked device index」。** deviceId 由云端铸造（`auth/plane.ts:92`），全局唯一是构造性的；而且 `resolveByDeviceId` 是 `ports.ts:65-66` 白纸黑字的三个 pre-tenant 例外之一，它取回的 row 自带 tenant，随后每一步都走 tenant-first 查找（§12.6.2 第 5 层）。禁止的是「按裸 deviceId 反查、再比对租户」的两步纪律，不是这条构造性单步解析。
   顺带记一条：`InMemoryDeviceDirectory` 的 `#byDeviceId` 是全局 last-write-wins map（`device-directory.ts:15,29`）。今天安全**只因为**云端铸 UUID；若哪天允许设备自选 id，这张 map 与 Postgres 的 `UNIQUE (device_id)` 会同时变成跨租户拒绝服务。这条约束值得进 §12.6.2 的注释。
3. **S4A.2 十二表不足以支撑 O-003 与 conformance**，必须补 `board_item`、`object_manifest`/`object_reference`、三张 quota 表。原文写的是「Schema minimum」，补充符合字面，但要在 plan 里显式记为对 S4A.2 的扩写（见 §12）。

---

## 6. `CloudBlobStore` 与 core `ObjectStore` 的关系

**裁定：分层，不合流。**

- `core.objects`（`ObjectStore`）= **manifest 权威**，只有 metadata，落 Postgres 的 `object_manifest`/`object_reference`。它已经是 Node-free、无字节传输的（`blob.ts:1-15` 写死了这一点）。
- `cloud.blobs`（`CloudBlobStore`）= **capability 铸造面**，R2 adapter 实现：
  - `createUpload(tenant, decl)` → 写 `object_manifest` 的 `pending` 行 + 返回**指向 R2 的绝对 presigned PUT URL**（key = `tenants/<tenantId>/objects/sha256/<hex>`，由 `tenantObjectKey` 生成）；
  - `getDownloadUrl(tenant, blobId)` → 仅对本租户、`state = committed` 的行签 GET；
  - `pending → committed` 由「首次被引用或首次下载」时的 `HEAD` 复核驱动（观测到的 size/contentType 与声明不符即 `storage_integrity_mismatch`）。`HEAD` 不观测 digest；canonical hash 以通过认证的 daemon 声明为权威（ADR-024）。显式 finalize 端点属 S4B（S4A.4 已把 reservation-bound presign 与 finalize crash 矩阵划出去），S4A 不新开 wire route。

**必须做的一处契约调整：把字节代理三方法从 `CloudBlobStore` 拆出去。**

`verifySignedUrl` / `writeContent` / `readContent` 服务的是 `/byok/blobs/:id/content` 两条 presigned route——它们存在的理由是 in-memory 与 self-hosted composition **没地方放字节**，只能由 cloud 代传。R2 composition 走直传，这三个方法它在物理上无法实现。

- 裁定：`CloudStores.blobs` 收窄为 `{ createUpload, getDownloadUrl }`；三方法移到独立的 `BlobContentProxy`，由 composition 作为**可选输入**提供（不是 `CloudStores` 成员）；capability 词表从 `blobs.presigned` 裂出 `blobs.contentProxy`，两条 `/content` route 仅在 proxy 存在且 capability 声明时挂载。
- 为什么不是「R2 实现返回 typed 拒绝」：新增的 cloud conformance 套件届时只有两条路——要么给 R2 composition 跳过这三个方法（子集豁免 = 静默降级），要么断言一个毫无意义的拒绝。两条都比拆端口差。
- 为什么这是**最小**改动而不是重构：route 的 capability 条件挂载 `cloud.ts:159` 已经存在，ADR-010 正是「能力差异靠声明而不是嗅探」；这里做的只是把一个粒度过粗的 capability 分成它本来就该有的两个。S3a 的四条红线（handler 无状态、无 Running/session map、无 404/405/501 嗅探、route inventory 穷举）全部不受影响。
- 附带收益：这样 Postgres 侧就**不存在**任何按裸 `blobId` 的查找路径，S4A.5 的「no naked object index」是构造性成立的，不靠纪律。

**风险与回退**：动了 `@byok/cloud` 的导出面与 route 组合，`route-inventory.test.ts` 要补新的 capability 组合。风险有界且在一个 PR 内可审。回退 = 恢复五方法端口并让 R2 侧拒绝，代价是上面那条子集豁免，不建议。

---

## 7. Conformance 套件定型（O-005）

**选项**

- i：`@byok/core` 开 subpath export `./conformance`
- ii：测试文件跨包相对 import
- iii：抽独立私有 workspace 包

**裁定：iii —— 新建 `@byok/conformance`（`"private": true`，不发布）。**

结构：

```
packages/conformance/src/
  core/        harness.ts + 九个维度（从 packages/core/src/__tests__/conformance/ 平移）
  cloud/       runCloudConformance + cloud-local port 维度（新增）
  compositions/  in-memory-core.test.ts、in-memory-cloud.test.ts（composition 入口）
```

配套的三处调整：

1. `CORE_PORT_METHODS` / `CORE_PORT_INTERFACES` **移进 `@byok/core` 的 shipped source** 并从 index 导出。它们本来就是契约数据（现有注释自己说「a port grows by contract」），不是测试细节；移出去还能断掉 `core ⇄ conformance` 的 devDependency 循环。`@byok/cloud` 同样导出一份 `CLOUD_PORT_METHODS` / `CLOUD_PORT_INTERFACES`。
2. in-memory composition 的入口测试从 `packages/core` 搬到 `packages/conformance`，方向变成 `conformance → core`、`conformance → cloud`，**零循环**。代价：`pnpm --filter @byok/core test` 单跑时不再自证参考实现合规，`pnpm -r test` 仍覆盖。这个代价可接受，因为 conformance 包本来就是这件事的权威。
3. 不开 subpath export、不发布。理由是 §12.6.6 点名的三个 composition（InMemory / Postgres+R2 / self-hosted server）全在库内；「out-of-repo composition 要用套件」在真的出现之前是想象需求。等可选 D1 adapter 真的出库外再决定发布，那时是加一个 export 的事。

**cloud-local port 要不要自己的维度：要。** S4A.2 十二表里有五张（`device`/`pairing_code`/`auth_nonce`/`inbound_dedup`/`device_request_receipts`）归 cloud port，而 I4 的题面是「store conformance 跨租户不变式跑在 SQL 后端」。跨租户泄漏最可能发生的地方恰恰是 `resolveByDeviceId` / `redeem` 这两个 pre-tenant 入口——不给它们维度，I4 的 SQL 侧就是残的。`runCloudConformance` 的维度：port inventory、tenant isolation（含三个 pre-tenant 例外的定向断言）、pairing 单次消费、nonce TTL 与消费、dedup 有界性、attempt CAS（首个 claim 赢）、receipt 首份事实不可覆写、per-device seq 单调。

「新增 composition 只提供 factory、断言零改动」怎么保持：`CloudCompositionFactory` 与 `CoreCompositionFactory` 同形（`create()` 返回 `{ stores, now(), advanceTime(ms), dispose?() }`）。**任何一条断言需要按 composition 分支，就是 port 契约有问题，必须上抛而不是加分支**——这句话要写进 `runCloudConformance` 的文件头，和 `harness.ts:5-11` 现有那句一致。

---

## 8. I4 的 SQL 侧补齐

**裁定：I4 SQL 侧 = 行为套件跑 Postgres composition（自然结果）+ 一层 catalog 不变式断言（需要额外做）。**

`cross-tenant query plan cannot use a naked key path` 不能用 `EXPLAIN` 断言：planner 会随统计信息、数据量、PG 版本变，写出来的是一个会自己 flaky 的测试，而且它证明的是「这次查询没用某索引」，不是「这条路径不存在」。

改成**目录级断言**，是确定性的、与 planner 无关的，而且它直接就是 §12.6.2 第 3 层的机器可读形式：

- 扫 `pg_index` / `pg_constraint`，对所有 tenant-owned 表断言：**任何 UNIQUE index/constraint 的首列必须是 `tenant_id`**；
- 例外只有一条白名单：`device.device_id`（pre-tenant 解析，云端铸造保证唯一）与 `pairing_code.code`（云端铸造的一次性凭据，行内存 tenant）。白名单写死在断言里，加一条就要改这个文件——这就是它的价值；
- 再断言每张 tenant-owned 表都**有** `tenant_id` 列且 `NOT NULL`，防止漏建。

行为侧不需要额外写：`runCoreConformance` 与 `runCloudConformance` 的 tenant-isolation 维度跑在 Postgres composition 上，就是 I4 的另一半。

---

## 9. `tests/sql/control_plane_invariants.sql`

**裁定：建，而且让它成为 §8 那层 catalog 断言的**唯一**住处。**

- 内容是可执行 SQL：一组 `DO $$ ... IF ... THEN RAISE EXCEPTION ... END IF; $$` 块，外加文件头的「覆盖的 migration 清单」（这段注释同时满足 `check-deploy-sql-order` 的 `grep -F` 引用要求）；
- dataplane job 在 migrate 之后执行它；TS 侧只负责「跑这个文件、断言不抛」，**不复写一份断言**。一源真相；
- 顺带的操作价值：运维可以对生产库直接 `psql -f tests/sql/control_plane_invariants.sql` 做同一套体检，这不是测试专用品。

**代价（要认）**：建了它，`check:deploy-sql` 就升级成「每个 migration 都必须被这个文件引用」的双重约束，以后每加一个 migration 都要回来更新文件头。这正是 S4A 风险等级判定为「高」的地方所需要的摩擦——schema 一旦发布就难改，加一道「新表必须被不变式认领」的闸是划算的。

---

## 10. Mailbox retention 文档化与 `noteSkippedSeq`

**retention 文档化（S4A.5 必需）**：port 契约已经在 `mailbox.ts:94-131` 定死（`ackedBefore` 删已 ack 行、`expireUnackedBefore` 把未 ack 行标 `expired` 而**不删**、两个 instant 必须是 canonical ISO-8601 UTC）。S4A 要交付的是：

- Postgres 的 `collectRetired` 实现，以及它在 `outbox` 上用的具体谓词与索引；
- `deploy/runbooks/mailbox-retention.md`：默认窗口、谁来调用（宿主的定时任务，SDK 不自带 scheduler）、与 §12.7.5 表格的对应、以及**「容量有界 ring」与「时间有界 SQL retention」不可互换**这条（§12.7.5 末段明确要求写进 runbook）；
- dead-letter 语义**不在 S4A**（S4B O-009），runbook 要写明现在 `expired` 行只是标记、不流转。

**`noteSkippedSeq`（`tasks/todos.md:22`）裁定：S4A 不动代码。**

- 触发器原文是「协议版本升级新增 `task.*` 类型，**或** S4A 的 mailbox retention 工作，谁先落地谁处理」。S4A 确实先到了，但真正要改的是 `packages/client/src/daemon/connection-manager.ts:695-702`——一个 client 侧文件，而且是 S3b 明确标注的零 diff 契约红线。在一个 schema sprint 里改它，等于把 crash matrix 的验收面拖进来重跑，是范围膨胀。
- S4A 该做的三件小事：(a) 在 mailbox retention runbook 里写明「hosted daemon 可能通过 skip 路径推进 cursor 并让 mailbox 退休该行，且本机无 journal 记录」，让运维知道这条证据缺口存在；(b) 把 todos 那条的 revisit trigger 收窄成「协议版本升级新增 `task.*` 类型」单一触发，去掉已经消耗掉的 S4A 分支；(c) 不做任何代码改动。
- 这与用户的倾向一致，我独立复核后同意：文档化 + 收窄触发器，实现留给协议升版。

---

## 11. Slice 拆分

**硬约束先摆出来**：`runCoreConformance` 的 port-inventory 断言要求 composition 一次供齐全部七个 core port，所以 **core 的七个 Postgres 实现无法分刀**——分了就一条断言都跑不了，中间态没有绿。这决定了切法，不是偏好问题。

**裁定：三刀，各自有真中间绿态。**

### S4A-a｜migrations + cloud-local Postgres ports + conformance 套件定型

- **交付物**：`docker-compose.test.yml`（postgres + minio）；`@byok/conformance` 私有包（core 维度平移 + `runCloudConformance` 新增 + in-memory 两个 composition 入口）；`@byok/core` 导出 `CORE_PORT_*`、`@byok/cloud` 导出 `CLOUD_PORT_*`；`@byok/cloud-postgres` 包骨架（Pool + int8 parser + migrate runner + `deploy/sql/0001_cloud_local.sql`）；七个 cloud-local port 的 Postgres 实现（rateLimiter 仍用 in-memory 实例）；CI `dataplane` job（Node [20,22]，`BYOK_REQUIRE_DATAPLANE=1`）；钉住该 job 存在的 constraint 测试。
- **验证**：`pnpm -r run typecheck` / `test` / `build`；`pnpm run check:deploy-sql`；`repo-harness run check-task-workflow --strict`；`docker compose -f docker-compose.test.yml up -d --wait` 后 `pnpm --filter @byok/cloud-postgres run test`。
- **中间绿态**：cloud conformance 在 in-memory 与 Postgres 两个 composition 上都绿；core 仍只有 in-memory，契约自洽。
- **红线**：不动 `@byok/cloud` 的 handlers 与 route registry；不动任何 core port 签名；Postgres composition 不得用 in-memory 顶替任何一个已实现的 port。

### S4A-b｜core 七 port 的 Postgres 实现 + I4 SQL 侧

- **交付物**：`deploy/sql/0002_core_domain.sql`（含 `board_item`/`tenant_stream`/`object_manifest`/`object_reference`/三张 quota 表）；mailbox（含 `collectRetired`）/board/truth/presence/activity/objects/quota 七个实现；`runCoreConformance` 跑 Postgres composition；`tests/sql/control_plane_invariants.sql` 与执行它的测试；mailbox retention runbook。
- **验证**：同上，外加两个 composition 的 core conformance 全绿。
- **中间绿态**：S4A.5 里除 object bytes 与 deploy 骨架外的全部条目成立。
- **红线**：conformance 断言零改动——任何需要 composition 分支的断言一律停下上抛；quota port 必须是真 Postgres 实现，不许塞 in-memory 让套件变绿。

### S4A-c｜R2 object adapter + 部署骨架

- **交付物**：capability 拆分（`blobs.presigned` / `blobs.contentProxy`）与 `CloudStores.blobs` 收窄；`aws4fetch` R2 adapter（presign PUT/GET + HEAD + tenant-scoped key）；S4A.4 九项 object test；MinIO 接进套件；`deploy/env/*.example`、`deploy/runbooks/`、`deploy/scripts/migrate`。
- **验证**：同上，外加 object suite 全绿、`deploy/` 不再只有 `.gitkeep`、示例文件不含真实凭据。
- **红线**：字节不经 cloud 代理；不做 reservation-bound presign 与 finalize 端点（S4B）；任何路径都不删 R2 对象。

**为什么不是两刀**：a 是「机制刀」（测试基建 + 套件形态 + 包骨架），把它和 b 合并会得到一个三千行、审查者无法分辨「机制错了」还是「实现错了」的 PR。**为什么不是四刀**：c 里的 capability 拆分与 R2 adapter 是同一个设计决策的两面，拆开会留下一个「capability 已裂但没人用第二个」的中间态。

---

## 12. 需要 orchestrator 确认的两处 sprint 文本修订

1. **S4A.2 的「storage/quota 相关 schema 属 S4B」与 S4A.5 的「两个 composition 跑同一份 suite」直接冲突**。port-inventory 是全有全无的，Postgres composition 不供 `QuotaStore` 就一条断言都跑不了。建议修订为：quota 的 **entitlement/usage/reservation 三表与 port 实现落 S4A**（因为套件强制），S4B 拥有 enforcement、control-plane 同步、GC/tombstone 与 dead-letter 的**增量** schema。
   替代方案「S4A 只跑套件的子集」已排除：那是给 conformance 开子集豁免口子，等于把 no-silent-downgrade 作废。
2. **S4A.2 的十二表是 minimum，需补 `board_item`、`object_manifest`/`object_reference` 与上述三张 quota 表**，否则 O-003 与 `core.objects` 无处落地。属于字面允许的补充，但要在 plan 里显式记账。

---

## 13. 一页速查

| # | 决策点 | 裁定 |
| --- | --- | --- |
| 1 | Postgres 测试策略 | 根级 `docker-compose.test.yml`（pg + minio），env 闸 + `BYOK_REQUIRE_DATAPLANE=1` 硬失败；排除 PGlite |
| 2 | client / migration | `pg` + 手写 ordered runner（advisory lock、per-file transaction、checksum fail-closed、无 down） |
| 3 | R2 SDK / 替身 | `aws4fetch` + `fetch`；MinIO 容器为权威，故障注入 wrapper 测退避 |
| 4 | 包归属 | 新建 `@byok/cloud-postgres`，R2 adapter 同包 |
| 5 | 九 port 归属 | 接口留 cloud；八个进 Postgres，`rateLimiter` 留 in-memory 不建表 |
| 6 | blob 关系 | 分层：manifest→Postgres、bytes→R2；把 content-proxy 三方法拆出端口 + 裂 capability |
| 7 | conformance | 私有包 `@byok/conformance`，port 表上移进 core/cloud 的 shipped source 断循环；新增 cloud 维度；不发布 |
| 8 | I4 SQL 侧 | 行为套件跑 Postgres + catalog 不变式（UNIQUE 首列必须 tenant_id，两条白名单）；不用 EXPLAIN |
| 9 | invariants.sql | 建，且作为 catalog 断言唯一住处；接受 migration 引用的双重约束 |
| 10 | retention / skip path | retention 出实现 + runbook；`noteSkippedSeq` S4A 不动代码，只文档化并收窄 trigger |
| 11 | slice | 三刀：机制+cloud ports / core 七 port+I4 / R2+deploy |
