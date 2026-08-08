# BYOK 平台架構方案 v2 final

> 狀態：**v2 final，取代 v1**（v1 全文留在 git 歷史，本檔直接覆寫）。雙軌 synthesize 裁定日期 2026-08-05。
> 來源：Opus 軌 `docs/researches/proposal-byok-platform-v2-opus.md`（附件）+ Codex 軌 `docs/researches/proposal-byok-platform-v2-codex.md`（附件）+ `docs/researches/tenant-isolation-decision.md`（租戶隔離定案，附件，其核心結論收進本文 §8）。三份原稿為附件引用，本文為唯一裁定文本。
> 依據：byok-sdk 工作樹實地複核（2026-08-05，本文所有 `file:line` 由兩份原稿原樣保留）+ Cloudflare 官方文件實查 + raft-computer v1.0.15 兩輪拆解與 task board 探針（方法見 §13）。
> 搭配文件：`docs/researches/HANDOFF-byok-keys.md`（K 線移植細節）、`plans/plan-20260805-1659-byok-keys-package.md`（K 線 active plan）。

---

## 0. 修訂說明：兩條共識措辭已修訂（使用者已同意）

board 這條輸入進來之後，原共識裡有兩條的**措辭**必須收緊，否則無法自洽。改的是判據，不是方向。兩條均已由使用者確認接受。

| 原措辭 | 問題 | 已修訂為 |
|---|---|---|
| 「雲端不追蹤中間態」 | board 的 `in_progress`/`in_review` 就是中間態，字面執行等於否定 board | **頻率／離散性判據**：雲端可持有「每個 task 生命週期內變更次數為個位數、且每次變更都是一個離散顯式事件」的狀態；不得持有「隨執行連續變化」的狀態（工作區、上下文、逐輪產物、runtime session） |
| 「雲端只驗簽名封套，不看過程」 | board 必須存 title/channel 才能給人看 | **區分存取與推導**：雲端可按生產者給定的鍵做精確匹配與排序（channel、status、seq、hash），可原樣存取有界標籤；不得對任何內容做語義推導（相關性、摘要、合併、分類） |

「任務狀態機權威在本機 daemon」這條不改，但它管的是**哪個**狀態機必須說清楚——見 §1 的雙狀態機劃分。

---

## 1. 平台定位：一個品牌傘、兩條產品線、兩個狀態機、兩個權威

```
byok-sdk monorepo
├── K 線（key 管理，bring-your-own-key）
│   └── @byok-sdk/keys                ← K0/K1 已 merge，K2 已過閘待 ship
│       安全模型：主動管理使用者的 provider API key（OS Keychain/Credential Manager）
│
└── C 線（agent 調度，bring-your-own-agent）
    ├── @byok/protocol            ← 現有，wire v1 FROZEN
    ├── @byok/core                ← 新增（P0），契約層，zod-only，protocol-free
    ├── @byok/cloud               ← 新增（P1），無狀態 handler + SQL/R2 實現
    ├── @byok/server              ← 現有，降級為自託管可選 coordinator
    └── @byok/client              ← 現有，本機 daemon + RuntimeAdapter
        安全模型：credential-isolation——絕不接觸任何憑證（M5 audit 承諾）
```

```
使用者宿主機（執行權威）                        雲端（協調權威，無狀態請求/響應）
┌──────────────────────────────┐            ┌────────────────────────────────┐
│ @byok/client daemon          │            │ @byok/cloud (Workers / Node)   │
│  ├ 執行狀態機（wire 7 態）    │            │  ├ board  task 5 態      (SQL) │
│  │   Offered…Running…Completed│◀─offer─────│  ├ 信箱   outbox         (SQL) │
│  ├ 工作區 / 上下文 / 產物     │──terminal──▶│  ├ 真相層 attested_rec(SQL+R2)│
│  ├ 過濾/蒸餾                  │──board POST▶│  ├ 提示   presence/activity(TTL)│
│  ├ durable local journal      │◀─SSE/poll──│  └ 零 Durable Object            │
│  └ device key (Ed25519)      │            │                                │
└──────────────────────────────┘            └────────────────────────────────┘
```

### 1.1 兩個狀態機，三套詞彙，嚴格區隔

命名紀律採 Codex 軌的堅持：**board 5 態 / presence 5 級 / wire 7 態是三套獨立詞彙**，任何一套的名字都不得出現在另外兩套的程式碼、schema、UI 文案裡。

| | 執行狀態機（wire） | board 狀態機（協調） | presence（提示） |
|---|---|---|---|
| 值 | `Offered/Claimed/Running/AwaitApproval/Completed/Failed/Cancelled`（`protocol/task-state.ts`，**凍結**） | `todo/in_progress/in_review/done/closed`（`@byok/core`，新增） | `online/thinking/working/error/offline`（TTL，非狀態機） |
| 對象 | 一次執行嘗試 | 一個工作項的人類可見生命週期 | 一台設備的在線度 |
| 權威 | **本機 daemon** | **雲端**（人、多設備、多方都要改它，沒有任何單一 daemon 能擁有它） | 無權威，過期即不存在 |
| 變更頻率 | 一次任務內連續變化 | 一次任務內個位數次，每次都是離散顯式 POST | 高頻，有損 |
| 儲存 | 本機 journal | 雲端 `task` 表 | 雲端 TTL 表 |

提示層**不得沿用 `TaskState` 命名**（Codex D2 的明確要求）：前端看到 `terminal = null, presence = null` 時只能顯示「尚無最新裝置提示」，不得合成 `Running` 或 `Failed`。

### 1.2 數據四分類與儲存對位

| 類別 | 內容 | 儲存 | 生命週期 | 丟失後果 |
|---|---|---|---|---|
| board 協調層 | task 5 態、assignee、channel、標題 | SQL `task` | 永久 | 不可接受 |
| 真相層 | profile、memory、終態上下文 | SQL 行（metadata+簽名）+ R2 物件 | 永久，rev 遞增 | 不可接受，需備份 |
| 信箱 | 待領的 server→daemon envelope | SQL `outbox` | 游標推過即刪 | 可接受 |
| 提示（兩級） | 設備在線度 5 級 / 活動軌跡（有損） | SQL，`expires_at` TTL | 分鐘級 | 完全可接受 |

### 1.3 鐵律

1. **兩線互不依賴**：`client`/`server`/`protocol`/`cloud` 不得 import `keys`；`keys` 也不得 import `protocol`（`core` 因此必須 protocol-free，見 §3）。邊界已寫入 `docs/security.md:596-610`。
2. **雲端不做語義推導**：可精確匹配與排序生產者給定的鍵、可原樣存取有界標籤；不得排序相關性、摘要、合併、分類。
3. **雲端不持有連續態**：判據是「每 task 變更次數個位數 + 每次都是離散顯式事件」。工作區、上下文、逐輪產物、runtime session 一律在本機。**雲端無執行狀態機。**
4. **wire v1 零改動**：不新增任何 message type、不改任何 `http-api.ts` schema。`golden/v1.frozen.json` 在整條 P 線裡一個 byte 都不動——機檢條件是 `git diff --exit-code packages/protocol/src/__tests__/golden/`。board 與 device proof 都是 wire 外層的 HTTP 面。
5. **終態不可覆寫**：`terminal_records` immutable，同 `taskId` 不同 terminal hash 回 `409 terminal_conflict`，不覆寫第一份真相。
6. **租戶隔離是結構性的，不是紀律**：漏一個 handler 也洩漏不了（§8）。

---

## 2. 現狀對位（實地複核）

| 模組 | 現狀 | v2 處置 |
|---|---|---|
| `@byok/protocol` | transport-agnostic，wire v1 FROZEN（`version.ts:1-25`），freeze-guard 三層網（`__tests__/freeze-guard.test.ts:47-83,180-234,239-300,259-261,518-521`） | **原樣不動**。`@byok/cloud` import 它解析 `EventsPollResponse`/`MessagesSendRequest`（`http-api.ts:115-125,147-165`） |
| `TASK_TRANSITIONS` | 凍結的 7 態執行狀態機 | 原樣。board 5 態是**另一個常數、另一個包**，永不合併 |
| `codec` | 只處理 `string \| Uint8Array` 與單行 NDJSON，無 transport-specific API（`codec.ts:9-60`） | 原樣。信箱內容物 byte-for-byte v1 envelope |
| `TaskStore` | 介面全同步（`task-store.ts:46-94`），hub 內 29 個調用點（`grep -c "this.taskStore\." packages/server/src/hub.ts` = 29） | **不做 async 遷移**，按作用域退場，留在 `@byok/server` 自託管域，見 §3.3 |
| `BlobStore` | 已 async、已抽象（`blob-store.ts:36-49`，註解本就把 S3/GCS/R2 presigned 當替換點 `:7-20`），凍結的 `sha256:<64hex>` | **搬進 `@byok/core`**，R2/S3 只需新實現，server 側 re-export |
| `ConnectionHub` | 1,689 行，狀態全在進程內 Map（`hub.ts:280-342`，outbox ring 500 / dedup ring 1,024，`:50-54`）；dispatch 同步建 server-side task record（`hub.ts:1335-1379`）；`pollEvents` 用 `setTimeout` 持有 50s（`hub.ts:459-476`、`index.ts:67`） | **降級為自託管可選件**，不進 core、不重寫、不分散式化 |
| `SqliteTaskStore` | 綁 `node:sqlite` `DatabaseSync`（`sqlite-task-store.ts:157-218,251-276`），需 Node 22.5+（`sqlite-support.ts:1-30`）；只恢復 task record，明文不承諾 in-flight recovery（`:121-136`） | 留在 server，自託管專用。這證明「換 Postgres」修不了 authority mismatch |
| `DeviceRegistry`/`PairingManager` | 進程內 Map；`DeviceRecord` 無租戶欄位（`auth.ts:76-82`）、`createPairingCode()` 不綁 subject（`pairing.ts:34-42`）、`redeemPairingCode()` 不回身分（`pairing.ts:51-63`）、pair handler 憑空 register（`http.ts:75-97,82-92`） | **T0 立即 breaking cut**，加 required `tenantId`/`productId`，見 §8 |
| `heartbeat.ts` | server 側已有心跳模組 | presence 5 級 + 60s 心跳復用它的節奏，不另造 |
| `progress-batcher.ts` | client 側已有 progress 批次器 | 活動軌跡的 `dropped` 計數落在這裡，不另造通道 |
| `control-server.ts` | 硬化過的 Unix socket 控制面（symlink/uid 檢查、拒二重 daemon，`:38,170,175`） | 本機唯讀短路 API 加在**這裡**，不開 loopback HTTP 端口 |
| `RateLimiter` | 進程內 token bucket | 雲端換 Workers `ratelimit` binding（2025-09-19 GA）；抽 `RateLimitGate` 注入點 |
| `LongPollClient` | `idleDelayMs` 預設 250ms（`long-poll-transport.ts:83-92,341-351`）；`longPoll.{retryDelayMs,idleDelayMs}` 已由 `create-daemon.ts:743-744` 曝露 | **派工路徑零 client 改動**，改配置即可 |
| `CursorStore` | 游標按 `(serverUrl, deviceId)` 持久化（`cursor-store.ts:27-33`） | 原樣。它就是信箱「領走即棄」的 ack 依據 |
| `device-keys.ts` | Ed25519 生成、PKCS8 存 `device.json` 0600（`:3-16,23-46`、`store.ts:13-16`）；**`signNonce` 直簽 raw nonce，無 domain separation（`:44-45`）** | 確權封套復用同把私鑰，**P4 必須先補 domain separation 前綴**，見 §6.3 |
| `@byok-sdk/keys` | K1 已 merge、K2 已過閘待 ship；deps 只有 zod（`packages/keys/package.json:32-34`）；`SecretStore` 已 Promise-based（`secret-store.ts:25-40`） | K4 之後（P5）才接 core 的 `TruthStore`。K 線不被平台線阻塞 |

---

## 3. D1 — 包拆分粒度與依賴圖

**選型：新增兩包——`@byok/core`（契約層，zod-only，protocol-free）+ `@byok/cloud`（無狀態 handler + SQL/R2 實現）。共 6 個包，不做 package explosion。**

```
@byok/protocol   凍結 wire（zod，neutral）           ← 無依賴
@byok/core       儲存契約 + 確權封套 + board 狀態機   ← 只依賴 zod，且【禁止】依賴 protocol
@byok/cloud      無狀態 handler + SQL/R2 實現         ← protocol + core + hono
@byok/server     Node 自託管可選 coordinator          ← protocol + core（BlobStore）
@byok/client     本機 daemon                          ← protocol + core（封套 + board）
@byok-sdk/keys       key 管理                             ← core（P5 起，僅契約）—— 永不碰 protocol
```

### 3.1 `@byok/core` 的全部內容（只有契約，沒有實現）

- `attestation.ts` — `DeviceProofEnvelopeV1` schema + RFC 8785 正規化 + `verifyDeviceProof`（注入式 verifier）
- `board.ts` — board 5 態 + 合法轉移表 + claim 衝突快照形狀
- `tenant.ts` — `TenantId` 品牌型別 + `DevicePrincipal`/`ControlPlanePrincipal`（§8）
- `record-store.ts` — `TruthStore`（async）
- `mailbox-store.ts` — `MailboxStore`（async，payload 不透明）
- `board-store.ts` / `presence-store.ts` — board 與兩級提示的 async port
- `blob-store.ts` — 從 server 搬過來（已 async，零改動）

所有 port 的第一參數都是 `TenantId`，不存在任何以裸 `deviceId`/`taskId` 查詢的簽名（§8 第一層）。

### 3.2 為何 core 必須 protocol-free

鐵律 1 要求 `keys` 可依賴 core（P5）。若 core 依賴 protocol，`keys → core → protocol` 會在 `pnpm why` 的安裝圖上直接違反鐵律——即使 import 圖乾淨，審計者看到的依賴圖已經髒了。core 也不需要 protocol：信箱契約把 envelope 當**不透明 bytes**加路由 metadata（byte-for-byte v1 envelope，型別驗證在 `@byok/cloud` 這個組合層做）；board 契約裡 `task_id` 只是一個 string。內容盲與 protocol-free 是同一件事的兩面。

board 5 態放 core 而不放 protocol：protocol 是凍結的 wire，board 不上 wire（鐵律 4）；但 board 5 態要被 cloud（強制執行）、client（理解）、SaaS UI（渲染）三方共用，正是 core 的定位。放進去之後 core 仍然 zod-only、仍然 protocol-free。

cloud 獨立成包而非 `@byok/server` 的 subpath：打包目標不同（server 根入口拖著 `node:http` 與 `node:sqlite`）、依賴集不同，決定性的是第三條——本 repo 的安全審計按包寫（`docs/security-review-m5-pilot-entry.md` 針對 M5 的 credential-isolation claim），雲端是全新的公網多租戶攻擊面，塞進已審計包等於稀釋那份審計的邊界。

### 3.3 `TaskStore` 不做 async 遷移（採 Opus 軌，Codex 軌的一次性 breaking cut 被否）

波及面實測：`hub.ts` 29 個 `this.taskStore.*` 調用點、約 20 個同步簽名要傳染成 async、外加 `http.ts:265` 與 `ws-server.ts:141` 兩個調用點、`ByokServer.tasks.get/list` 這個公開同步 API（`index.ts:179-181`）、server 包 23 個測試檔。而這筆改動買不到東西：雲端需要的是 `MailboxStore`/`TruthStore`/`BoardStore`，不是 `TaskStore`；自託管的 ConnectionHub 配 `node:sqlite`（本身同步 API）恰好同步就夠。

改法是**按作用域退場**：

- `TaskStore` 留在 `@byok/server`，語義從「權威」降級為「本地鏡像」（doc-level 降級 + 一條斷言「daemon 上報終態永遠覆蓋鏡像」的測試）。
- 雲端沒有 `TaskStore`。`hub.dispatch()` 的雲端對應物是「board claim 成功 → enqueue offer 進 outbox」，沒有執行態寫入。
- 真要「Node 後端 + Postgres」，那個部署直接跑 `@byok/cloud` 的 handler。一條 async 路徑、一條 sync 路徑，服務兩種部署形態，彼此不是 fallback。

**Deferred（記入 §11）**：「自託管接 Postgres 時再做 `TaskStore` 的 breaking async cut」。觸發條件是有人真的要拿 `@byok/server` 接非同步 SQL；在那之前不預先付這筆傳染成本。Codex 軌對這條 cut 的切法（leaf-first、per-device FIFO promise chain 防 WS callback race、`setPendingApprovalId` 從 optional 改 required）在觸發時直接照用，不重新設計。

### 3.4 被否選項

- **`TaskStore` 全面 async（Codex D1）**：29 調用點 + 20 簽名 + 23 測試檔的傳染，換一個雲端不用的介面；改為按作用域退場 + deferred。
- 把 protocol 併進 core：毀掉凍結包的審計鏈，且讓 keys 傳染 wire 依賴。
- board 狀態機放 protocol：board 不上 wire，放進去等於擴大凍結面。
- `@byok/server/cloud` subpath：把新公網攻擊面塞進已審計包內。
- `@byok/core` 同時容納 dispatch、keys、memory、provider clients：破壞 `docs/security.md:596-610` 的雙安全模型邊界。
- 每個 store 各一 npm package：只有兩種 deployment composition，過早拆包放大 schema migration 與 release coordination。
- 刪除 `@byok/server`：它仍是有價值的自託管 reference 與 integration test harness；正確動作是降級定位。
- `T | Promise<T>` 雙形介面：永久 compatibility path 的起點，且型別上掩蓋 data race。

---

## 4. D2 — 雲端最小接口：信箱 + 真相層 + 兩級提示

### 4.1 分層原則

board 層唯一注入派工層的動作是**把一個 offer 塞進某設備的 outbox**。claim 成功之後，剩下的全走凍結的 wire（`task.offer` → `task.claim` → `task.started` → … → 終態），一個 message type 都不新增。

**board 行是派工記錄的元數據，不是第二個真相源**：`task` 表只存 status／assignee／channel／標題／指標；指令正文在 outbox envelope 或 blob 裡，執行結果在 `attested_record` 裡。board 表不複製其中任何一份。

### 4.2 設備面派工路徑（零新增，全部沿用凍結契約）

| 端點 | 雲端行為 | 現狀對位 |
|---|---|---|
| `POST /byok/pair` | 兌換 pairing code（服務端 claims 攜帶租戶）→ 寫 `device` 行 | `http.ts:75-97` |
| `POST /byok/challenge` / `POST /byok/token` | nonce 寫 `auth_nonce`，Ed25519 驗簽同 `auth.ts:187-197` | `http.ts:99-135` |
| `GET /byok/events?cursor=N` | ① `DELETE FROM outbox WHERE tenant_id=? AND device_id=? AND seq<=N` ② `SELECT … seq>N ORDER BY seq LIMIT k` ③ **立即返回** | `http.ts:206-221` |
| `POST /byok/messages` | 逐條進 dedup；終態 → 寫真相層 + 推 board 到 `in_review`；`task.progress` → 寫 `activity_tail`；其餘丟棄 | `http.ts:255-280` |
| blob 四路由 | R2 presigned PUT/GET 換掉 HMAC 自簽 | `http.ts:151-200`（`:140-149` 註釋：`/content` 兩路由是 presigned capability，非 bearer-authed） |

**「領走即棄」= 「游標推過即刪」，不是「讀到即刪」。** 讀到即刪會直接打斷凍結的 §9 at-least-once——client 的整套 stall 機制（`long-poll-transport.ts:296-335`：驗證失敗就凍結游標、等伺服器重投）建立在「未 ack 的 seq 會被反覆重投」之上。刪除的觸發器是 client 下次帶上來的 `cursor=N`，那才是它的持久化 ack（`cursor-store.ts:27-33`）。

**ack 語義（採 Codex 軌的定義）**：對 `task.offer` 而言「成功處理到可 ack」= v1 bytes 與 local task record 已在同一個**本機** transaction durable append，且工作已交給本機 scheduler；**不是**等 agent 跑到終態。crash 在 append 前由 mailbox redelivery 補回，append 後由 local journal 接管恢復——cursor 不承擔 running-state recovery。這條由 §10 的 crash drill 驗收。

### 4.3 真相層（新增，租戶 + device-proof authed）

| 端點 | 用途 |
|---|---|
| `GET /byok/records?kind=&prefix=` | 回 manifest（key/rev/hash/size/label），**不回 body** |
| `GET /byok/records/:kind/:key` | 回 presigned R2 GET URL，或小 payload 直接 inline |
| `PUT /byok/records/:kind/:key` | body = 確權封套；`expectedRev` CAS，不符回 409 |

`terminal` 寫入只接受 `task.complete`、`task.fail`、`task.cancelled` 三種 frozen v1 envelope 加 opaque context/memory object refs。相同 `requestId + bodyHash` 重送回原結果；同 `taskId` 不同 terminal hash 回 `409 terminal_conflict`，**不覆寫第一份真相**（鐵律 5）。memory candidate 與 terminal record 可放同一 request，SQL transaction 要麼同時 commit memory head + terminal truth，要麼全部不落——沒有「terminal 成功但 memory head 偷跳」的半成功。

### 4.4 提示分兩級，不是一級也不是三級

| 級 | 對象 | 頻率 | 語義 | 儲存 |
|---|---|---|---|---|
| 設備在線度 | per-device | 逐事件推 + 60s 心跳 | 5 級：`online/thinking/working/error/offline` | `device_presence`，TTL |
| 活動軌跡 | per-task | 高頻批量（client 端最多每 2s 一次） | **有損**，帶 `dropped` 顯式計數 | `activity_tail`，TTL，整體覆寫最近 N 條 |

分級理由是作用域不同：在線度是設備級的（一台機器一個值），軌跡是任務級的。合併成一級就必須在同一行裡塞兩種基數，查詢與過期策略會擰巴；分成三級則是重複——第三級已經是 `task.status`。

**提示是 ephemeral、TTL、不簽名、永不進真相層，且不得沿用 `TaskState` 命名。** `task.progress` 的內容流向就是這裡。`dropped` 計數把有損這件事寫進數據，而不是假裝流是完整的；落點是 client 既有的 `progress-batcher.ts`。

### 4.5 本機唯讀短路：加在既有控制面，不開新端口

探針的 `/internal/agent-api`（GET inbox、peek、POST activity 轉發）採納**能力**、否決**傳輸**：byok 已有硬化過的 Unix socket 控制面（`control-server.ts:38,170,175`），比 loopback HTTP 端口嚴格。新增三個唯讀/轉發 RPC 到 `control-protocol.ts` 即可，不開監聽端口。

### 4.6 被否選項

- 雲端保留執行狀態機／一張 `tasks` 表保存 Offered→Running→Complete：製造第二個執行權威，斷線時產生「cloud Running、本機已死」的雙真相，違反鐵律 3。
- 把 `ConnectionHub` maps 換成 Redis／Durable Objects：問題不是 map 不耐久，而是 hub 擁有了不該由 cloud 擁有的 live authority；換 storage 只會固化錯誤邊界。
- pull 即 ack：response 在本機 durable append 前就前進 cursor，造成 crash window 與永久漏件。
- 提示寫入 terminal 表或永久 event log：非權威資料被下游當成 audit truth。
- 提示合併成一級／走 KV：基數不同；KV 最終一致性與秒級輪詢對打。

---

## 5. D3 — board 協調層（採 Opus 軌設計 + Codex 軌命名紀律）

### 5.1 board 狀態機

```
todo ──claim──▶ in_progress ──terminal──▶ in_review ──accept──▶ done ──▶ closed
  │                  │  ▲                     │  │                        ▲
  │                  │  └──unclaim(放回)──────┘  └──reject(打回)──────────┘
  └──────────────────┴────────── close（終止未驗收）──────────────────────┘
```

| 態 | 憑什麼留 |
|---|---|
| `todo` | claim 之前的待領態，board 的入口 |
| `in_progress` | 有人佔著。**每個 task 只寫一次**，符合鐵律 3 的離散判據 |
| `in_review` | 人工驗收閘。與 wire 的 `AwaitApproval` **不是同一件事** |
| `done` | 已驗收 |
| `closed` | 終止未驗收（放棄／被取代／不做）。是 `done` 的兄弟，不是它的後繼 |

**`in_review` 與 `AwaitApproval` 必須分開，這是最容易被實作者踩爛的一條。** `AwaitApproval` 是**執行中暫停**——agent 要用某個工具、進程真的掛在那裡等許可，resolve 後要恢復一個活著的 session，對延遲敏感，走凍結的 `task.approve`/`task.reject` + `approvalId` 定向（`messages.ts:154-185,310-327`）。`in_review` 是**執行後閘門**——跑完了，人決定收不收，沒有任何進程被掛起，不對延遲敏感，走 board 的 status POST。混同的後果很具體：一次執行中的權限彈窗會顯示成「待驗收」，而人在 board 上點「通過」會去 resume 一個早已退出的進程。

`closed` 語義由本方案定義為「終止未驗收」，可從任何非 `done` 態進入。探針未能確認 raft 原意 [unverified]；若證實是歸檔語義，那是命名差異不是結構差異，補一個 `archived_at` 時間戳即可，不加第 6 態。

### 5.2 併發控制：claim 是 holder-snapshot 鎖，status 是 expectedStatus CAS

**claim 是併發鎖不是所有權。** 衝突回 409 + 當前占有者快照（`assignee`/`assignedAt`/`observedAt`），**不回 412**。ETag/version 是給**內容**衝突用的（兩個寫者改同一份正文），claim 是排他指派的 CAS，輸的一方需要知道的是「誰佔著、那是什麼時候觀察到的」，據此決定等、搶還是換路。SQL 上就是 `UPDATE task SET assignee=?, status='in_progress' … WHERE tenant_id=? AND assignee IS NULL RETURNING *`，rowcount 0 就去 SELECT 占有者。**不需要 version 欄位。**

**status 轉移加 `expectedStatus` 前提（本方案在探針之上的增補）。** claim 的 CAS 前提天然是 `assignee IS NULL`，status 轉移沒有這種天然前提；而 board 上人和 daemon 會同時推同一個項目（人打回 `in_progress` 的同時 daemon 剛好報完終態要推 `in_review`）。裸的 last-write-wins 會靜默吃掉一次人工決策。`expectedStatus` 不符回 409 + 現況快照，與真相層 `expectedRev` 同一種 fail-closed 慣用法。

`assignee` 與 `status` 解耦：`done`/`closed` 之外任意態可 claim/unclaim。

### 5.3 同步機制：SSE 優先（能力宣告降級）+ 輪詢兜底

```
GET /byok/board/stream?since=<board_seq>     Accept: text/event-stream
→ ReadableStream，worker 內部迴圈：
   每 5s：  SELECT … WHERE tenant_id=? AND board_seq > cursor ORDER BY board_seq LIMIT 50
            逐行 emit  `id: <board_seq>\ndata: <json>\n\n`，推進 cursor
   每 120s：emit  `event: reconcile`  要求 client 做一次全量列表對賬
   每 3s：  喚醒後快速追趕窗口
   每 15s： emit  `:\n\n` 心跳註釋，防中間層超時斷流
   ※ 每次查詢各自取用/歸還 DB 連線，禁止跨 sleep 持有 transaction
```

參數（5s 常規、120s 全量對賬、3s 喚醒後快速追趕、每輪 limit 50）直接沿用 raft 探針實測值——那是生產調過的量級，沒有理由重新猜。

**為何 SSE 在這裡划算，而 50s long-poll hold 在派工路徑上不划算**（成本結構不同，不是前後矛盾）：

| | 派工 `GET /byok/events`（凍結契約） | board stream（新契約） |
|---|---|---|
| 若不 hold | client 每 2s 一次請求 | client 每 5s 一次請求 |
| 若 hold/串流 | 50s 內部輪 25 次 ≈ 打平 DB，卻多釘住一條連線 | 一條連線攤 10 分鐘：1 次認證 vs 120 次認證 |
| runtime 更新中斷 | hold 到一半被 30s 寬限期砍斷 = 靜默截斷 | 有 `Last-Event-ID`/`since` 語義，斷了就是普通重連 |
| 契約自由度 | 凍結，改不了 | 新增，隨便設計 |

**降級必須是宣告式能力，不是狀態碼嗅探。** 探針顯示 raft 在收到 404/405/501 時降級輪詢；本 repo 的規則禁止 heuristic/best-effort 路徑，照抄嗅探直接違規。改法：雲端在 `GET /byok/capabilities`（或部署配置）明確宣告 `board.sse`，daemon 只在宣告時用 SSE，否則走 `GET /byok/board?since=` 的 5s 輪詢。**兩條路徑都是一等公民、都有測試**，而不是一條主路加一條猜出來的備胎。

**board 增量流不另建事件表。** 每個 `task` 行帶一個 **per-tenant 單調的 `board_seq`**，每次更新重新分配；增量查詢就是 `WHERE tenant_id=? AND board_seq > ?`。board 表本身就是事件源，不存在「日誌與狀態兩份真相」的漂移。代價是同一行在兩次輪詢之間被改兩次時只看得到最新值，而 120s 全量對賬正是補這個洞的網。

**wake-hint 跨網通道砍掉**：無 DO 就無法推送，SSE 串流本身就是那個信號，輪詢模式下 5s 也已經夠短。本機唯讀 peek 保留（§4.5）。

### 5.4 board 與提示面端點（新增，租戶 authed）

| 端點 | 用途 |
|---|---|
| `GET /byok/capabilities` | 宣告 `board.sse` 等能力；降級由此決定，不靠嗅探 |
| `GET /byok/board?channel=&status=&since=&limit=50` | 列表 / 增量 / 120s 全量對賬 |
| `GET /byok/board/stream?since=` | SSE（僅在能力宣告時使用） |
| `POST /byok/board/:taskId/claim` | `{deviceId}` → 200 task ｜ 409 `{holder:{assignee,assignedAt,observedAt}}` |
| `POST /byok/board/:taskId/unclaim` | `done`/`closed` 之外任意態可用 |
| `POST /byok/board/:taskId/status` | `{to, expectedStatus}` → 200 ｜ 409 現況快照 |
| `POST /byok/activity` | `{taskId, events[], dropped}` 批量有損 |
| `PUT /byok/presence` | `{level, detail}` 5 級 + 60s 心跳 |
| `POST /byok/admin/pairing-codes` | control-plane authed，`{tenantId, productId, ttlMs?}` → `{code, expiresAt}`（§8） |

board status 是租戶 authed 的普通寫入，**不走 device proof 簽名**——它的作者往往是人，不是設備。只有真相層記錄是 device-signed。這條要寫明，否則實作者會以為雲端所有寫入都帶簽名。

### 5.5 表結構草案（落 `deploy/sql/`，走既有 `check:deploy-sql` 順序檢查）

租戶欄位命名已由 §8 正名為 `tenant_id`（Opus 原稿的 `subject_id` 全部替換），全表 tenant 前綴複合主鍵。

```sql
-- 設備註冊（取代進程內 DeviceRegistry）
CREATE TABLE device (
  tenant_id   TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  device_name TEXT NOT NULL,
  public_key  TEXT NOT NULL,              -- Ed25519 base64url（JWK x 形式）
  key_id      TEXT NOT NULL,
  key_epoch   BIGINT NOT NULL DEFAULT 1,
  revoked     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, device_id, key_id)
);
-- 不建任何裸 device_id 的 unique 索引

CREATE TABLE pairing_code (
  code_hash  TEXT PRIMARY KEY,            -- sha256(code)，庫洩不露活碼
  tenant_id  TEXT NOT NULL,
  product_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

CREATE TABLE auth_nonce (
  nonce      TEXT PRIMARY KEY,            -- ≥128-bit 服務端隨機 capability
  tenant_id  TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false
);

-- board：派工記錄 + 元數據。不存指令正文、不存結果、不存產物
CREATE TABLE task (
  tenant_id       TEXT   NOT NULL,
  task_id         TEXT   NOT NULL,        -- 與 wire task_id 同一個 id
  channel         TEXT   NOT NULL,        -- 檢視過濾器，非安全邊界（扁平清單，無列/泳道）
  status          TEXT   NOT NULL,        -- todo|in_progress|in_review|done|closed
  assignee        TEXT,                   -- device_id 或 user id；與 status 解耦
  assigned_at     TIMESTAMPTZ,
  title           TEXT   NOT NULL,        -- 有界標籤，原樣存取，雲端不推導
  instruction_ref TEXT,                   -- blob/R2 指標
  board_seq       BIGINT NOT NULL,        -- 每 tenant 單調；SSE/輪詢的游標
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id)
);
CREATE INDEX task_board_seq ON task (tenant_id, board_seq);
CREATE INDEX task_channel   ON task (tenant_id, channel, status);

CREATE TABLE tenant_stream (
  tenant_id      TEXT PRIMARY KEY,
  next_board_seq BIGINT NOT NULL DEFAULT 1
);
-- 分配：UPDATE tenant_stream SET next_board_seq = next_board_seq + 1
--       WHERE tenant_id = $1 RETURNING next_board_seq - 1;   （Postgres/D1 皆原子）

-- 信箱：待領事件。游標推過即刪
CREATE TABLE outbox (
  tenant_id  TEXT   NOT NULL,
  device_id  TEXT   NOT NULL,
  seq        BIGINT NOT NULL,
  task_id    TEXT,
  type       TEXT   NOT NULL,             -- 僅供運維查詢，雲端不據此分支
  envelope   JSONB  NOT NULL,             -- 原樣 v1 envelope，不解讀
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, device_id, seq)
);

CREATE TABLE device_stream (
  tenant_id TEXT   NOT NULL,
  device_id TEXT   NOT NULL,
  next_seq  BIGINT NOT NULL DEFAULT 1,
  acked_seq BIGINT NOT NULL DEFAULT 0,
  seen_at   TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, device_id)
);

-- 入站冪等窗口（wire §9），取代 hub 的 dedupRings
CREATE TABLE inbound_dedup (
  tenant_id   TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, device_id, envelope_id)
);
-- 判重：INSERT … ON CONFLICT DO NOTHING，rowcount = 0 即 duplicate

-- device proof 冪等收據（replay + idempotency ledger）
CREATE TABLE device_request_receipts (
  tenant_id   TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  operation   TEXT NOT NULL,
  resource    TEXT NOT NULL,
  body_hash   TEXT NOT NULL,
  key_id      TEXT NOT NULL,
  key_epoch   BIGINT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, device_id, request_id)
);

-- 真相層：終態上下文 + profile + memory，一張表按 kind 區分
CREATE TABLE attested_record (
  tenant_id      TEXT   NOT NULL,
  kind           TEXT   NOT NULL,         -- 'task.terminal' | 'profile' | 'memory'
  record_key     TEXT   NOT NULL,
  rev            BIGINT NOT NULL,
  device_id      TEXT   NOT NULL,
  payload_hash   TEXT   NOT NULL,         -- sha256:<64 hex>，沿用凍結的 CONTENT_HASH_RE
  payload_size   BIGINT NOT NULL,
  content_type   TEXT   NOT NULL,
  payload_ref    TEXT,                    -- R2 key（大 payload）
  payload_inline JSONB,                   -- 小 payload 內聯
  proof_ref      TEXT   NOT NULL,         -- device_request_receipts 指標
  signed_at      TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, record_key, rev)
);
CREATE INDEX attested_latest ON attested_record (tenant_id, kind, record_key, rev DESC);

-- 提示一級：設備在線度，5 級 + 心跳，TTL
CREATE TABLE device_presence (
  tenant_id  TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  level      TEXT NOT NULL,               -- online|thinking|working|error|offline
  detail     TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, device_id)
);

-- 提示二級：活動軌跡，per-task、有損、TTL
CREATE TABLE activity_tail (
  tenant_id  TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  events     JSONB  NOT NULL,             -- 最近 N 條，整體覆寫
  dropped    BIGINT NOT NULL DEFAULT 0,   -- 有損程度顯式可見
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, task_id)
);
```

大型 instruction、artifact、profile、memory 與 final context 放 S3/R2；SQL 只放可交易的索引、hash、rev、proof 與 object key。object key 採 content-addressed `sha256/<hex>`，寫入前先驗 size/hash；terminal/memory transaction 只引用已存在物件。

**一個必須寫進文件的行為差異**：進程內 outbox 是容量有界的 ring（滿了丟最舊，`hub.ts:50-54`），SQL outbox 是時間有界的保留窗口。設備長期離線後回來拿到什麼，兩者表現不同，運維語義要明說。

### 5.6 被否選項

- board 增量另建事件表：日誌與狀態兩份真相，正是探針第一條原則反對的形狀。
- claim 衝突回 412 / 加 version 欄位：ETag/version 是給內容衝突用的；輸的一方需要 holder 快照而不是一個裸的 412。
- 只在 claim 做 CAS、status 裸 last-write-wins（探針原形狀）：會靜默吃掉人工決策。
- 狀態碼嗅探降級：本 repo 明禁 heuristic 路徑。
- 派工路徑也改 SSE：凍結契約動不了，且它替換的輪詢密度低，攤不回來。
- 跨網 wake-hint 通道：無 DO 無法推送，SSE 本身即該信號。

---

## 6. D4 — 上行確權：`DeviceProofEnvelopeV1`（採 Codex 軌全 schema）

### 6.1 選型

detached HTTP-layer proof，放 `X-BYOK-Device-Proof` header（base64url 編碼 JSON），request body 保持自己的 DTO。schema 照抄 Codex 軌 §6：

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

**驗證順序固定**：schema/size → method/path/query/body hash → device/key/epoch/entitlement binding（租戶前綴複合鍵查找，§8.4）→ issued/expiry（容許最多 **60 秒** clock skew）→ Ed25519 signature → `requestId` unique insert → 業務 transaction。任何一步失敗即拒絕，**不推導 tenant、scope 或替代 body hash**。

`requestId` 同時解決 replay 與 write idempotency：相同 `requestId + bodyHash` 回原結果；相同 `requestId` 不同 hash fail-closed。收據鍵 `(tenant_id, device_id, request_id)`。

### 6.2 與 wire v1 的關係

- proof **不進** `EnvelopeSchema`，不新增 `task.*` message，不改任何 frozen payload。
- 信箱 entry 的內層仍是 byte-for-byte v1 envelope；proof 綁定 pull/ack HTTP request，而不是重簽或改寫每個 envelope。
- terminal write 的 body 內嵌原始 v1 terminal envelope 與 context refs；proof 的 `bodySha256` 綁定完整 body。
- 這沿用 repo 既有 seam：auth/blob/long-poll HTTP bodies 本來就明示是 wire envelope 外的 contract（`http-api.ts:5-15`）。proof schema 放 `@byok/core`，**不加到 `@byok/protocol` frozen golden**。
- proof 封套自己也要凍結：P4 落地時建 `packages/core/src/__tests__/golden/device-proof-v1.golden.json`，鎖住 canonical bytes 的逐字節形狀。簽名格式一旦在生產環境簽過就不能靜默改。

### 6.3 前置修正：`signNonce` 補 domain separation（P4 必做）

既有 token renewal **直接簽 raw nonce，無任何前綴**（`device-keys.ts:44-45`）。同一把私鑰要簽第二種訊息（device proof）時，兩邊都無域分隔就打開了跨協議簽名重用的口子。今天實際風險低（nonce 是 24 隨機 bytes 的 base64url，形狀上撞不到帶前綴的 canonical JSON，`auth.ts:155`），但新路徑沒理由把缺口擴大。

**動作**：新路徑用 `BYOK-DEVICE-PROOF-V1\n`；同時給既有 nonce 簽名補上 `byok-nonce-v1\n` 前綴（另一條同源前綴 `byok-attest-v1\n` 保留給真相層 record 級簽名，若最終啟用）。這是一次 breaking 的 pair/token 變更，**必須在 device proof 上線前或同 PR 內兩側同步落地**——四包 `0.0.1` 未發 npm，breaking 免費（§13）。

### 6.4 被否選項

- 把 `signature`/`keyId` 加進 frozen v1 Envelope：污染既有 message golden，且把 transport auth 與 task semantics 綁死。
- 只沿用一小時 JWT、不簽 request body：bearer token 只證明 token possession，不能為 terminal/context bytes 提供 device-level provenance。
- 每次 write 先向 server 取 challenge：多一個 round trip，server-issued nonce 不比 client requestId + SQL unique receipt 提供更強的 resource binding。
- server 依 access token 自動補 tenant/product/scope：漏簽欄位成為隱含 authority；protected claims 必須完整，server 只做等值檢查。
- 固定順序拼接取代 RFC 8785（Opus 軌原提案）：proof 的 protected 段有巢狀結構且要跨 Node/Workers 兩個 runtime 完全一致，JCS 的邊角成本低於自訂拼接的實作分歧風險。
- 按 kind 分三種封套：把內容感知推進雲端。
- 簽名覆蓋整個 payload：大上下文必須全量過雲端才能驗簽，R2 直傳的意義消失（保留 Opus 軌的 hash-binding 設計：簽名覆蓋 header，payload 完整性由 `bodySha256` 傳遞）。

---

## 7. D5 — memory 讀寫模式（採 Opus 軌 key-granular 快照 + rev CAS）

### 7.1 選型

**起工拉 manifest、按需取 body；收工按 key 寫整份快照；用 key 粒度換增量，不做 delta 鏈。**

**讀（起工）** — `task.claim` 之後，daemon `GET /byok/records?kind=memory` 拿 manifest（key/rev/hash/size/label，**無 body**），本機選擇器決定要哪幾條，再逐條取 presigned R2 URL 拉 body、逐一驗 hash。過濾後的 context 才交給 runtime；原始 cloud memory 不直接進 agent prompt。這是唯一能讓雲端保持不推導的形狀——雲端若要做相關性排序就必須理解內容，直接撞鐵律 2。

**寫（收工）** — 只在終態寫，每個 memory key 是一份自包含的完整快照，新版本 `rev+1` **整體替換**，**雲端永不合併**。三個理由疊起來：合併需要語義推導（禁止）；delta 鏈需要雲端持有可重放的中間態（禁止）；快照的簽名驗證是一次性的，delta 鏈的驗證要沿鏈往回追到創世。

**「增量還是快照」的答案是：快照，增量性由 key 粒度提供。** 要細粒度就把 memory 切成多把小 key，各自快照。這把增量需求從編碼層挪到命名層，代價是 key 設計要想清楚，收益是雲端零合併邏輯。

**衝突** — `PUT` 帶 `expectedRev`，不符回 409，daemon 重拉 manifest 後在本機重新決定。fail-closed，無伺服器端合併、無 last-write-wins。一機一租戶時幾乎撞不到，多機共用租戶時這是唯一的正確性閘門。

**與本機過濾的分工** — 蒸餾/過濾歸 `@byok/client` 的新 seam（`ContextPolicy`/`MemorySelector`），不進 core、不進 cloud。雲端在整條鏈上只看見三樣東西：manifest 的 metadata、presigned body 的取放、簽名快照的落庫。

**中途想看「它在幹嘛」** — 那是 `activity_tail` 與 `device_presence`，不是 memory。TTL、有損、不簽名、永不進真相層。

### 7.2 升級路徑（Codex 軌 delta 鏈記為 deferred）

Codex 軌的「增量 commit 為真相 + 每 32 deltas / 8 MiB 生成 snapshot」設計不採納為 v2 起點，但記為明確的升級路徑。**revisit trigger（滿足任一即重開此決策）**：

1. 單一 memory key 的快照體積穩定超過 **1 MiB**（整份替換的頻寬成本開始壓過 key 拆分的收益）；
2. `expectedRev` CAS 的**衝突率顯著**（多機共用租戶成為常態部署形態）。

觸發後照 Codex 軌 §7 的 delta/snapshot 規則實作，屆時 memory 契約做一次 breaking 升版——不在 v2 預先建雙路徑。

### 7.3 被否選項

- 全量快照拉取（不走 manifest）：浪費頻寬，且恰好在該過濾的那一刻放棄過濾。
- 雲端做 embedding/相關性檢索：違反鐵律 2，且把蒸餾的所有權從本機搬走。
- **增量 delta 寫回為 v2 起點（Codex D4）**：雲端要存重放鏈，簽名驗證退化成鏈式；降為升級路徑。
- 只存無限 append log、永不 snapshot：起工 replay 時間與 object GET 數量線性成長。
- 中途串流寫回 memory：transient reasoning 與未確認內容變成持久真相，鐵律 3 破。
- 伺服器端語義 merge／摘要／敏感資料過濾：越過本機過濾邊界。

---

## 8. D6 — 租戶隔離（全案採 `tenant-isolation-decision.md`）

完整方案見附件 `docs/researches/tenant-isolation-decision.md`；該文檔 supersedes 兩份 proposal 中關於租戶的分散表述（Opus §8 R1、Codex §6 的 tenant 段）。核心結論收進正文如下。

### 8.1 正規身分模型

| 識別子 | 語義 | 簽發方 | 隔離中的角色 |
|---|---|---|---|
| `tenant_id` | 宿主 SaaS 的帳戶/組織單位 | 宿主 control plane（mint pairing code 時） | **唯一的安全隔離邊界**。所有表的分區前綴、所有 principal 的必備欄位、board 可見性的邊界 |
| `product_id` | 哪個宿主產品整合（wire `conn.hello` 已有此欄） | 同上 | audience 維度：綁進 device 行、proof claims 攜帶、等值檢查。**不是**可見性邊界 |
| `device_id` | 租戶成員身分，伺服器 pair 時生成（`ids.ts:15-17`） | `POST /byok/pair` handler | 恰屬一個 `(tenant, product)` |
| `scope_id` | 租戶內真相層鍵空間分區 | 宿主產品語義 | **不是安全邊界**。fail-closed 的地板永遠是 tenant |

Opus 原稿的 `subject_id` 全部正名為 `tenant_id`；attestation 封套的 `subject` 欄位同樣正名，與 proof claims 一致——一個概念一個名字，落庫欄位、封套欄位、型別全用它。

### 8.2 pairing 綁定：服務端 claims，DTO 零改動

宿主 control plane 簽發 pairing code 時綁定 claims `{tenantId, productId}`；**設備永不自報租戶**。`PairRequest` DTO 零改動是硬約束——`PairRequestSchema` 在凍結指紋的 `httpApiSchemas` 區塊內（`freeze-guard.test.ts:218-232`），任何欄位增減都會漂 golden，違反鐵律 4。code 的 mint 面本來就不在凍結面上（`http-api.ts:18-22` 註釋明寫 code 是 out-of-band、由 SaaS 自己的 auth/device-flow UI mint）。

```ts
export interface PairingCodeClaims { tenantId: string; productId: string; }
createPairingCode(claims: PairingCodeClaims, opts?: CreatePairingCodeOptions): PairingCodeInfo;
redeemPairingCode(code: string): PairingCodeClaims;   // 無效即拋
```

雲端 redeem + device insert 必須在同一 SQL transaction。code 熵：自託管保留 8 字 × 32 字母表 = 40 bits（`ids.ts:4-13`）；雲端公網 redemption 固定 `codeLength: 12`（60 bits）+ per-IP/全域率限（Workers `ratelimit` binding）+ DB 只存 `sha256(code)`。

### 8.3 `DeviceRecord`：required、無預設、「無租戶」不可表達

```ts
export interface DeviceRecord {
  deviceId: string;
  tenantId: string;      // required, non-empty，無預設
  productId: string;     // required
  deviceName: string;
  devicePublicKey: string;
  revoked: boolean;
}
```

**單租戶 = 恰好一個、顯式命名的租戶**，不是「無租戶」。SDK 不提供 `'default'` 之類的預設——預設值就是隱式全域租戶，嵌入方漏傳即靜默共池。「無租戶」在型別層不可表達（non-optional）、在邊界層被 zod non-empty 拒絕、在 SQL 層被 `NOT NULL` 拒絕。

遷移成本為零：四包皆 `0.0.1` 未發 npm（breaking 免費）；`DeviceRegistry` 純進程內 Map、從不持久化，**不存在任何存量 device 資料要遷**。附帶硬化：`conn.hello.productId` 等值檢查（今天 `hub.ts` 完全不讀它，grep 零命中），純伺服器端行為，wire 零改動。

### 8.4 enforcement：四層結構性強制

驗收標準是**漏一個 handler 也洩漏不了**。逐 handler 手寫 `WHERE tenant_id=?` 是紀律不是結構——否選。

1. **代碼層（主保證）**：`TenantId` 品牌型別，**鑄造點唯一**（只有 auth 層能把 string 升格）；core 所有 store port 第一參數是 `TenantId`，不存在裸鍵方法；`@byok/cloud` 的 auth middleware 驗出 principal 後構造 `TenantStores`——租戶已閉包進去的 facade，handler 只拿得到它。不是「應該檢查」，是「無法不檢查」。
2. **數據層**：全表 `tenant_id` 前綴複合主鍵；查找鍵要麼以 `tenant_id` 開頭，要麼本身是 ≥128-bit 服務端隨機 capability（nonce、blobId、presigned sig）且行內仍攜帶 `tenant_id`。**不建任何裸 `device_id`/`task_id` 的 unique 索引**——想繞過租戶查詢，schema 層就沒有索引可走。Postgres RLS 是 additive 硬化，**不是**被依賴的主機制（D1 無 RLS，主保證必須可移植）。
3. **測試層**：路由註冊表窮舉矩陣，新增 handler 未入矩陣 → 測試自身失敗（I1）。
4. **proof 閉環**：`claims.tenantId` 是**查找鍵，不是可信輸入**——`WHERE tenant_id = :claims.tenantId AND device_id = :claims.deviceId AND key_id = :proof.keyId AND status='active'`，查無此行即 401。等值檢查是查找的構造性結果，不是可漏寫的第二步。401 統一措辭，不區分 unknown/wrong-tenant/revoked，避免租戶存在性 oracle。

principal 兩型：`DevicePrincipal { tenantId, productId, deviceId }`（租戶來源 = DB device 行）與 `ControlPlanePrincipal { tenantId }`（宿主後端被信任為本部署全租戶的權威——它本來就是 mint code、渲染 board UI、代表人寫 board status 的一方）。

**rotation 租戶不可變**：key rotation 以現行有效 key 簽 proof 註冊新 key，`keyEpoch+1`，舊 epoch 立即失效；旋轉發生在同一 `(tenant_id, device_id)` 行族之內，**不存在任何能更新 `tenant_id` 的操作**（store port 不暴露、應用層無此 UPDATE、測試斷言）。re-pair 不延續租戶綁定，由新 code 的 claims 重新建立。

### 8.5 測試面 I1-I9：P1 入口閘

| # | 測試 | 斷言 |
|---|---|---|
| I1 | 跨租戶路由窮舉矩陣 | 迭代 router 全部已註冊路由；tenant B principal 打 tenant A 的每種資源 → 一律 401/404、零行；存在未分類路由 → 測試自身失敗 |
| I2 | pairing 跨租戶 | A 的 code 兌換 → 設備落 A 且僅 A；二次兌換 401；過期 401；無 claims 無法 mint |
| I3 | proof 租戶不符 | 合法簽名 + `claims.tenantId = B`（設備屬 A）→ 401；簽後篡改 → 簽名敗；requestId 重放 → 冪等原結果/409；skew > 60s → 拒 |
| I4 | store conformance 跨租戶不變式 | T1 寫入、以 T2 讀 → empty；port 無可變更 tenant_id 的方法；InMemory 與 SQL 跑同一套件 |
| I5 | bearer 交叉驗證 | token `claims.tenantId` 與 registry 行不符 → 401；registry 為權威 |
| I6 | board_seq 隔離 | 併發雙租戶寫入下，A 的 SSE/輪詢流永不出現 B 的行；per-tenant 序列互不推進 |
| I7 | 鑄造點唯一 | `as TenantId` 只出現在 auth 模組與測試 fixture；store port 簽名全部 tenant-first |
| I8 | golden 零漂 | `git diff --exit-code packages/protocol/src/__tests__/golden/` + freeze-guard 全綠 |
| I9 | productId 等值 | `conn.hello.productId` 與 device 行不符 → 拒連 |

### 8.6 遷移步驟 T0-T4

| 步 | 時點 | 內容 | 驗證 |
|---|---|---|---|
| **T0** | **即刻**，先於 P 線任何資料落庫 | `@byok/server` breaking cut：`DeviceRecord` + tenantId/productId、`PairingCodeClaims`、redeem 回傳 claims、pair handler 佈線、`AccessTokenClaims` + tenantId、`authenticateBearer` → `AuthenticatedDevice`、`index.ts` 公開 API、conn.hello productId 檢查、examples 與測試更新 | typecheck/test/build；I2/I5/I8/I9 |
| **T1** | P0（core 契約包） | `TenantId` 品牌、Principal 型別、store port 全部 tenant-first 簽名 | I7；core 無 protocol 依賴斷言 |
| **T2** | **P1 入口閘** | cloud auth middleware（proof + control-plane）→ `TenantStores` facade；隨第一條路由建立 I1 矩陣骨架；control-plane mint 端點 | I1/I3 |
| **T3** | P2（SQL） | 全表 tenant 前綴 PK migration（`deploy/sql/`）；`pairing_code` 表；conformance 跨租戶不變式；Postgres RLS 作可選硬化 | I4；`check:deploy-sql` |
| **T4** | P3（board） | board/presence/activity 路由自動入 I1 矩陣；join 審計事件；board_seq 隔離 | I1 擴展、I6 |
| 文檔 | 隨 K3 的 `docs/security.md` 編輯窗 | 多租戶邊界節：三層結構、control-plane 信任模型、pairing 轉交攻擊殘餘風險 | review |

回滾：T0 無存量資料，revert commit 即回；T1-T4 皆為新增包/新增表，刪除即回。**整條路徑不需要任何資料遷移腳本。**

### 8.7 被否選項

- tenantId 進 `PairRequest` DTO（設備自報租戶）：雙重否——漂凍結指紋，且信任客戶端斷言自己的安全邊界。
- optional tenantId + 預設 `'default'`：隱式全域租戶，漏傳即靜默共池。
- 逐 handler 手寫 `WHERE tenant_id=?`：紀律不是結構。
- 只靠 Postgres RLS 作主機制：D1 無 RLS，雲端主線不可移植。
- JWT/proof claims 直接作租戶權威：claims 是斷言，DB 行是權威。
- 保留裸 `device_id` 索引反查：留下裸索引就留下繞過面。
- `scope_id` 升格為安全邊界：v2 過度設計，tenant 是地板。
- pairing pending-confirm 閘：宿主本來就掌握 mint→顯示→撤銷全鏈，SDK 提供 join 審計事件即可。
- 雲端另發一套與自託管不同的 `DeviceRecord`：兩份真相。

---

## 9. 里程碑總排序

### 9.1 K 線狀態（2026-08-05）

| 里程碑 | 狀態 |
|---|---|
| K0 骨架 / K1 SecretStore | **已 merge（PR #11）** |
| K2 Registry + ProfileStore | **已過閘，待 ship** |
| K3 設置頁 server 取捨 + `docs/security.md` 編輯 | 待做 |
| K4 回接 aip-main-open（跨 repo，需協調） | 待做 |

K2 的 `ProfileStore` 從第一版就是 async（`@byok-sdk/keys` 的 `SecretStore` 已是 Promise-based，`secret-store.ts:25-40`），**不照抄今天同步的 server `TaskStore` signature**——如此 K 線無需等待任何 server 側遷移，也不會二次 breaking。**keys 線不中斷，不被平台線阻塞。**

### 9.2 完整時序

| 序 | 里程碑 | 內容 | 前置閘 / 驗證面 |
|---|---|---|---|
| — | **T0** | 租戶 breaking cut（§8.6） | 即刻可做，先於 P 線任何資料落庫 |
| 1 | **K2 ship** | 已過閘 | — |
| 2 | **K3 ∥ P0** | K3 設置頁取捨 + security docs；**P0** 建 `@byok/core`（契約檔案，零實現，不改任何既有包） | P0 純加性可並行。驗證：`pnpm -r typecheck/test/build` 綠；新測試斷言 core 的 `package.json` 無 `@byok/protocol`、原始碼無 `node:` import；`golden/v1.frozen.json` 未變 |
| 3 | **K4** | 回接 aip-main-open、發佈、AiphaBee swap | **獨立閉環，不綁平台線**。aip-main-open 的 `apps/local-agent/src/settings.test.ts` 原樣通過為唯一 parity authority |
| 4 | **P1** | `@byok/cloud`：無狀態派工 handler + 信箱-journal-終態端到端 + store 的 in-memory 參考實現 | **前置閘：T0-T4 的 T0/T1/T2 + I1-I9 全綠**。關鍵測試：既有 daemon 在 long-poll 模式、`longPoll.idleDelayMs=1500` 下跑通全套整合測試，**client 零改動**。**crash drill**：在 local journal append 前／後、mailbox ack 前／後各注入 crash，證明不漏件且不需要 cloud running record |
| 5 | **P2** | SQL（Postgres/Hyperdrive + D1）與 R2/S3 實現；`deploy/sql/` migration | store conformance 套件同一份測試跑四種 composition（§10）；`check:deploy-sql` 過；T3 |
| 6 | **P3** | board 層：5 態 + claim CAS + `expectedStatus` CAS + `board_seq` 增量 + SSE/輪詢雙路徑 + 兩級提示 | claim 併發測試；SSE 與輪詢兩條路徑跑同一份行為測試；120s 對賬能修復人為製造的漏事件；T4、I6 |
| 7 | **P4** | client 側 device proof 上行 + memory manifest/selector seam + **`signNonce` domain separation 修復** | `device-proof-v1.golden.json` 凍結 canonical bytes；pair/token 的 breaking 變更在同一 PR 內兩側同步 |
| 8 | **P5** | `@byok-sdk/keys` 的 profile 持久化接上 core 的 `TruthStore` | 掛在 K4 之後。keys 依賴圖仍不含 protocol；aip-main-open 黃金測試原樣通過 |
| 儲備 | C1-C3 | v1 的 doctor/logs/setup、channel/upgrade/rollback、退避/watchdog/併發閘 | 排在 P3 之後 |

### 9.3 時序理由

- **T0 即刻**：租戶欄位一旦有資料落庫再加就是真遷移；現在 registry 純進程內，breaking 免費。
- **P0 純加性**、不碰共享檔案，可與 K3 並行。P1 起要等 K3，因為 K3 要編輯 `docs/security.md`，而雲端安全模型那節也要寫進同一份文件。
- **K4 獨立閉環、不綁平台線**：K4 是跨 repo 且需對方配合的協調閘，會浮動；merge unit、changelog、release tag 與驗收證據完全分開。P0/P1 可在等待窗口內平行推進。
- **board（P3）排在 SQL（P2）之後**：board 的正確性全押在 SQL 語義上（per-tenant 單調序列、claim 的 `WHERE assignee IS NULL` CAS、`expectedStatus` CAS），in-memory 版本能假裝這些都對，然後在真 SQL 上翻車。
- **v1 的 C1（doctor/logs/setup）從第 3 順位後撤到 P3 之後**：doctor 要診斷的拓撲（雲端短輪詢、board SSE 斷流、信箱積壓、游標卡住、claim 衝突）正是 P 線要改的東西。

---

## 10. 驗收面

### 10.1 四個 composition contract suite（採 Codex §11.1）

同一套 store contract suite 必須跑四個 composition：

1. InMemory（單元測試）；
2. Postgres + S3 fake/presigned test；
3. D1 + R2 miniflare/Workers integration；
4. 自託管 `@byok/server`（InMemory/SQLite）。

### 10.2 必測 invariant（8 條全收 + board 3 條）

| # | invariant |
|---|---|
| 1 | mailbox seq 單調、pull 不 ack、durable-local-append 後才 ack |
| 2 | 同 proof + same hash 冪等；同 `requestId` + different hash fail-closed |
| 3 | terminal immutable；提示 TTL 不可覆蓋 terminal |
| 4 | memory CAS conflict 不做 server merge |
| 5 | revoked key／錯 tenant/product/scope／錯 body hash 全拒絕 |
| 6 | Node 與 Workers 對 canonical proof bytes、hash 與 error code 完全一致 |
| 7 | `@byok-sdk/keys` 與 dispatch/platform dependency graph 零邊 |
| 8 | protocol golden files 零 diff，freeze guard 原樣通過 |
| 9 | **board claim 衝突**：N 個並發 claim 只有一個 200，其餘 409 且 holder 快照一致 |
| 10 | **`expectedStatus` CAS**：不符回 409 + 現況快照，不做 last-write-wins |
| 11 | **`board_seq` per-tenant 單調**：併發更新下序號不重、不倒退、不跨租戶推進 |

外加 §8.5 的 I1-I9 租戶隔離九項（P1 入口閘）。

### 10.3 命令

```bash
# 每個里程碑收尾
pnpm -r run typecheck && pnpm -r run test && pnpm -r run build
repo-harness run check-task-workflow --strict

# 鐵律 4 的機檢（凍結指紋零漂移）
pnpm --filter @byok/protocol test
git diff --exit-code packages/protocol/src/__tests__/golden/

# 鐵律 1 的機檢（依賴圖）
pnpm why @byok/protocol --filter @byok-sdk/keys    # 必須無結果
pnpm why @byok-sdk/keys                             # 不得出現在 client/server/protocol/cloud 下

# P1 關鍵驗證：client 零改動跑通雲端 handler
pnpm --filter @byok/client test -- --grep "long-poll"

# P2 SQL 順序檢查
pnpm run check:deploy-sql

# P3 board 併發驗證
pnpm --filter @byok/cloud test -- --grep "claim"

# K4 parity 黃金測試（在 aip-main-open 側，唯一 parity authority）
npx vitest run --root . apps/local-agent/src/settings.test.ts
```

---

## 11. 風險與 deferred 表

| # | 風險 / deferred | 可能性 | 影響 | 緩解 / 觸發條件 |
|---|---|---|---|---|
| R1 | `in_review` 與 wire `AwaitApproval` 被實作者混同：board 上點「通過」去 resume 一個已退出的進程 | **高** | 高 | 兩個狀態機放兩個包、兩份常數、兩套端點；core 的 `board.ts` doc comment 明寫反例；補測試斷言 board status API 永不觸發 `task.approve` |
| R2 | 「領走即棄」被實作成「讀到即刪」，靜默打斷凍結的 at-least-once | 中 | 高 | ack-on-cursor 寫進 `MailboxStore` 契約 doc；測試：投遞後不推游標，下次 poll 必須再拿到同一批；crash drill 覆蓋 |
| R3 | board status 與確權終態記錄分歧（agent 報完成、人卻 close） | 高 | 中 | 明定兩者不互相覆寫：`attested_record` 記機器產出的事實，`task.status` 記人的驗收決定；UI 同時顯示兩者，不做二選一 |
| R4 | 兩個狀態機長期漂移，有人往 board 加第 6 態或往 wire 加態 | 中 | 高 | board 5 態同樣立 golden（`board-v1.golden.json`）；wire 側由既有 freeze-guard 守 |
| R5 | 三套詞彙（board 5 態 / presence 5 級 / wire 7 態）在 UI 或日誌裡串味 | 中 | 中 | presence 禁用 `TaskState` 命名；前端 `terminal=null, presence=null` 只能顯示「尚無最新裝置提示」，不得合成 `Running`/`Failed` |
| R6 | SSE 內部輪詢間隔設得比 client 輪詢還密，變成淨虧；或誤持 DB transaction 跨 sleep | 中 | 中 | 內部 5s 是硬下限；契約 doc 明寫「每次查詢各自取用/歸還連線」；壓測對比 SSE 與純輪詢的 DB QPS |
| R7 | 輪詢定速選錯：250ms 預設打到雲端 SQL | 中 | 中 | 雲端模式的 daemon 配置範本硬寫 `longPoll.idleDelayMs`；handler 啟動時對缺省值告警 |
| R8 | 降級路徑被實作成狀態碼嗅探，違反 repo 的 no-fallback 規則 | 中 | 中 | 能力宣告端點是 P3 的驗收項；code review 檢查沒有 404/405/501 的分支 |
| R9 | 六個包的認知負擔與版本協調成本 | 高 | 中 | core 保持只有契約、zod-only；所有包同版本號一起發 |
| R10 | `ByokServer.dispatch()` 回傳的 `TaskHandle`（含等待終態的 promise）在無狀態雲端沒有對應物 | 高 | 中 | 明說這是自託管路徑的 affordance，不是跨部署契約；雲端側改為輪詢 board 或終態記錄 |
| R11 | outbox 保留語義從「容量有界 ring」變成「時間有界窗口」 | 高 | 低 | 寫進 `docs/protocol.md` 運維註記與 `MailboxStore` 契約 |
| R12 | board 與提示的輪詢 QPS 在 Hyperdrive 連線池先撐不住（10x 規模最先斷的地方）；高頻提示是第一個 write-amplification 熱點 | 中 | 中 | 提示表都是單行索引查詢，client 端最多每 2s 更新；真到瓶頸就把 `device_presence`/`activity_tail` 單獨挪去 KV/DO，這是可局部替換的兩張表 |
| R13 | Workers 本地開發 Hyperdrive 不支援遠端資源、`ratelimit` 不共享部署限額（官方文件明載） | 高 | 低 | 本地開發跑 in-memory store，SQL 路徑走 wrangler remote 或本地 Postgres |
| R14 | device proof 簽名格式在有人簽過之後才發現要改 | 中 | 高 | P4 就凍 `device-proof-v1.golden.json`；proof schema 版本獨立於 wire `v`，留乾淨的 v2 空間 |
| R15 | pairing code 在 TTL 窗口內被截獲 = 一次受限的 join | 中 | 中 | join token 的本質，答案是縮窗（12 字/60 bits、10min TTL、一次性、率限、只存 hash）加事後可撤（join 審計事件 + `devices.revoke`），不假裝能消除 |
| R16 | `signNonce` 的 domain separation 修復被漏做，device proof 先上線 | 中 | 中 | P4 驗收項；兩側同 PR 同步，四包未發 npm 所以 breaking 免費 |
| **D-1** | **deferred：`TaskStore` 的 breaking async cut** | — | — | **觸發條件**：有人真的要拿自託管 `@byok/server` 接非同步 SQL（Postgres）。屆時照 Codex 軌 §4 的切法（leaf-first、per-device FIFO promise chain、`setPendingApprovalId` 改 required）一次性完成，不預先付 29 調用點 + 20 簽名 + 23 測試檔的傳染成本 |
| **D-2** | **deferred：memory delta 鏈** | — | — | **觸發條件**（任一）：單一 memory key 快照穩定 > 1 MiB；或 `expectedRev` CAS 衝突率顯著。屆時照 Codex 軌 §7 實作，memory 契約 breaking 升版 |
| **D-3** | **deferred：v1 的 D4（短期憑證 mint + 本地回環憑證代理）、D6（多連接三層進程樹）、D7（自建 supervisor）重評** | — | — | 需求觸發制。現狀 agent 經 stdio 與 daemon 溝通、從不持有 SaaS 憑證，安全性等價；部署單位是「一個宿主產品一個 daemon」 |

---

## 12. 開放決策（不阻塞 T0 / P0）

1. **SQL 後端二選一**：Postgres via Hyperdrive（成熟、JSONB、可移植）vs D1（零運維、同生態、單庫寫入序列化）。board 的 claim CAS 與 per-tenant 序列在兩者上都成立，P2 前定即可。
2. **信箱認證面**：凍結 bearer 長輪詢（P1「client 零改動」的前提）vs device proof 簽名 pull。租戶隔離保證與該選擇正交（§8.4 第一層）；P1 實作按 §4.2 端點表取捨。
3. **board claim 是否允許人搶佔 agent 已 claim 的項目**（強制 unclaim）。影響 claim CAS 是否需要一條 admin 旁路。
4. **`closed` 的準確語義**（終止未驗收 vs 歸檔）——本方案取前者，探針未能確認 raft 原意 [unverified]；若採後者則改為加 `archived_at` 欄位，不加第 6 態。
5. **`@byok-sdk/keys` 與 `@byok/cloud` 的 npm 發佈形態**：公開（repo MIT）vs GitHub Packages 私有。K4 前定，兩者一起定。
6. **K3 設置頁 server 進包與否**（v1 遺留開放項）。

---

## 13. 證據與方法附錄

### 13.1 本次雙軌實地複核的 file:line（兩份原稿當場讀過，本文原樣保留）

- **凍結面**：`packages/protocol/src/version.ts:1-25`（`PROTOCOL_VERSION` 固定為 1）、`__tests__/freeze-guard.test.ts:47-83`、`:180-234`（fingerprint 含 `httpApiSchemas` 整塊）、`:218-232`（`pairRequest`/`pairResponse` 在指紋內）、`:239-300`、`:259-261`（每 message type 恰好一行 golden）、`:518-521`（`PROTOCOL_VERSION === 1`）、`http-api.ts:5-15`（plain HTTP bodies 與 wire envelope 的既有分界）、`:18-22`（pairing code 是 out-of-band mint）、`:24-29`、`:49-72`、`:108-125`、`:115-125,147-165`、`codec.ts:9-60`
- **server 現狀**：`task-store.ts:46-94`（全同步介面；closing brace 實際在 94 行）、`:77-91`（`setPendingApprovalId` optional 是 compatibility concession）、`:109-179`（InMemory 是 Map）、`blob-store.ts:36-49`（已 async）、`:7-20`（註解本就把 presigned 當替換點）、`hub.ts:50-54`（outbox ring 500 / dedup ring 1,024）、`:280-342`（進程內狀態）、`:459-476`（`pollEvents` 的 `setTimeout` hold）、`:1335-1379`（dispatch 同步建 task record）、`sqlite-task-store.ts:121-136`（明文不承諾 in-flight recovery）、`:157-218,251-276`（`DatabaseSync` 同步 statements）、`index.ts:67`（`DEFAULT_LONG_POLL_HOLD_MS=50_000`）、`:78-123,138-196`、`:84-85,175-176`（`createPairingCode` 公開面）、`:179-181`（`tasks.get/list` 公開同步 API）、`http.ts:75-97`（pair handler 憑空 register）、`:82-92`、`:99-135`、`:140-149`（`/content` 是 presigned capability，非 bearer-authed）、`:151-200`、`:206-221`、`:255-280`、`auth.ts:27-29`、`:76-82`（`DeviceRecord` 無租戶欄位）、`:155`、`:187-197`、`:220-227`、`pairing.ts:3`、`:34-42`（code 無主）、`:51-63`（redeem 無回傳）、`ids.ts:4-13`（8 字 × 32 字母表 = 40 bits）、`:15-17`（deviceId 每次 pair 重新生成）、`sqlite-support.ts:1-30`、`ws-server.ts:85-142`、`:141`、`messages.ts:154-185,310-327`（`task.approve`/`task.reject` + `approvalId` 定向）
- **hub 的 TaskStore 耦合實測**：`grep -c "this.taskStore\." packages/server/src/hub.ts` = **29**；`hub.ts` 現場 **1,689 行**
- **client 現狀**：`long-poll-transport.ts:83-92`、`:296-335`（驗證失敗凍結游標）、`:341-351`、`connection-manager.ts:247-248`、`create-daemon.ts:743-744`（`longPoll.*` 已曝露）、`cursor-store.ts:27-33`、`device-keys.ts:3-8`（keypair 跨 re-pair 復用）、`:3-16,23-46`、`:24,35`、**`:44-45`（`signNonce` 直簽 raw nonce，無 domain separation）**、`store.ts:13-16`、`types.ts:120-124`（credential-isolation rule）、`control-server.ts:38,170,175`
- **keys 線**：`packages/keys/package.json:32-34`（deps 只有 zod）、`secret-store.ts:25-40`（已 Promise-based）、`plans/plan-20260805-1659-byok-keys-package.md:101-107`（K4 是獨立跨 repo PR）、`:122-134`（K 線里程碑狀態）
- **包邊界**：`packages/server/package.json:32-38`、`packages/client/package.json:39-50`、`docs/security.md:596-610`（雙安全模型依賴邊界已是可執行約束）
- **既有可復用模組**：`packages/server/src/heartbeat.ts`、`packages/client/src/daemon/progress-batcher.ts`、`packages/client/src/daemon/control-protocol.ts`
- **落地位置**：`deploy/sql/` 已存在，root `package.json` 已有 `check:deploy-sql` → `repo-harness run check-deploy-sql-order`
- **本次命令核實**：`grep -n "productId" packages/server/src/hub.ts` → 零命中（hub 不讀 `conn.hello.productId`）；`DeviceRegistry` 無持久化路徑（`auth.ts` 全文 Map only）

### 13.2 npm 發佈狀態（2026-08-05 實測）

`packages/{protocol,server,client,keys}/package.json` 皆 `0.0.1`；四包 npm registry **實測 404，未發布**。**所有 API breaking 變更免費、無下游**——這是 T0 租戶 cut、`signNonce` domain separation 修復、`DeviceRecord` 形狀變更能立刻做的直接依據。

### 13.3 Cloudflare 官方文件實查（2026-08-05）

- Workers HTTP 請求**無 wall-time 上限**（只要 client 保持連線）；等待 I/O **不計入** CPU time；runtime 每週更新數次、in-flight 請求只有 **30 秒**寬限期（`/workers/platform/limits/`）。這同時支撐了「SSE 可行」與「50s hold 在派工路徑上不划算」兩個結論
- Workers `ratelimit` binding **2025-09-19 GA**，不需要 Durable Objects（`/workers/runtime-apis/bindings/rate-limit/`）
- 本地開發限制：Hyperdrive 遠端資源不支援、`ratelimit` 不與部署共享限額（`/workers/local-development/`）
- **`@cloudflare/computer` 為 preview 階段**，本方案**僅作接口品味參考**，不作為任何設計依據或依賴 [附註事實]

### 13.4 raft-computer v1.0.15 拆解與 task board 探針

**拆解方法（沿用 v1 §8 的本機拆解方法）**：install.sh 全文審計（496 行）→ 安裝 v1.0.15 → CLI 全命令面實測 → `strings -n 8`（868,175 行）targeted grep → 未登入行為實驗（start 被 attach-gate 拒絕、零殘留）→ 公開文件（raft.build / docs.raft.build）比對。**未做**真實 login/attach，故 daemon 帶負載運行時的 run/ 目錄內容與 wss 實際連線為 [inferred]。raft 內部代號 slock（env 前綴 `SLOCK_*`、舊 npm org `@slock-ai`、現 org `@botiverse`）；runner 憑證前綴 `sk_agent_*`。

**task board 探針結論**：task = message + 元數據，非獨立真相源；board 是按 channel 過濾的扁平清單；5 態 `todo/in_progress/in_review/done/closed`；assignee 與 status 解耦；claim 是併發鎖、衝突回占有者快照帶 `observedAt`、task 層無 version/etag（同 binary 的 Wiki 有 ETag，是刻意的不同選擇）；SSE 優先 + 404/405/501 降級輪詢，參數 5s／120s／3s／limit 50；本地→雲端狀態變更是離散顯式 POST；agent 活躍度 5 級逐事件推 + 60s 心跳；活動軌跡走獨立批量通道帶 `dropped`；本機 `/internal/agent-api` 唯讀短路。

**本方案對探針的四處不照抄**：狀態碼嗅探降級改為能力宣告（repo 明禁 heuristic 路徑）；status 轉移增加 `expectedStatus` CAS（探針只在 claim 有 CAS）；本機短路 API 改掛既有 Unix socket 控制面而非 loopback HTTP 端口（byok 既有實現更嚴格）；砍掉跨網的獨立 wake-hint 通道（SSE 串流本身即該信號）。

**v1 已完成的 raft 對位結論保留**：`@byok/client` 的 IPC control socket 防護比 raft 嚴（`control-server.ts:38,170,175`）；fail-closed 文化（未配對拒啟動、URL 白名單 unconditional refusal，`create-daemon.ts:178,527`）；K 線用 OS Keychain 存 key，raft 連自家 OAuth token 都存檔案；per-task Git checkpoint（workspaces）raft 沒有對應物。真缺口（doctor/upgrade/退避分級/watchdog 分級）已轉為 C1-C3 儲備里程碑（§9.2）。

### 13.5 標為 [inferred] / [unverified] 的判斷

- 無 DO 時 stateless Worker 無跨 isolate 喚醒原語（由「Workers 無共享記憶體、無內建 pub/sub 原語」推得，非官方明文）[inferred]
- `crypto.subtle` 的 Ed25519 在 Node 20 的穩定性——因此 `verifyDeviceProof` 設計為注入式 verifier（照 repo 既有的 `TokenSigner`/`fetchImpl` 慣用法）[unverified]
- raft 的 `closed` 究竟是「終止未驗收」還是「done 後歸檔」[unverified]
- raft-computer task board 探針由調度方提供，Opus 軌未獨立複核 [依證據等級標註]
