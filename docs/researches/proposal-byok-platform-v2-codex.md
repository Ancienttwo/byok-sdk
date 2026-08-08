RECOMMENDATION: 以 `@byok/platform-core` + `@byok/cloud` 兩個新增包承接「本機權威、雲端無狀態」平台化，保留 wire v1 原樣，並把既有 `@byok/server` 收縮為 async、自託管專用的可選協調器 — confidence: HIGH

# BYOK 平台架構方案 v2（Codex 對照稿）

> 狀態：獨立第二軌方案，供與 repo 根目錄 `ARCHITECTURE-PROPOSAL-byok-platform.md` 對照。
> 邊界：本文接受使用者已拍板的部署、安全、資料分類、傳輸與雙產品線共識；不重開這些決策。
> 方法：以目前 `main@1d6dd85` 的程式與計畫現場複核為依據；本文只提出目標架構與遷移切法，不聲稱它們已實作。

---

## 0. 一頁結論

v2 不應把現在的 `ConnectionHub` 搬進 Workers，也不應把 `TaskStore` 換成 Postgres 後便稱為「雲端平台」。目標形狀應是：

1. **任務狀態機與 agent runtime 全在本機**。雲端不保存 `Claimed / Running / AwaitApproval` 等可恢復的運行中狀態。
2. **雲端只有三種資料語義**：持久真相、待領信箱、帶 TTL 的狀態提示。三者使用不同表與不同一致性規則，不共用一張 `tasks` 萬用表。
3. **新增兩包，不做 package explosion**：`@byok/platform-core` 放平台 HTTP schema、Ed25519 確權封套與 async ports；`@byok/cloud` 放可部署於 Workers 或 Node 的無狀態 handler。Postgres/D1、S3/R2 是注入 adapter，不各自升格為 package。
4. **現有 `@byok/server` 留下，但改名定位**：它是 embedded、single-owner/self-hosted coordinator 的可選件，不是官方雲端 runtime。其 `TaskStore` 直接做一次 breaking async 化，不提供 `T | Promise<T>` 雙形介面。
5. **wire v1 原封不動**。mailbox 內仍放 frozen v1 `Envelope`；device proof 是 HTTP header／外層 API contract，不進 `EnvelopeSchema`，不新增或改寫任何 v1 control payload。
6. **memory 採「增量為真相、快照為加速」**。起工拉取 head + materialized snapshot + 後續 deltas；收工由本機過濾後以 CAS 寫一個 commit，雲端不做語義 merge。
7. **keys 線先完成既有 K2-K4，不被平台線阻塞**。K2 的 profile persistence 從第一天就是 async、自成一線；K4 完成發佈與 AiphaBee swap 後，才切 `@byok/server` 的 breaking async migration。

---

## 1. 已定邊界與 v1 對照

### 1.1 不重開的共識

- agent runtime 100% 在使用者宿主機。
- 雲端只做資料確權，以及 profile、memory、終態上下文的儲存。
- 雲端不保存運行中狀態；任務狀態機權威在本機。
- server 無狀態，可部署於 Workers 或 Node；不用 Durable Objects。
- 資料面只用 SQL（Postgres 或 D1）與 object storage（S3 或 R2）。
- 事件下發是 polling + cursor；wire v1 FROZEN，不修改。
- 上下文過濾、memory merge 與 agent 執行都在本機；雲端只驗外層 schema、簽章、scope、hash、revision 與大小限制。
- dispatch 線與 keys 線不互相依賴。

### 1.2 相對 repo 根 v1 提案的改變

| 面向 | 根目錄 v1 提案 | 本 v2 對照稿 |
|---|---|---|
| 雲端角色 | `@byok/server` 是 SaaS 端 embedded coordinator | `@byok/cloud` 是 stateless mailbox／truth API；coordinator 權威移回本機 |
| 任務狀態 | `ConnectionHub` + `TaskStore` 推動完整 state machine | 本機 journal 推動；雲端只收 mailbox ack、ephemeral hint 與 immutable terminal record |
| 連線模型 | WS 為主、long-poll fallback，hub 保持 live maps | 平台標準路徑只要求 polling + cursor；WS hub 僅留 self-hosted optional |
| 持久化 | `TaskStore` 可換 SQLite | 拆成 `MailboxStore`、`TerminalRecordStore`、`StatusHintStore`、`ContextStore`、`DeviceAuthorityStore` |
| 協議 | wire v1 FROZEN | 繼續 FROZEN；平台 API 與 device proof 均在 wire 外層 |
| keys 線 | `@byok-sdk/keys` 獨立 | 維持獨立；不 import platform-core/cloud，也不被它們 import |
| 優先序 | doctor／upgrade／watchdog 等 client 產品化 | 先關閉 authority/storage 邊界；上述能力仍是 client 後續，不混入本次平台 core |

---

## 2. 程式現況複核（P1：架構地圖）

### 2.1 真實 package 與 embedded 邊界

目前 workspace 有四包：`protocol`、`server`、`client`、`keys`。正式依賴上，`server` 與 `client` 只依賴 `@byok/protocol`，`keys` 只依賴 `zod`（`packages/server/package.json:32-38`、`packages/client/package.json:39-50`、`packages/keys/package.json:32-34`）。安全文件亦已把「dispatch 三包不得依賴 keys，keys 也不得反向依賴」寫成可執行邊界（`docs/security.md:596-610`）。

`@byok/server` 現在確實是嵌入式 library：`createByokServer()` 回傳 Hono app、Node WS attach、dispatch、tasks、machines、events、devices、stats 等 in-process surface（`packages/server/src/index.ts:78-123,138-196`），不是一個可直接水平擴展的獨立 cloud service。

### 2.2 TaskStore、BlobStore 與 ConnectionHub

- `TaskStore` 的 `create/get/list/transition/setPendingApprovalId` 全部同步（`packages/server/src/task-store.ts:46-94`）。任務書所列 `:46-93` 的事實正確，但 interface 的 closing brace 實際在 **第 94 行**。
- `InMemoryTaskStore` 是 `Map`（`packages/server/src/task-store.ts:109-179`）；`SqliteTaskStore` 使用 Node `DatabaseSync` 與同步 statements（`packages/server/src/sqlite-task-store.ts:157-218,251-276`）。
- `BlobStore` 已天然 async：除純驗簽 `verifySignedUrl` 外，建立 upload、查 URL、exists、讀寫內容皆回傳 `Promise`（`packages/server/src/blob-store.ts:36-49`），且註解本來就把 S3/GCS/R2 presigned URL 當替換點（`:7-20`）。
- `packages/server/src/hub.ts` 現場為 **1,689 行**。它持有 connections、outboxes、dedup rings、long-poll waiters、task runtimes、event queue、task activity、lease timer 與 counters（`packages/server/src/hub.ts:280-342`）；outbox ring 上限 500、dedup ring 上限 1,024（`:50-54`）。
- dispatch 會同步建立 server-side task record，再建立 result promise/event queue，最後送出 `task.offer`（`packages/server/src/hub.ts:1335-1379`）。這證明今天的權威仍在 server hub，不是已經在本機。
- SQLite 只恢復 task **record**；重啟後 runtime promise、event queue、device registry 與 outbox 皆為空，明文不承諾 in-flight recovery（`packages/server/src/sqlite-task-store.ts:121-136`）。因此「把 SQLite 換成 Postgres」不能修正 authority mismatch。

### 2.3 protocol 與 device identity

- `PROTOCOL_VERSION` 固定為 1，breaking schema change 必須升版並刻意更新 golden（`packages/protocol/src/version.ts:1-25`）。freeze guard 同時鎖 schema fingerprint、歷史 NDJSON bytes 與 `PROTOCOL_VERSION === 1`（`packages/protocol/src/__tests__/freeze-guard.test.ts:47-83,239-300,518-521`）。
- codec 只處理 `string | Uint8Array` 與單行 NDJSON，沒有 transport-specific API（`packages/protocol/src/codec.ts:9-60`）。WS 與 HTTP long-poll 最終都把同一 `Envelope` 送進 hub；WS 路徑見 `packages/server/src/ws-server.ts:85-142`，HTTP 路徑見 `packages/server/src/http.ts:206-280`。
- protocol 已明確區分「plain HTTP bodies」與 wire envelope，且說明 pairing/token/blob HTTP contract 不影響 wire `v:1`（`packages/protocol/src/http-api.ts:5-15`）。這正是新增 platform API 而不碰 wire v1 的既有 seam。
- 現有 device identity 已採 Ed25519：public key 是 base64url JWK `x`、signature 是 raw Ed25519 base64url、private key 不離開裝置（`packages/client/src/daemon/device-keys.ts:3-16,23-46`）。pair 與 renewal schema 已有 `devicePublicKey`、`nonce`、`signature`（`packages/protocol/src/http-api.ts:24-29,49-72`）。

### 2.4 明確 out of scope

- 不在本文設計 agent runtime adapter、prompt、tool policy 或本機 Git workspace 細節。
- 不把 provider API key、`@byok-sdk/keys` registry 或 settings server 放進 platform core。
- 不以 WS presence、lease timer 或 cloud task transition 作為平台正確性條件。
- 不在本方案中解決 doctor、self-upgrade、rollback、watchdog；它們仍屬 `@byok/client` 產品化工作。

---

## 3. 目標依賴圖與 runtime 形狀

箭頭 `A → B` 表示 A 可 import B；沒有箭頭即禁止依賴。

<pre>
@byok/client ───────────────→ @byok/protocol
      │                            ↑
      └──→ @byok/platform-core ────┘
                    ↑
                    │
             @byok/cloud
          (stateless handlers)
             ↑            ↑
     Node composition   Workers composition
     Postgres + S3      D1 + R2
@byok/server ──→ @byok/protocol + @byok/platform-core
(self-hosted optional coordinator; never the hosted authority)
@byok-sdk/keys ──→ zod / OS credential APIs only
(no edge to or from any dispatch/platform package)
</pre>

一條具體路徑如下：

<pre>
SaaS enqueue v1 task.offer
  → SQL mailbox（per-device seq）
  → local daemon poll(cursor)
  → durable local journal append
  → mailbox ack
  → local state machine / runtime / local context filter
  → ephemeral hint updates（可丟）
  → local memory delta + terminal v1 envelope
  → signed terminal write（SQL transaction + object refs）
  → frontend poll reads terminal truth
</pre>

這條路徑的關鍵順序是 **先本機 durable append，後 mailbox ack**。若 ack 前 crash，雲端重送；若 ack 後 crash，本機 journal 恢復。雲端不需要 `Running` record 才能保證任務不消失。

---

## 4. 決策一：core 拆分粒度與 TaskStore async 化

### 選型

新增且只新增兩個平台包：

1. **`@byok/platform-core`**：environment-neutral，內容限於：
   - platform HTTP DTO/Zod schemas；
   - `DeviceProofEnvelope` canonicalization、hash 與 Ed25519 verify/sign helpers；
   - `DeviceAuthorityStore`、`MailboxStore`、`TerminalRecordStore`、`StatusHintStore`、`ContextStore`、`ObjectStore` async ports；
   - portable error codes、cursor/revision/idempotency types。
2. **`@byok/cloud`**：Hono/fetch-compatible stateless application service，只組合 core ports，不持有 process-local authority。Node 與 Workers 各有 composition entrypoint；SQL/object adapter 由 deployer 注入。

`@byok/server` 不改名冒充 cloud core，而是明確標成 **self-hosted optional coordinator**。它保留現有 WS/long-poll hub 能力，供單節點 embedder 與測試使用。

`TaskStore` 採一次性 breaking async migration：

```ts
export interface TaskStore {
  create(input: CreateTaskInput): Promise<TaskRecord>;
  get(taskId: string): Promise<TaskRecord | undefined>;
  list(): Promise<TaskRecord[]>;
  transition(
    taskId: string,
    to: TaskState,
    patch?: Partial<Omit<TaskRecord, 'taskId' | 'state'>>,
  ): Promise<TaskRecord>;
  setPendingApprovalId(
    taskId: string,
    pendingApprovalId: string | undefined,
  ): Promise<TaskRecord | undefined>;
}
```

切法是 leaf-first、單一版本完成：

1. 先把 `InMemoryTaskStore` 與 `SqliteTaskStore` 方法改為 async；保留 SQLite 現有 CAS invariant，不把 read-validate-write 拆到 store 外。
2. 再把 `ConnectionHub` 所有讀寫 store 的 handler 改成 async，加入 **per-device FIFO promise chain**；否則 WS callback 不 await 會讓原本同步序列化的 state transition 變成並行 race。
3. `handleInbound()` 改回傳 `Promise<InboundResult>`；`POST /byok/messages` 逐筆 await，WS handler enqueue 後依序處理。
4. public `tasks.get/list` 一併改為 Promise；這是 0.x prerelease 的明確 breaking change，不保留同步 overload。
5. 最後把 `setPendingApprovalId` 從 optional 改為 required；現有 optional 是對舊 embedder 的 compatibility concession（`packages/server/src/task-store.ts:77-91`），不應帶入新 steady state。

### 理由

- **兩包足以保護真正邊界**：core 是 portability/security contract，cloud 是 deployment/application behavior。再細分成六個 store packages，只增加 release graph，沒有新增 failure isolation。
- **async 是 port contract，不是效能承諾**：D1/Postgres 都是 async；同步 interface 會逼 adapter 偽同步或把 I/O 藏在不可能的位置。反過來，`DatabaseSync` 即使包在 async function 內仍會 block event loop，所以只留 self-hosted reference，不用於 hosted cloud。
- **不把 TaskStore 搬到 cloud**：async 化是為了讓現有 embedded API 誠實並可替換，不代表 cloud 重新擁有 running state。
- **單一 breaking cut 比雙形介面安全**：`T | Promise<T>` 會讓每個 caller 都能忘記 await，且在型別上掩蓋 data race。

### 被否選項

1. **否決：`@byok/core` 同時容納 dispatch、keys、memory、provider clients。** 這會破壞已寫入 `docs/security.md:596-610` 的雙安全模型依賴邊界，並讓 credential-isolation claim 失去 package graph 保護。
2. **否決：每個 store/provider 各一 npm package。** 目前只有兩種 deployment composition，尚無獨立版本週期或第三方 adapter 生態；過早拆包會把 schema migration 與 release coordination 放大。
3. **否決：原地把 `TaskStore` 改成 `T | Promise<T>`，慢慢遷。** 這是永久 compatibility path 的起點，也無法保證 hub handler 真正序列化。
4. **否決：刪除 `@byok/server`。** 它仍是有價值的 self-hosted reference、integration test harness 與單節點 embedder；正確動作是降級定位，不是丟棄。

### 10x 判斷

`@byok/cloud` 的 stateless handler 可水平擴展；第一個會壞的不是 core package，而是 SQL hot row（單一 device mailbox sequence）或高頻 status write。`@byok/server` 的 `DatabaseSync` 與 1,689 行 in-memory hub 會先卡 Node event loop／process memory，故不得被標成 hosted scale path。

---

## 5. 決策二：雲端最小 API、表結構與 server 收縮

### 選型

平台 API 分成 control-plane、device-plane、read-plane；device-plane 全部要求 §6 的 device proof。路徑名稱可在實作前微調，但語義與冪等規則固定如下。

#### 5.1 最小 API

| Plane | API | 語義 | 寫入分類 |
|---|---|---|---|
| control | `POST /v2/devices/:deviceId/mailbox` | SaaS 以自身 auth enqueue 一個 frozen v1 S→D `Envelope`；SQL 配 per-device `seq` | 信箱 |
| device | `POST /v2/devices/:deviceId/mailbox:pull` | `{afterCursor, limit, waitMs}`；long-poll，回 `{events, cursor}` | 無；只讀 |
| device | `POST /v2/devices/:deviceId/mailbox:ack` | durable-local-append 後單調 ack `throughCursor` | 信箱 |
| device | `PUT /v2/tasks/:taskId/hint` | upsert coarse hint，TTL 最長 120 秒 | 狀態提示 |
| device | `PUT /v2/tasks/:taskId/terminal` | immutable terminal record；可帶 memory commit candidate，在一個 SQL transaction 內 CAS | 真相 |
| device | `POST /v2/scopes/:scopeId/context:pull` | 拉 profile revision、memory head、snapshot ref 與 delta refs | 真相，只讀 |
| device | `PUT /v2/scopes/:scopeId/profile` | revision CAS 的 opaque profile manifest | 真相 |
| device | `POST /v2/scopes/:scopeId/memory:commit` | 非 task-finalize 情境的獨立 memory CAS commit | 真相 |
| read | `GET /v2/tasks/:taskId/view?afterRevision=N` | 前端輪詢；terminal 優先，否則只回未過期 hint；支援 ETag/304 | 無；只讀 |

`mailbox:pull` 的 `events` 必須仍是 `@byok/protocol` 的 v1 `Envelope[]`，cursor 仍是 per-device monotonic sequence。cursor **不是** task state，也不因 pull 自動前進；只有 ack 才更新 server-side mailbox watermark。這延續現有 `EventsPollResponseSchema` 的 `{events, cursor}` 形狀與 cursor 語義（`packages/protocol/src/http-api.ts:108-125`），但平台 proof 與 endpoint 屬獨立 v2 HTTP contract。

對 `task.offer` 而言，「成功處理到可 ack」明確定義為：v1 bytes 與 local task record 已在同一個本機 transaction durable append，且工作已交給本機 scheduler；不是等 agent 跑到 terminal。如此 crash 發生在 append 前會由 mailbox redelivery 補回，append 後則由 local journal 接管恢復，cursor 不需要承擔 running-state recovery。

`terminal` 只接受 `task.complete`、`task.fail`、`task.cancelled` 三種 frozen v1 envelope，加上 opaque context/memory object refs。相同 `requestId + bodyHash` 重送回原結果；同 taskId 不同 terminal hash 回 `409 terminal_conflict`，不覆寫第一份真相。

`hint` 不沿用 `TaskState` 名稱，避免 UI 把它誤認為權威 state machine。固定 coarse enum：`available | accepted-local | executing-local | awaiting-local-user | finalizing`。過期即不存在；前端看到 `terminal = null, hint = null` 時只能顯示「尚無最新裝置提示」，不得合成 `Running` 或 `Failed`。

#### 5.2 SQL 表（portable logical schema）

| 分類 | 表 | 核心欄位與 constraint |
|---|---|---|
| 真相 | `device_keys` | `(tenant_id, device_id, key_id)` PK、`product_id`、`public_key`、`key_epoch`、`status`、`created_at`、`revoked_at` |
| 真相 | `entitlements` | `entitlement_id` PK、tenant/product/device/scope binding、permissions、`valid_from/to`、`revoked_at`、`revision` |
| 真相 | `device_request_receipts` | `(tenant_id, device_id, request_id)` unique、operation、resource、body_hash、key_id/epoch、accepted_at；兼作 replay/idempotency ledger |
| 真相 | `profiles` | `(tenant_id, scope_id)` PK、`revision`、manifest/object ref、content hash、proof ref、updated_at |
| 真相 | `memory_heads` | `(tenant_id, scope_id)` PK、`head_revision`、`head_commit_id`、`snapshot_commit_id` |
| 真相 | `memory_commits` | commit_id PK、scope、parent/head revision、`delta|snapshot`、object key/hash/bytes、source task、proof ref、created_at |
| 真相 | `terminal_records` | `(tenant_id, task_id)` PK、terminal type、v1 envelope/object refs、body hash、device/key/proof refs、memory revision、completed_at |
| 信箱 | `mailbox_cursors` | `(tenant_id, device_id)` PK、`next_seq`、`acked_through`; enqueue/ack 用 SQL transaction/CAS |
| 信箱 | `mailbox_entries` | `(tenant_id, device_id, seq)` unique、entry_id、task_id、v1 envelope bytes or object ref、body hash、available/expires/acked_at |
| 提示 | `task_status_hints` | `(tenant_id, task_id)` PK、device_id、hint enum、hint payload、observed_at、expires_at、revision |

大型 instruction、artifact、profile、memory delta、snapshot 與 final context 放 S3/R2；SQL 只放可交易的索引、hash、revision、proof 與 object key。object key 採 content-addressed `sha256/<hex>`，寫入前先驗 size/hash；terminal/memory transaction 只引用已存在物件。

#### 5.3 `@byok/server` 的收縮路徑

1. **先加新路徑，不改舊路徑語義**：`@byok/cloud` 直接對上述 ports 開發，不經 `ConnectionHub` 或 `TaskStore`。
2. **再完成 §4 async migration**：讓既有 embedded server 的 storage boundary 誠實；同時在 package README/API docs 標為 self-hosted coordinator。
3. **移除 hosted positioning**：官方 Node/Workers examples 改 compose `@byok/cloud`；`createByokServer()` 只出現在 self-hosted/testing examples。
4. **不把 TaskStore 泛化成 mega-store**：cloud 端沒有 `TaskStore` option，只有按資料語義拆分的五個 ports。

### 理由

- mailbox ack、terminal truth、status hint 的一致性要求完全不同；拆表讓 retention、index、衝突與 UI 語義不互相污染。
- SQL transaction 足以配發 per-device cursor、做 CAS 與 immutable terminal insert；不需要 actor affinity，因此 Durable Objects 沒有必要。
- object storage 承擔大 payload，避免 D1/Postgres row 膨脹；現有 `BlobStore` 已證明 presigned/object-store seam 是 async 且可注入。
- 對 frontend 而言，polling 只需判斷 terminal truth 與 TTL hint，無需重建 cloud state machine。

### 被否選項

1. **否決：一張 `tasks` 表保存 Offered→Running→Complete。** 這會讓雲端重新成為 state authority，直接違反已定邊界；斷線時也會產生「cloud Running、本機已死」的雙真相。
2. **否決：把 `ConnectionHub` maps 換成 Redis／Durable Objects。** 問題不是 map 不耐久，而是 hub 擁有了不該由 cloud 擁有的 live authority；換 storage 只會固化錯誤邊界。
3. **否決：status hints 寫入 terminal 表或永久 event log。** hint 的產品價值是短期 UI 可見性；永久化會使非權威資料被下游當成 audit truth。
4. **否決：pull 即 ack。** response 在本機 durable append 前就前進 cursor 會造成 crash window 與永久漏件。

### 10x 判斷

高頻 hint 是第一個 write-amplification 熱點：client 應最多每 2 秒更新一次，frontend 2–5 秒 polling + ETag，TTL 清理由資料庫原生 expiry job 或批次掃描完成。單一裝置的 `mailbox_cursors` row 是刻意 serialization point；若一個 device 需要每秒數千 enqueue，先失效的是產品的 single-device ordering 假設，而不是 SQL 選型。

---

## 6. 決策三：Ed25519 device-key 確權封套與 wire v1

### 選型

沿用現有 Ed25519 key encoding，但新增一個 **HTTP-layer detached proof**。proof 放 `X-BYOK-Device-Proof` header（base64url 編碼 JSON）；request body 保持自己的 DTO。schema 如下：

```ts
interface DeviceProofEnvelopeV1 {
  schema: 'byok-device-proof-v1';
  keyId: string;
  keyEpoch: number;
  protected: {
    tenantId: string;
    productId: string;
    deviceId: string;
    audience: 'byok-platform';
    operation:
      | 'mailbox.pull'
      | 'mailbox.ack'
      | 'status.write'
      | 'terminal.write'
      | 'context.read'
      | 'profile.write'
      | 'memory.commit';
    method: 'POST' | 'PUT';
    path: string;
    querySha256: `sha256:${string}`;
    bodySha256: `sha256:${string}`;
    requestId: string;       // UUID v4; replay + idempotency key
    issuedAt: string;        // ISO-8601 UTC
    expiresAt: string;       // issuedAt 後最多 5 分鐘
  };
  signature: string;         // raw Ed25519 signature, base64url
}
```

簽名 preimage 固定為：

```text
UTF8("BYOK-DEVICE-PROOF-V1\n") || RFC8785_CANONICAL_JSON(protected)
```

server 驗證順序固定：schema/size → method/path/query/body hash → device/key/epoch/entitlement binding → issued/expiry（容許最多 60 秒 clock skew）→ Ed25519 signature → `requestId` unique insert → 業務 transaction。任何一步失敗即拒絕，不推導 tenant、scope 或替代 body hash。

proof 只確權「哪個 device 對哪個 resource 做哪個 operation、簽了哪些 bytes」，不證明 agent 結果正確。`terminal_records` 保存 proof reference 與 body hash，形成資料 provenance；status proof 可只保留短期 receipt，避免永久保存高頻 payload。

在 hosted platform v2，device proof 是上述 device-plane API 的唯一裝置 authority；目前 JWT/bearer flow 留在 self-hosted `@byok/server` contract，不被 `@byok/cloud` 當作 proof 缺失時的 fallback。hosted device provisioning 可沿用現有 Ed25519 encoding，但 pairing UI、帳號登入與 entitlement grant 由宿主 control plane 負責。

### 與 wire v1 的關係

- proof **不進** `EnvelopeSchema`，不新增 `task.*` message，不改任何 frozen payload。
- mailbox entry 的內層仍是 byte-for-byte v1 envelope；proof 綁定 pull/ack HTTP request，而不是重簽或改寫每個 envelope。
- terminal write 的 body 內嵌原始 v1 terminal envelope與 context refs；proof 的 `bodySha256` 綁定完整 body。
- 這沿用 repo 既有 seam：auth/blob/long-poll HTTP bodies 本來就明示是 WSS envelope 外的 contract（`packages/protocol/src/http-api.ts:5-15`）。platform proof schema 應放 `@byok/platform-core`，**不要**加到 `@byok/protocol` frozen golden。

### 理由

- 現有 key generation/signature primitive 已經跑通，不必發明第二套裝置 key；新增的是 resource-bound authorization，不是新 crypto。
- detached proof 綁 method/path/query/body，避免只有 nonce signature 時的 cross-endpoint replay 與 confused deputy。
- `keyEpoch` 讓 key rotation/re-pair 後舊 key 即使未過期也立即失效；`requestId` 同時解決 replay 與 write idempotency。
- RFC 8785 + domain separator 把 canonical bytes 唯一化，避免 JSON key order/whitespace 差異。

### 被否選項

1. **否決：把 `signature`、`keyId` 加進 frozen v1 Envelope。** 這會污染既有 message golden，也把 transport auth 與 task semantics 綁死；現有 HTTP/wire 分界已提供正確位置。
2. **否決：只沿用一小時 JWT，不簽 request body。** bearer token 只能證明 token possession，不能為 terminal/context bytes 提供 device-level provenance，也無法把 idempotency 與簽名確權統一。
3. **否決：每次 write 先向 server 取 challenge。** 多一個 round trip，且 server-issued nonce 沒有比 client requestId + SQL unique receipt 提供更強的 resource binding。
4. **否決：server 根據 access token 自動補 tenant/product/scope。** 這會讓被漏簽欄位成為隱含 authority；protected claims 必須完整，server 只做 equality check。

### 10x 判斷

高頻 polling proof 的 signature verify 先吃 CPU，request receipt 先吃 SQL write。實作應只對 **state-changing** request 永久留 receipt；read proof 的 replay row 可用短 retention，並在同一 device 上批次清理。若之後需要降低 read-path 成本，可由 device proof 換短期、scope-bound session token，但那是明確的新 auth contract，不在 v2 偷放 fallback。

---

## 7. 決策四：memory 讀寫模式

### 選型

採 **起工拉、收工寫；增量 commit 是持久真相，snapshot 是可重建加速層**。

#### 起工拉取

1. daemon 在接受 mailbox offer、寫入 local journal 後，呼叫 `context:pull`。
2. server 回傳：`profileRevision`、`memoryHeadRevision`、最近 `snapshotRef`，以及 snapshot 之後依 revision 排序的 `deltaRefs`。
3. daemon 下載 object、逐一驗 hash，在本機套用 profile、解讀 memory、做 privacy/scope/token-budget 過濾。
4. 過濾後的 context 才交給 runtime；原始 cloud memory 不直接進 agent prompt。

#### 收工寫回

1. daemon 在本機由 terminal output 產生一個 bounded、filtered memory delta；雲端不從 summary、logs 或 artifacts 自行抽取 memory。
2. 先以 presigned URL 上傳 immutable content-addressed object。
3. `memory:commit` 帶 `parentRevision`、object hash/ref、source taskId 與 device proof；SQL 以 `WHERE head_revision = parentRevision` 做 CAS。
4. CAS 成功才推進 head；衝突回 409，daemon 重新拉 head，在本機 rebase/merge 後重送。server 不做 last-write-wins，也不解讀內容。
5. task 收尾時，memory candidate 與 terminal record 可放在同一 `terminal` request；SQL transaction 要麼同時 commit memory head + terminal truth，要麼全部不落。

#### Snapshot 規則

- 每 32 個 deltas 或 snapshot 後累積超過 8 MiB，daemon 在下一次收工時產生新 snapshot commit。
- snapshot 仍是 immutable commit，保留 parent chain 與 hash；它不覆寫或刪除 deltas。
- retention/compaction 可在確認 snapshot 可重播後刪除舊 object，但 `memory_commits` provenance row 保留。

### 理由

- 起工/收工是唯一與 runtime lifecycle 對齊的穩定同步點；持續同步會把 cloud 拉回 running-state participant。
- 增量 commit 保留 provenance、衝突與重試邊界；純 snapshot 每次寫整包，成本高且 concurrent device 容易 lost update。
- snapshot 只解決 replay 長度，不成為第二真相；生成與 merge 都在本機，符合「上下文過濾在本機」。
- CAS 使多裝置並發明確 fail-closed；409 是需要本機重新整合的真衝突，不以 last-write-wins 掩蓋。

### 被否選項

1. **否決：每次收工覆寫完整 snapshot。** 大 memory 會重複上傳，且兩裝置同時收工時後寫覆蓋前寫。
2. **否決：只存無限 append log、永不 snapshot。** 起工 replay 時間與 object GET 數量線性成長；10x 最先失效的是 cold-start latency。
3. **否決：server 端做語義 merge／摘要／敏感資料過濾。** 這要求雲端理解 memory domain，直接越過既定本機過濾邊界。
4. **否決：任務運行中串流寫 memory。** 它會把 transient reasoning、未確認內容與 partial failure 變成持久真相，也重新引入 cloud runtime coupling。

### 10x 判斷

最先出現的瓶頸是長 commit chain 與大量 object GET，而不是 SQL head lookup。32 commits／8 MiB snapshot threshold 把 replay 上限固定在可控範圍；若單一 scope 有大量並發 writers，CAS conflict 率會先上升，應在產品層縮小 scope，而不是讓 server 靜默 merge。

---

## 8. 決策五：與 keys 線 K2-K4 的遷移時序

### 選型

採 **keys 功能線不中斷、platform additive 先行、server breaking cut 最後** 的時序：

| 順序 | 線 | 切片 | 邊界 |
|---|---|---|---|
| 1 | K2 | 完成 Registry + InMemory/SQLite `ProfileStore` + package golden | `ProfileStore` 從第一版就是 async；不 import `TaskStore` 或 platform-core，只借鏡 interface injection/CAS 思路 |
| 2 | K3 | 完成 settings-server 取捨與 security docs | 不把 settings UI/server 放入 `@byok/cloud`；兩者 auth、資料與部署面不同 |
| 3 | P0 | additive 新增 `@byok/platform-core` 與 `@byok/cloud` 骨架 | 不改 `client/server/protocol/keys` public API；先立 dependency-rule test |
| 4 | K4 | 發佈 `@byok-sdk/keys`、AiphaBee swap、原 golden 原樣通過 | 獨立 cross-repo release；不得順帶導入 platform packages |
| 5 | P1 | mailbox → local journal → terminal end-to-end | wire v1 golden 必須零 diff；Node/Postgres/S3 與 Workers/D1/R2 contract suite 共用 |
| 6 | P2 | `@byok/server` TaskStore 一次性 async breaking cut與 self-hosted relabel | 在 keys K4 已閉環後進行，避免同一 release 同時承擔兩條 breaking surface |

目前 active plan 明確顯示 K0/K1 已完成、K2-K4 未完成（`plans/plan-20260805-1659-byok-keys-package.md:122-134`）；K4 又是獨立跨 repo PR（`:101-107`）。因此 platform 不應搶改 K2 的工作面，也不應把 K4 綁成 cloud migration prerequisite。

K2 的特別要求是：**不要照抄今天同步的 server TaskStore signature**。`@byok-sdk/keys` 現有 `SecretStore` 已是 Promise-based（`packages/keys/src/secret-store.ts:25-40`），Registry 的 profile persistence 應維持同一 async 風格。如此 K2 無需等待 server async 化，也不會在 P2 再做一次 breaking migration。

P0 可在 K3 後 additive 開始；若 K4 正等待外部 repo 時間窗，P0/P1 可平行推進，但 merge unit、changelog、release tag 與驗收證據仍完全分開。唯一共享面是 workspace lockfile／根文件，靠小 PR 與 merge order 協調，不用 runtime dependency 解決組織問題。

### 理由

- K2-K4 已有 active plan、contract 與 golden；中途改成 platform 子專案會擴大現行驗收邊界。
- 先 additive platform、後 breaking server，使 rollback 面清楚：刪新包即可回退 P0/P1；P2 則有自己的 prerelease migration note。
- keys 與 dispatch/platform 的獨立性應由 package graph、release unit、測試與 docs 四層共同保護，而不只靠口頭約定。

### 被否選項

1. **否決：暫停 K2，先把共同 `@byok/core` 做完。** keys 並沒有需要共用的 dispatch/platform domain；這只會製造錯誤依賴與阻塞 active plan。
2. **否決：K2 複製同步 TaskStore，再等 P2 一起 async 化。** 這會讓 keys 線承擔無必要的二次 breaking change；現有 SecretStore 已給出 async 本地慣例。
3. **否決：K4 與 `@byok/server` async cut 放同一 release。** 兩者無技術依賴，合併只會讓 regression 與 rollback 無法歸因。
4. **否決：platform-core import `@byok-sdk/keys` 以共用 profile。** provider profile 與 agent/context profile 是不同 domain；共用名字不是共用模型。

---

## 9. P2：端到端資料流與錯誤路徑

以一個真實任務為例：

1. SaaS control plane 產生 frozen v1 `task.offer`，enqueue 時 SQL transaction 配發 device seq 並寫 `mailbox_entries`。若 device 不存在／entitlement 無效，enqueue fail-closed；不改派其他 device。
2. daemon 以 signed `mailbox.pull` 帶 `afterCursor` long-poll。cloud 驗 proof 後查 `seq > cursor`；沒有事件即 timeout 回空陣列，不建立 connection record。
3. daemon 收到 offer，先將 raw v1 bytes、seq、taskId 與 local state `Offered` 原子寫入 local journal，再送 ack。若寫入失敗不 ack，下次 poll 重送。
4. 本機 state machine claim/start；runtime 在宿主機執行。cloud 可收到 coarse hint，但 hint 過期或寫失敗不影響本機執行與終態正確性。
5. 起工 context pull 回 snapshot+deltas；hash/schema/revision 錯誤時 daemon fail-closed，不自行合成 memory。所有過濾與 prompt budget 選擇在本機。
6. runtime 結束後，daemon 先形成 terminal v1 envelope與 filtered memory delta，上傳 immutable objects，再送 signed terminal write。
7. cloud 在單一 SQL transaction 驗 memory parent revision、insert request receipt、advance memory head、insert immutable terminal record。任何衝突整批 409，沒有「terminal 成功但 memory head 偷跳」的半成功。
8. frontend polling `task view`：terminal 存在即顯示持久結果；否則顯示未過期 hint；兩者皆無時顯示 unknown，不從 mailbox ack 或時間推導 Running/Failed。

錯誤 authority：

- **poll/network 失敗**：本機保留 cursor，重試；cloud 無 running state 需要修復。
- **重複 delivery**：local journal 以 `(deviceId, seq)`／envelope id 去重，ack 可重送。
- **device proof replay**：SQL unique receipt 回冪等結果或 409 hash mismatch。
- **memory conflict**：409 → 本機 re-pull/rebase；cloud 不 merge。
- **device revoked/key epoch 落後**：401/403，停止領件與寫回；不得以舊 JWT 或舊 key fallback。
- **status hint 遺失**：只影響 UI 新鮮度，不影響 task 或 terminal truth。

---

## 10. P3：為什麼這張圖是最小 coherent change

目前形狀之所以合理，是因為 M0-M5 的目標是提供一個可嵌入、可在單 process 完整演示 WS/long-poll、state machine、approval 與 persistence 的 reference server。`TaskStore` 注入、`BlobStore` 注入、Hono app 與 Node WS attach 都服務這個目標；在此範圍內，`ConnectionHub` 集中 ownership/dedup/transition 是一致的。

平台 v2 改變的是 **deployment/authority constraint**，不是否定既有實作質量。需要保留的 invariant 是：

- wire v1 bytes、cursor at-least-once 與 idempotency semantics；
- device private key 不離開宿主機；
- illegal transition fail-closed；
- keys 與 dispatch 的安全模型隔離；
- terminal/context 寫入有可驗 provenance 與 deterministic conflict behavior。

因此最小 coherent change 不是重寫 client/protocol，也不是把 hub 分散式化，而是新增 stateless platform path，讓 local journal 接管 authority，再將既有 server 誠實收縮為 optional self-hosted adapter。新抽象只保護兩個真實 cross-module invariant：**portable proof/schema** 與 **async storage ports**。

---

## 11. 驗收與遷移門禁

### 11.1 Contract tests

同一套 store contract suite 必須跑四個 composition：

- InMemory（單元測試）；
- Postgres + S3 fake/presigned test；
- D1 + R2 miniflare/Workers integration；
- self-hosted `@byok/server` async InMemory/SQLite。

必測 invariant：

1. mailbox seq 單調、pull 不 ack、durable-local-append 後 ack；
2. 同 proof + same hash 冪等，同 requestId + different hash fail-closed；
3. terminal immutable，hint TTL 不可覆蓋 terminal；
4. memory CAS conflict 不做 server merge；
5. revoked key／錯 tenant/product/scope／錯 body hash 全拒絕；
6. Node 與 Workers 對 canonical proof bytes、hash 與 error code 完全一致；
7. `@byok-sdk/keys` 與 dispatch/platform dependency graph 零邊；
8. protocol golden files零 diff，freeze guard 原樣通過。

### 11.2 Repo gates

每個切片收尾至少執行：

```bash
pnpm -r run typecheck
pnpm -r run test
pnpm -r run build
repo-harness run check-task-workflow --strict
```

K4 另以 aip-main-open 的 `apps/local-agent/src/settings.test.ts` 原樣通過為唯一 parity authority；P1 另需做一個 crash drill：在 local journal append 前／後、mailbox ack 前／後各注入 crash，證明不漏件且不需要 cloud running record。

---

## 12. 決策總表

| 決策 | 採用 | 核心否選項 |
|---|---|---|
| D1 core/async | `platform-core` + `cloud` 兩包；server TaskStore 一次 breaking async | mega-core、package explosion、`T | Promise<T>` |
| D2 cloud data/API | 五個 async ports；truth/mailbox/hint 分表；SQL + object refs | cloud task state machine、DO/Redis hub、pull-as-ack |
| D3 device proof | detached Ed25519 HTTP proof，綁 method/path/query/body/key epoch | 改 wire v1、JWT-only、challenge-per-write |
| D4 memory | 起工拉、收工寫；delta truth + local-generated snapshots；CAS | snapshot overwrite、infinite log、server semantic merge |
| D5 keys 時序 | K2/K3 繼續，P0 additive，K4 獨立閉環，P2 最後 breaking cut | 暫停 K2 做共同 core、K4/P2 綁同 release |

本稿的核心判斷是：**平台化的主工作不是把現有 server 變成更耐久的 server，而是把 authority 移到正確位置後，只讓雲端保存它真正有資格保存的三類資料。**
