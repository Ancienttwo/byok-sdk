# BYOK 平台架構方案 v2（proposal）

RECOMMENDATION: 新增 protocol-free 的 `@byok/core` 契約包與無狀態 `@byok/cloud`，雲端持有「board 協調層（5 態）+ 確權真相層 + 兩級 ephemeral 提示」而執行態仍全在本機；board 以 per-subject 單調游標的 SSE/輪詢同步、claim 走 holder-snapshot 衝突、status 走 expectedStatus CAS；wire v1 與 client 的派工路徑一行不改，TaskStore 不做 async 遷移而隨 ConnectionHub 降級為自託管本地鏡像 — confidence: HIGH

> 狀態：待審批。與 v1（`ARCHITECTURE-PROPOSAL-byok-platform.md`）的關係：v1 的兩線定位與 K 線里程碑全部保留，v2 補「C 線雲端側形態」，新增 P 線里程碑。
> 依據：byok-sdk 工作樹實地複核（2026-08-05，本文所有 `file:line` 均當場讀過）+ Cloudflare 官方文件實查 + raft-computer v1.0.15 task board 探針實測（調度方提供，證據等級見 §11）。

---

## 0. 修訂說明：本方案動了兩條共識措辭，請確認

task board 這條輸入進來之後，原六條共識裡有兩條的**措辭**必須收緊，否則無法自洽。改的是判據，不是方向；請在審批時明確接受或駁回。

| 原措辭 | 問題 | 修訂後 |
|---|---|---|
| 「雲端不追蹤中間態」 | board 的 `in_progress`/`in_review` 就是中間態。字面執行等於否定 board | **判據換成頻率與離散性**：雲端可持有「每個 task 生命週期內變更次數為個位數、且每次變更都是一個離散顯式事件」的狀態；不得持有「隨執行連續變化」的狀態（工作區、上下文、逐輪產物、runtime session） |
| 「雲端只驗簽名封套，不看過程」 | board 必須存 title/channel 才能給人看 | **區分存取與推導**：雲端可按生產者給定的鍵做精確匹配與排序（channel、status、seq、hash），可原樣存取有界標籤；不得對任何內容做語義推導（相關性、摘要、合併、分類） |

「任務狀態機權威在本機 daemon」這條不改，但要說清楚它管的是哪個狀態機——見 §4.0。

---

## 1. 平台定位：兩個狀態機、兩個權威、一條凍結的派工線

```
使用者宿主機（執行權威）                        雲端（協調權威，無狀態請求/響應）
┌──────────────────────────────┐            ┌────────────────────────────────┐
│ @byok/client daemon          │            │ @byok/cloud (Workers / Node)   │
│  ├ 執行狀態機（wire 7 態）    │            │  ├ board  task 5 態    (SQL)   │
│  │   Offered…Running…Completed│◀─offer─────│  ├ 信箱   outbox       (SQL)   │
│  ├ 工作區 / 上下文 / 產物     │──terminal─▶│  ├ 真相層 attested_rec (SQL+R2)│
│  ├ 過濾/蒸餾 (RAFT)          │──board POST▶│  ├ 提示   presence/activity(TTL)│
│  └ device key (Ed25519)      │◀─SSE/poll──│  └ 零 Durable Object            │
└──────────────────────────────┘            └────────────────────────────────┘
```

**兩個狀態機，不可混同**

| | 執行狀態機（wire） | board 狀態機（協調） |
|---|---|---|
| 狀態 | `Offered/Claimed/Running/AwaitApproval/Completed/Failed/Cancelled`（`protocol/task-state.ts`，**凍結**） | `todo/in_progress/in_review/done/closed`（`@byok/core`，新增） |
| 對象 | 一次執行嘗試 | 一個工作項的人類可見生命週期 |
| 權威 | 本機 daemon | 雲端（因為人、多設備、多方都要改它，沒有任何單一 daemon 能擁有它） |
| 變更頻率 | 一次任務內連續變化 | 一次任務內個位數次，每次都是離散顯式 POST |
| 儲存 | 本機 | 雲端 `task` 表 |

**數據四分類與儲存對位**

| 類別 | 內容 | 儲存 | 生命週期 | 丟失後果 |
|---|---|---|---|---|
| board 協調層 | task 5 態、assignee、channel、標題 | SQL `task` | 永久 | 不可接受 |
| 真相層 | profile、memory、終態上下文 | SQL 行（metadata+簽名）+ R2 物件 | 永久，revision 遞增 | 不可接受，需備份 |
| 信箱 | 待領的 server→daemon envelope | SQL `outbox` | 游標推過即刪 | 可接受 |
| 提示（兩級） | 設備在線度 5 級 / 活動軌跡（有損） | SQL，`expires_at` TTL | 分鐘級 | 完全可接受 |

**鐵律**

1. **兩線互不依賴**：`client`/`server`/`protocol`/`cloud` 不得 import `keys`；`keys` 也不得 import `protocol`（§3 說明為何 `core` 必須 protocol-free）。
2. **雲端不做語義推導**：可精確匹配與排序生產者給定的鍵，可原樣存取有界標籤；不得排序相關性、摘要、合併、分類。
3. **雲端不持有連續態**：判據是「每 task 變更次數個位數 + 每次都是離散顯式事件」。工作區、上下文、逐輪產物、runtime session 一律在本機。
4. **wire v1 零新增**：不新增任何 message type、不改任何 `http-api.ts` schema。`golden/v1.frozen.json` 在整個 P 線裡一個 byte 都不動——這是可機檢的驗收條件。board 是新的 HTTP 面，不上 wire。

---

## 2. 現狀對位（實地複核）

| 模組 | 現狀 | v2 處置 |
|---|---|---|
| `@byok/protocol` | transport-agnostic，wire v1 FROZEN（`version.ts:25`），freeze-guard 三層網（`__tests__/freeze-guard.test.ts:180-234,259-261`） | **原樣不動**。`@byok/cloud` import 它解析 `EventsPollResponse`/`MessagesSendRequest`（`http-api.ts:115-125,147-165`） |
| `TASK_TRANSITIONS` | 凍結的 7 態執行狀態機 | 原樣。board 5 態是**另一個常數、另一個包**，永不合併 |
| `TaskStore` | 介面全同步（`task-store.ts:46-94`），hub 內 29 個調用點 | **不遷移為 async**，隨 ConnectionHub 降級為自託管本地鏡像，見 D1 |
| `BlobStore` | 已 async、已抽象（`blob-store.ts:36-49`），凍結的 `sha256:<64hex>` | **搬進 `@byok/core`**，R2/S3 只需新實現，server 側 re-export |
| `ConnectionHub` | 1689 行，狀態全在進程內 Map（`hub.ts:281-316`）；`pollEvents` 用 `setTimeout` 持有 50s（`hub.ts:459-476`、`index.ts:67`） | 降級為 Node 自託管可選 transport adapter，不進 core、不重寫 |
| `SqliteTaskStore`/`SqliteBlobStore` | 綁 `node:sqlite`，需 Node 22.5+（`sqlite-support.ts:1-30`） | 留在 server，自託管專用 |
| `DeviceRegistry`/`PairingManager` | 進程內 Map；**`DeviceRecord` 無租戶欄位**（`auth.ts:76-82`）、`createPairingCode()` 不綁 subject（`pairing.ts:34-40`） | 雲端版必須新增 `subject_id`。board 是跨設備可見面，租戶漏洞在這裡放大，見 §8 R1 |
| `heartbeat.ts` | server 側已有心跳模組 | 設備在線度 5 級 + 60s 心跳復用它的節奏，不另造 |
| `progress-batcher.ts` | client 側已有 progress 批次器 | 活動軌跡的 `dropped` 計數落在這裡，不另造通道 |
| `control-server.ts` | 硬化過的 Unix socket 控制面（symlink/uid 檢查、拒二重 daemon） | 本機唯讀短路 API 加在**這裡**，不開 loopback HTTP 端口 |
| `RateLimiter` | 進程內 token bucket | 雲端換 Workers `ratelimit` binding（2025-09-19 GA）；抽 `RateLimitGate` 注入點 |
| `LongPollClient` | `idleDelayMs` 預設 250ms（`long-poll-transport.ts:83-92,341-351`）；`longPoll.{retryDelayMs,idleDelayMs}` 已由 `create-daemon.ts:743-744` 曝露 | **派工路徑零 client 改動**，改配置即可 |
| `CursorStore` | 游標按 `(serverUrl, deviceId)` 持久化（`cursor-store.ts:27-33`） | 原樣。它就是信箱「領走即棄」的 ack 依據 |
| `device-keys.ts` | Ed25519 生成、PKCS8 存 `device.json` 0600（`:24,35`、`store.ts:13-16`）、`signNonce` 直簽 raw nonce（`:44-45`） | 確權封套復用同把私鑰，**必須加 domain separation 前綴**，見 D3 |
| `@byok-sdk/keys` | K1 完成、K2 執行中，deps 只有 zod | K4 之後才接 core 的 `TruthStore`，見 D5 |

---

## 3. D1 — core 包拆分粒度與依賴圖

**選型：新建 `@byok/core`（契約層，zod-only，protocol-free）+ 新建 `@byok/cloud`（無狀態 handler + SQL/R2 實現）。共 6 個包。**

```
@byok/protocol   凍結 wire（zod，neutral）           ← 無依賴
@byok/core       儲存契約 + 確權封套 + board 狀態機   ← 無依賴，且【禁止】依賴 protocol
@byok/cloud      無狀態 handler + SQL/R2 實現         ← protocol + core + hono
@byok/server     Node 嵌入式 coordinator（現狀）       ← protocol + core（BlobStore）
@byok/client     本機 daemon                          ← protocol + core（封套 + board）
@byok-sdk/keys       key 管理                             ← core（僅契約）—— 永不碰 protocol
```

`@byok/core` 的全部內容（五個檔案，只有契約，沒有實現）：

- `attestation.ts` — 確權封套 schema + 正規化簽名輸入 + `verifyAttestation`（注入式 verifier）
- `board.ts` — board 5 態 + 合法轉移表 + claim 衝突快照形狀
- `record-store.ts` — `TruthStore`（async）
- `mailbox-store.ts` — `MailboxStore`（async，payload 不透明）
- `blob-store.ts` — 從 server 搬過來（已 async，零改動）

**理由**

*為何 core 必須 protocol-free。* 共識第 6 條要求 `keys` 可依賴 core。若 core 依賴 protocol，`keys → core → protocol` 會在 `pnpm why` 的安裝圖上直接違反鐵律 1——即使 import 圖乾淨，審計者看到的依賴圖已經髒了。core 也不需要 protocol：信箱契約把 envelope 當不透明 JSON 加路由 metadata；board 契約裡 `task_id` 只是一個 string。內容盲與 protocol-free 是同一件事的兩面。

*board 狀態機放 core 而不放 protocol。* protocol 是凍結的 wire，board 不上 wire（鐵律 4）。但 board 5 態要被 cloud（強制執行）、client（理解）、SaaS UI（渲染）三方共用，正是 core 的定位。放進去之後 core 仍然 zod-only、仍然 protocol-free。

*為何 cloud 獨立成包而非 `@byok/server` 的 subpath。* 打包目標不同（server 根入口拖著 `node:http` 與 `node:sqlite`）、依賴集不同，決定性的是第三條：本 repo 的安全審計按包寫（`docs/security-review-m5-pilot-entry.md` 針對 M5 的 credential-isolation claim）。雲端是全新的公網多租戶攻擊面，塞進已審計包等於稀釋那份審計的邊界。

*為何 `TaskStore` 不做同步→async 遷移。* 波及面實測：`hub.ts` 29 個 `this.taskStore.*` 調用點、約 20 個同步簽名要傳染成 async、外加 `http.ts:265` 與 `ws-server.ts:141` 兩個調用點、`ByokServer.tasks.get/list` 這個公開同步 API（`index.ts:179-181`）、server 包 23 個測試檔。而這筆改動買不到東西：雲端需要的是 `MailboxStore`/`TruthStore` 和 board 表，不是 `TaskStore`；自託管的 ConnectionHub 配 `node:sqlite`（本身同步 API）恰好同步就夠。改法是「按作用域退場」：
- `TaskStore` 留在 `@byok/server`，語義從「權威」降級為「本地鏡像」（doc-level 降級 + 一條斷言 daemon 上報終態永遠覆蓋鏡像的測試）。
- 雲端沒有 `TaskStore`。`hub.dispatch()` 的雲端對應物是「board claim 成功 → enqueue offer 進 outbox」，沒有執行態寫入。
- 真要「Node 後端 + Postgres」，答案是那個部署直接跑 `@byok/cloud` 的 handler（共識第 2 條已允許任何 Node 後端）。一條 async 路徑、一條 sync 路徑，服務兩種部署形態，彼此不是 fallback。

**被否選項**

- 把 protocol 併進 core：毀掉凍結包的審計鏈，且讓 keys 傳染 wire 依賴。
- board 狀態機放 protocol：board 不上 wire，放進去等於擴大凍結面。
- `@byok/server/cloud` subpath：把新公網攻擊面塞進已審計包內。
- 不建 core：keys 無處可依賴，且 BlobStore 出現第二份定義。
- `TaskStore` 全面 async：29 調用點 + 20 簽名 + 23 測試檔的傳染，換一個雲端不用的介面。

---

## 4. D2 — 雲端最小接口：board 同步層 + 信箱 + 真相層 + 兩級提示

### 4.0 分層原則：board 決定「派什麼」，凍結的 wire 負責「送到並執行」

board 層唯一注入派工層的動作是**把一個 offer 塞進某設備的 outbox**。claim 成功之後，剩下的全走凍結的 wire（`task.offer` → `task.claim` → `task.started` → … → 終態），一個 message type 都不新增。這條分界同時解決了「為何 board 有權威但執行態沒有」：board 是多方會合點（人在手機上要能看要能改，daemon 離線時也要能改），執行態是單機事實。

沿用探針的第一條原則並翻譯成 byok 的說法：**board 行是派工記錄的元數據，不是第二個真相源。** `task` 表只存 status／assignee／channel／標題／指標；指令正文在 outbox envelope 或 blob 裡，執行結果在 `attested_record` 裡。board 表不複製其中任何一份。

### 4.1 board 狀態機：保留 5 態，但每一態都要說清楚憑什麼留

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
| `in_review` | 人工驗收閘。與 wire 的 `AwaitApproval` **不是同一件事**，見下 |
| `done` | 已驗收 |
| `closed` | 終止未驗收（放棄／被取代／不做）。是 `done` 的兄弟，不是它的後繼 |

**`in_review` 與 `AwaitApproval` 必須分開，這是最容易被實作者踩爛的一條。** `AwaitApproval` 是**執行中暫停**——agent 要用某個工具、進程真的掛在那裡等許可，resolve 之後要恢復一個活著的 session，對延遲敏感，走凍結的 `task.approve`/`task.reject` + `approvalId` 定向（`messages.ts:154-185,310-327`）。`in_review` 是**執行後閘門**——跑完了，人決定收不收，沒有任何進程被掛起，不對延遲敏感，走 board 的 status POST。混同的後果很具體：一次執行中的權限彈窗會顯示成「待驗收」，而人在 board 上點「通過」會去 resume 一個早已退出的進程。

**`closed` 的語義由本方案定義為「終止未驗收」**，可從任何非 `done` 態進入。理由是產品需要「任意時點放棄」，且它天然對位執行層既有的 `Completed` vs `Failed/Cancelled` 終態二分。探針未能確認 raft 的 `closed` 究竟是這個意思還是「done 之後的歸檔」——標為 [unverified]；若後續證實是歸檔語義，那是命名差異不是結構差異，補一個 `archived_at` 時間戳即可，不加第 6 態。

**claim 是併發鎖不是所有權，沿用探針結論。** 衝突回 409 + 當前占有者快照（`assignee`/`assignedAt`/`observedAt`），不回 412。理由：ETag/version 是給**內容**衝突用的（兩個寫者改同一份正文），claim 是排他指派的 CAS，輸的一方需要知道的是「誰佔著、那是什麼時候觀察到的」，據此決定等、搶還是換路——這比一個裸的 412 有用。SQL 上就是 `UPDATE task SET assignee=?, status='in_progress' … WHERE assignee IS NULL RETURNING *`，rowcount 0 就去 SELECT 占有者。不需要 version 欄位。

**但 status 轉移要加 `expectedStatus` 前提，這是本方案在探針之上的增補。** claim 的 CAS 前提天然是 `assignee IS NULL`，status 轉移沒有這種天然前提；而 board 上人和 daemon 會同時推同一個項目（人打回 `in_progress` 的同時 daemon 剛好報完終態要推 `in_review`）。裸的 last-write-wins 在這裡會靜默吃掉一次人工決策。`expectedStatus` 不符回 409 + 現況快照，與真相層的 `expectedRev` 同一種 fail-closed 慣用法。

`assignee` 與 `status` 解耦（沿用探針）：`done`/`closed` 之外任意態可 claim/unclaim。

### 4.2 同步機制：SSE 優先 + 輪詢兜底，在無 DO 的 Workers 上怎麼落

**SSE 端點的形狀**

```
GET /byok/board/stream?since=<board_seq>     Accept: text/event-stream
→ ReadableStream，worker 內部迴圈：
   每 5s：  SELECT … WHERE subject_id=? AND board_seq > cursor ORDER BY board_seq LIMIT 50
            逐行 emit  `id: <board_seq>\ndata: <json>\n\n`，推進 cursor
   每 120s：emit  `event: reconcile`  要求 client 做一次全量列表對賬
   每 15s： emit  `:\n\n` 心跳註釋，防中間層超時斷流
   ※ 每次查詢各自取用/歸還 DB 連線，禁止跨 sleep 持有 transaction
```

參數（5s 常規、120s 全量對賬、3s 喚醒後快速追趕、每輪 limit 50）直接沿用探針實測值——那是生產調過的量級，沒有理由重新猜。

**為何 SSE 在這裡划算，而 50s long-poll hold 在派工路徑上不划算。** 兩件事的成本結構不同，不是前後矛盾：

| | 派工 `GET /byok/events`（凍結契約） | board stream（新契約） |
|---|---|---|
| 若不 hold | client 每 2s 一次請求 | client 每 5s 一次請求 |
| 若 hold/串流 | 50s 內部輪 25 次 ≈ 打平 DB，卻多釘住一條連線 | 一條連線攤 10 分鐘：1 次認證 vs 120 次認證，DB 查詢也更少 |
| runtime 更新中斷 | hold 到一半被 30s 寬限期砍斷 = 靜默截斷 | SSE 有 `Last-Event-ID`/`since` 語義，斷了就是一次普通重連 |
| 契約自由度 | 凍結，改不了 | 新增，隨便設計 |

Workers 的 HTTP 請求沒有 wall-time 上限（官方文件實查），等待 I/O 不計 CPU time，所以持有串流本身可行；runtime 每週更新數次、in-flight 請求只有 30 秒寬限期這件事，對 SSE 是常態重連，對 50s hold 是靜默截斷。

**降級必須是宣告式能力，不是狀態碼嗅探。** 探針顯示 raft 在收到 404/405/501 時降級輪詢。本 repo 的規則禁止 heuristic/best-effort 路徑，所以照抄嗅探會直接違規。改法：雲端在 `GET /byok/capabilities`（或部署配置）明確宣告 `board.sse`，daemon 只在宣告時用 SSE，否則走 `GET /byok/board?since=` 的 5s 輪詢。兩條路徑都是一等公民、都有測試，而不是一條主路加一條猜出來的備胎。

**board 的增量流不另建事件表。** 每個 `task` 行帶一個 per-subject 單調的 `board_seq`，每次更新重新分配；增量查詢就是 `WHERE subject_id=? AND board_seq > ?`。這樣 board 表本身就是事件源，不存在「日誌與狀態兩份真相」的漂移——這恰好是探針第一條原則（task 不是獨立真相源）在儲存層的同一個道理。代價是同一行在兩次輪詢之間被改兩次時只看得到最新值，而 120s 全量對賬正是補這個洞的網。

**wake-hint 通道砍掉。** 探針裡的 wake hint 是「有變化，快去拉」的廉價信號。無 DO 就無法推送，而 SSE 串流本身就是那個信號，輪詢模式下 5s 也已經夠短。本機唯讀 peek 保留（見 4.5），跨網的獨立 wake 通道刪除。

### 4.3 提示分兩級，不是一級也不是三級

原草案的單一 `status_hint` 在這次修訂中被拆解：它的持久那半（「這個 task 現在到哪一步」）已經升格進 `task.status`，剩下的 ephemeral 部分按**作用域**分兩級。

| 級 | 對象 | 頻率 | 語義 | 儲存 |
|---|---|---|---|---|
| 設備在線度 | per-device | 逐事件推 + 60s 心跳 | 5 級：`online/thinking/working/error/offline` | `device_presence`，TTL |
| 活動軌跡 | per-task | 高頻批量 | **有損**，帶 `dropped` 顯式計數 | `activity_tail`，TTL，整體覆寫最近 N 條 |

分級的理由是作用域不同：在線度是設備級的（一台機器一個值，前端畫「這台機器活著嗎」），軌跡是任務級的（畫「這個任務在幹嘛」）。合併成一級就必須在同一行裡塞兩種基數，查詢與過期策略都會擰巴。分成三級（再切出一級「任務階段」）則是重複——那一級已經是 `task.status`。

`dropped` 計數這個設計直接採納：它把有損這件事寫進數據而不是假裝流是完整的。落點是 client 既有的 `progress-batcher.ts`，不另造通道。`task.progress` 的內容流向就是這裡，永不進真相層（鐵律 3）。

### 4.4 端點總表

**設備面派工路徑（零新增，全部沿用凍結契約）**

| 端點 | 雲端行為 | 現狀對位 |
|---|---|---|
| `POST /byok/pair` | 兌換 pairing code → 寫 `device` 行（**必須帶 subject_id**） | `http.ts:75-97` |
| `POST /byok/challenge` / `POST /byok/token` | nonce 寫 `auth_nonce`，Ed25519 驗簽同 `auth.ts:187-197` | `http.ts:99-135` |
| `GET /byok/events?cursor=N` | ① `DELETE FROM outbox WHERE device_id=? AND seq<=N` ② `SELECT … seq>N ORDER BY seq LIMIT k` ③ **立即返回** | `http.ts:206-221` |
| `POST /byok/messages` | 逐條進 dedup；終態 → 寫真相層 + 推 board 到 `in_review`；`task.progress` → 寫 `activity_tail`；其餘丟棄 | `http.ts:255-280` |
| blob 四路由 | R2 presigned PUT/GET 換掉 HMAC 自簽 | `http.ts:151-200` |

**「領走即棄」= 「游標推過即刪」，不是「讀到即刪」。** 讀到即刪會直接打斷凍結的 §9 at-least-once——client 的整套 stall 機制（`long-poll-transport.ts:296-335`：驗證失敗就凍結游標、等伺服器重投）建立在「未 ack 的 seq 會被反覆重投」之上。刪除的觸發器是 client 下次帶上來的 `cursor=N`，那才是它的持久化 ack（`cursor-store.ts`）。

**board 與提示面（新增，subject-authed）**

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

**真相層（新增，subject-authed）**

| 端點 | 用途 |
|---|---|
| `GET /byok/records?kind=&prefix=` | 回 manifest（key/rev/hash/size/label），**不回 body** |
| `GET /byok/records/:kind/:key` | 回 presigned R2 GET URL，或小 payload 直接 inline |
| `PUT /byok/records/:kind/:key` | body = 確權封套；`expectedRev` CAS，不符回 409 |

board status 是 subject-authed 的普通寫入，**不走確權簽名**——它的作者往往是人，不是設備。只有真相層的記錄是 device-signed。這條要寫明，否則實作者會以為雲端所有寫入都帶簽名。

### 4.5 本機唯讀短路：加在既有控制面，不開新端口

探針的 `/internal/agent-api`（GET /inbox、GET /wake-hints peek、POST /activity 轉發）採納**能力**、否決**傳輸**：byok 已有硬化過的 Unix socket 控制面（symlink/uid 檢查、拒二重 daemon，`control-server.ts:38,170,175`），比 loopback HTTP 端口嚴格。新增三個唯讀/轉發 RPC 到 `control-protocol.ts` 即可，不開監聽端口。

### 4.6 表結構草案（落 `deploy/sql/`，走既有 `check:deploy-sql` 順序檢查）

```sql
-- 設備註冊（取代進程內 DeviceRegistry；subject_id 是本方案新增的租戶邊界）
CREATE TABLE device (
  device_id   TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL,
  device_name TEXT NOT NULL,
  public_key  TEXT NOT NULL,              -- Ed25519 base64url（JWK x 形式）
  revoked     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX device_subject ON device (subject_id);

CREATE TABLE auth_nonce (
  nonce      TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false
);

-- board：派工記錄 + 元數據。不存指令正文、不存結果、不存產物
CREATE TABLE task (
  subject_id      TEXT   NOT NULL,
  task_id         TEXT   NOT NULL,        -- 與 wire task_id 同一個 id
  channel         TEXT   NOT NULL,        -- board 唯一的分組維度（扁平清單，無列/泳道）
  status          TEXT   NOT NULL,        -- todo|in_progress|in_review|done|closed
  assignee        TEXT,                   -- device_id 或 user id；與 status 解耦
  assigned_at     TIMESTAMPTZ,
  title           TEXT   NOT NULL,        -- 有界標籤，原樣存取，雲端不推導
  instruction_ref TEXT,                   -- blob/R2 指標
  board_seq       BIGINT NOT NULL,        -- 每 subject 單調；SSE/輪詢的游標
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, task_id)
);
CREATE INDEX task_board_seq ON task (subject_id, board_seq);
CREATE INDEX task_channel   ON task (subject_id, channel, status);

CREATE TABLE subject_stream (
  subject_id     TEXT PRIMARY KEY,
  next_board_seq BIGINT NOT NULL DEFAULT 1
);
-- 分配：UPDATE subject_stream SET next_board_seq = next_board_seq + 1
--       WHERE subject_id = $1 RETURNING next_board_seq - 1;   （Postgres/D1 皆原子）

-- 信箱：待領事件。游標推過即刪
CREATE TABLE outbox (
  device_id  TEXT   NOT NULL,
  seq        BIGINT NOT NULL,
  task_id    TEXT,
  type       TEXT   NOT NULL,             -- 僅供運維查詢，雲端不據此分支
  envelope   JSONB  NOT NULL,             -- 原樣 v1 envelope，不解讀
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, seq)
);

CREATE TABLE device_stream (
  device_id TEXT PRIMARY KEY,
  next_seq  BIGINT NOT NULL DEFAULT 1,
  acked_seq BIGINT NOT NULL DEFAULT 0,
  seen_at   TIMESTAMPTZ
);

-- 入站冪等窗口（§9），取代 hub 的 dedupRings
CREATE TABLE inbound_dedup (
  device_id   TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, envelope_id)
);
-- 判重：INSERT … ON CONFLICT DO NOTHING，rowcount = 0 即 duplicate

-- 真相層：終態上下文 + profile + memory，一張表按 kind 區分
CREATE TABLE attested_record (
  subject_id     TEXT   NOT NULL,
  kind           TEXT   NOT NULL,         -- 'task.terminal' | 'profile' | 'memory'
  record_key     TEXT   NOT NULL,
  rev            BIGINT NOT NULL,
  device_id      TEXT   NOT NULL,
  payload_hash   TEXT   NOT NULL,         -- sha256:<64 hex>，沿用凍結的 CONTENT_HASH_RE
  payload_size   BIGINT NOT NULL,
  content_type   TEXT   NOT NULL,
  payload_ref    TEXT,                    -- R2 key（大 payload）
  payload_inline JSONB,                   -- 小 payload 內聯
  signature      TEXT   NOT NULL,         -- Ed25519 over 正規化簽名輸入
  signed_at      TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, kind, record_key, rev)
);
CREATE INDEX attested_latest ON attested_record (subject_id, kind, record_key, rev DESC);

-- 提示一級：設備在線度，5 級 + 心跳，TTL
CREATE TABLE device_presence (
  device_id  TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  level      TEXT NOT NULL,               -- online|thinking|working|error|offline
  detail     TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

-- 提示二級：活動軌跡，per-task、有損、TTL
CREATE TABLE activity_tail (
  subject_id TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  events     JSONB  NOT NULL,             -- 最近 N 條，整體覆寫
  dropped    BIGINT NOT NULL DEFAULT 0,   -- 有損程度顯式可見
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (subject_id, task_id)
);
```

**一個必須寫進文件的行為差異**：進程內 outbox 是容量有界的 ring（滿了丟最舊），SQL outbox 是時間有界的保留窗口。設備長期離線後回來拿到什麼，兩者表現不同，運維語義要明說。

**被否選項**

- 雲端保留執行狀態機：製造第二個執行權威，且違反鐵律 3。
- board 增量另建事件表：日誌與狀態兩份真相，正是探針第一條原則反對的形狀。
- 提示合併成一級：設備級與任務級基數不同，過期與查詢策略會擰巴。
- 狀態碼嗅探降級：本 repo 明禁 heuristic 路徑，改為能力宣告。
- 派工路徑也改 SSE：那是凍結契約，動不了；而且它替換的輪詢密度低，攤不回來。
- 提示走 KV：最終一致性與 1-3s 輪詢對打。

---

## 5. D3 — 上行確權封套 schema

**選型：單一封套、按 `kind` 判別、簽名只覆蓋 header（payload 靠 hash 綁定）、放 `@byok/core`、走 HTTP body 而非 wire envelope。**

```jsonc
{
  "av": 1,                               // attestation version，與 wire v 完全獨立
  "subject": "acct_…",
  "kind": "task.terminal" | "profile" | "memory",
  "key": "task_…",
  "rev": 7,                              // 單調遞增，PUT 時作 CAS 前提
  "deviceId": "dev_…",
  "payloadHash": "sha256:<64 hex>",      // 沿用 blob.ts 的 CONTENT_HASH_RE
  "payloadSize": 12345,
  "contentType": "application/json",
  "signedAt": "2026-08-05T…Z",
  "sig": "<base64url Ed25519>"
}
```

正規化簽名輸入（固定欄位順序、換行分隔、帶 domain separation 前綴）：

```
byok-attest-v1\n{av}\n{subject}\n{kind}\n{key}\n{rev}\n{deviceId}\n{payloadHash}\n{payloadSize}\n{contentType}\n{signedAt}
```

**理由**

*一個封套而非三型。* 鐵律 2 要求雲端不做語義推導。三型封套逼雲端知道三種 payload 形狀、寫三條驗證路徑；單封套 + 不透明 payload，雲端的全部工作是「驗簽 → 比 hash → 檢查 rev 單調 → 落庫」。各 kind 的 payload schema 歸消費端。

*簽名只覆蓋 header。* payload 完整性由 header 內的 `payloadHash` 傳遞，於是大的終態上下文可以走 presigned R2 PUT 直傳，驗簽不必把物件拉回來。復用的是 repo 既有的 `BlobRef` + `contentHash` 慣用法，不引入新原語。

*domain separation 前綴是必須的。* 現有 token renewal 直接簽 raw nonce（`device-keys.ts:44-45`），無任何前綴。同一把私鑰要簽第二種訊息時，兩邊都無域分隔就打開了跨協議簽名重用的口子。今天實際風險低（nonce 是 24 隨機 bytes 的 base64url，形狀上撞不到多行帶前綴格式，`auth.ts:155`），但新路徑沒理由把缺口擴大。附帶動作：既有 nonce 簽名補上 `byok-nonce-v1\n` 前綴——這是一次 breaking 的 pair/token 變更，排進 P4 一起做。

*放 core、走 HTTP，於是 wire v1 零改動。* 兩條替代路徑都「合法但不必要」：新增 message type 是加性變更（`version.ts:5-8` 明載），但會改動 `MESSAGE_TYPES`/`DAEMON_TO_SERVER_TYPES`/`payloadSchemas` 三處 fingerprint，且 freeze-guard 斷言「golden NDJSON 每個 message type 恰好一行」（`freeze-guard.test.ts:259-261`），要補 golden；把 schema 放進 `protocol/http-api.ts` 同樣會漂——fingerprint 裡有 `httpApiSchemas` 整塊（`:218-232`）。放 core 兩邊都不碰，而且這是唯一能讓 `keys` 復用封套又不碰 protocol 的位置。

*封套自己也要凍結。* P4 落地時建 `packages/core/src/__tests__/golden/attest-v1.golden.json`，鎖住正規化簽名輸入的逐字節形狀。簽名格式一旦在生產環境簽過就不能靜默改，這一點和 protocol 的 freeze 文化同源。

**被否選項**

- 按 kind 分三種封套：把內容感知推進雲端。
- 簽名覆蓋整個 payload：大上下文必須全量過雲端才能驗簽，R2 直傳的意義消失。
- RFC 8785/JCS 正規化：多一個依賴與一類邊角歧義，而 header 欄位集是封閉的，固定順序拼接更好審。
- 走 wire envelope：要動凍結指紋且要補 golden，換不到能力。
- board status 也要簽名：作者常常是人不是設備，簽名在這裡無對象。

---

## 6. D4 — memory 讀寫模式

**選型：起工拉 manifest、按需取 body；收工按 key 寫整份快照；用 key 粒度換增量，不做 delta。**

**讀（起工）** — `task.claim` 之後，daemon `GET /byok/records?kind=memory` 拿 manifest（key/rev/hash/size/label，無 body），本機選擇器決定要哪幾條，再逐條取 presigned R2 URL 拉 body。這是 cloudflare/agents 生態的 R2 按需文檔載入模式，也是唯一能讓雲端保持不推導的形狀——雲端若要做相關性排序就必須理解內容，直接撞鐵律 2。

**寫（收工）** — 只在終態寫，每個 memory key 是一份自包含的完整快照，新版本 `rev+1` 整體替換，雲端永不合併。三個理由疊起來：合併需要語義推導（禁止）；delta 鏈需要雲端持有可重放的中間態（禁止）；快照的簽名驗證是一次性的，delta 鏈的驗證要沿鏈往回追到創世。

**「增量還是快照」的答案是：快照，增量性由 key 粒度提供。** 要細粒度就把 memory 切成多把小 key，各自快照。這把增量需求從編碼層挪到命名層，代價是 key 設計要想清楚，收益是雲端零合併邏輯。

**衝突** — `PUT` 帶 `expectedRev`，不符回 409，daemon 重拉 manifest 後在本機重新決定。fail-closed，無伺服器端合併。一機一租戶時幾乎撞不到，多機共用 subject 時這是唯一的正確性閘門。

**與本機過濾的分工** — 蒸餾/過濾（RAFT 式）歸 `@byok/client` 的新 seam（`ContextPolicy`/`MemorySelector`），不進 core、不進 cloud。雲端在整條鏈上只看見三樣東西：manifest 的 metadata、presigned body 的取放、簽名快照的落庫。

**中途想看「它在幹嘛」** — 那是 `activity_tail` 與 `device_presence`，不是 memory。TTL、有損、不簽名、永不進真相層。

**被否選項**

- 全量快照拉取：浪費頻寬，且恰好在該過濾的那一刻放棄過濾。
- 雲端做 embedding/相關性檢索：違反鐵律 2，且把蒸餾的所有權從本機搬走。
- 增量 delta 寫回：雲端要存重放鏈，簽名驗證退化成鏈式。
- 中途寫回 memory：中間態進真相層，鐵律 3 破。

---

## 7. D5 — 遷移順序與驗證面

**選型：P0 立刻並行開工（純加性）；P1 起等 K3 關閉；board 排在 SQL 之後，`keys` 接 core 排在 K4 之後。**

| 序 | 里程碑 | 內容 | 驗證面 |
|---|---|---|---|
| 0 | **P0**（現在，與 K2 並行） | 建 `@byok/core`：五個契約檔案，零實現，不改任何既有包 | `pnpm -r typecheck/test/build` 綠；新測試斷言 core 的 `package.json` 無 `@byok/protocol`、原始碼無 `node:` import；`git diff` 中 `golden/v1.frozen.json` 未變 |
| 1 | K2 → K3 | K 線照 v1 計畫走完 | 既有計畫的驗證面，不變 |
| 2 | **P1**（K3 之後） | `@byok/cloud`：無狀態派工 handler + 三個 store 的 in-memory 參考實現 | **關鍵測試**：既有 daemon 在 long-poll 模式、`longPoll.idleDelayMs=1500` 下跑通全套整合測試，client 零改動 |
| 3 | **P2** | SQL（Postgres/Hyperdrive + D1）與 R2/S3 實現；`deploy/sql/` migration | store conformance 套件同一份測試跑兩種後端（照 `InMemoryTaskStore`/`SqliteTaskStore` 的既有雙實現慣例）；`check:deploy-sql` 過 |
| 4 | **P3** | board 層：5 態 + claim CAS + status CAS + `board_seq` 增量 + SSE/輪詢雙路徑 + 兩級提示 | claim 併發測試（N 個並發 claim 只有一個 200，其餘 409 且 holder 快照一致）；SSE 與輪詢兩條路徑跑同一份行為測試；120s 對賬能修復人為製造的漏事件 |
| 5 | **P4** | client 側確權封套上行 + memory manifest/selector seam + nonce 簽名補 domain prefix | `attest-v1.golden.json` 凍結簽名輸入；pair/token 的 breaking 變更在同一 PR 內兩側同步 |
| 6 | **P5**（K4 之後） | `@byok-sdk/keys` 的 profile 持久化接上 core 的 `TruthStore` | keys 依賴圖仍不含 protocol；aip-main-open 的 `settings.test.ts` 黃金測試原樣通過 |
| 儲備 | C1-C3 | v1 的 doctor/upgrade/backoff 三個里程碑 | 排在 P3 之後 |

**時序理由**

P0 純加性、不碰共享檔案，可與執行中的 K2 並行。P1 起要等 K3，因為 K3 要編輯 `docs/security.md`，而雲端安全模型那節也要寫進同一份文件。

board（P3）排在 SQL（P2）之後而不是之前：board 的正確性全押在 SQL 語義上（per-subject 單調序列、claim 的 `WHERE assignee IS NULL` CAS、`expectedStatus` CAS），in-memory 版本能假裝這些都對，然後在真 SQL 上翻車。先在較簡單的派工面把儲存基底跑通，再在已驗證的基底上建 board，而不是為 board 寫一份注定丟棄的 in-memory 實現。

v1 的 C1（doctor/logs/setup）從第 3 順位後撤到 P3 之後：doctor 要診斷的拓撲（雲端短輪詢、board SSE 斷流、信箱積壓、游標卡住、claim 衝突）正是 P 線要改的東西。

K4 是跨 repo 且需對方配合的協調閘，會浮動，所以 P5 掛在它後面而不掛日期。

---

## 8. 風險表

| # | 風險 | 可能性 | 影響 | 緩解 |
|---|---|---|---|---|
| R1 | **多租戶隔離是全新的**：`DeviceRecord` 今天無租戶欄位（`auth.ts:76-82`）、pairing code 不綁 subject（`pairing.ts:34-40`）。board 是跨設備可見面，一旦漏了 subject 檢查就是跨租戶讀取整個工作板 | 中 | **極高** | subject 綁定發生在 pairing 時（pairing code 由 SaaS mint 時就攜帶 subject）；所有查詢的 `WHERE subject_id=?` 走同一個 helper，禁止手寫 SQL 繞過；P3 收尾前補跨租戶滲透測試 |
| R2 | `in_review` 與 wire `AwaitApproval` 被實作者混同：board 上點「通過」去 resume 一個已退出的進程 | **高** | 高 | 兩個狀態機放兩個包、兩份常數、兩套端點；core 的 `board.ts` doc comment 明寫反例；補一條測試斷言 board status API 永不觸發 `task.approve` |
| R3 | 「領走即棄」被實作成「讀到即刪」，靜默打斷 §9 at-least-once | 中 | 高 | ack-on-cursor 寫進 `MailboxStore` 契約 doc；補測試：投遞後不推游標，下次 poll 必須再拿到同一批 |
| R4 | board status 與確權終態記錄分歧（agent 報完成、人卻 close） | 高 | 中 | 明定兩者不互相覆寫：`attested_record` 記機器產出的事實，`task.status` 記人的驗收決定；UI 同時顯示兩者，不做二選一 |
| R5 | 兩個狀態機長期漂移，有人往 board 加第 6 態或往 wire 加態 | 中 | 高 | board 5 態同樣立 golden（`board-v1.golden.json`）；wire 側由既有 freeze-guard 守 |
| R6 | SSE 內部輪詢間隔設得比 client 輪詢還密，變成淨虧；或誤持 DB transaction 跨 sleep | 中 | 中 | 內部 5s 是硬下限；契約 doc 明寫「每次查詢各自取用/歸還連線」；壓測對比 SSE 與純輪詢的 DB QPS |
| R7 | 輪詢定速選錯：250ms 預設打到雲端 SQL | 中 | 中 | 雲端模式的 daemon 配置範本硬寫 `longPoll.idleDelayMs`；handler 啟動時對缺省值告警 |
| R8 | 六個包的認知負擔與版本協調成本 | 高 | 中 | core 保持只有契約、zod-only；所有包同版本號一起發 |
| R9 | `ByokServer.dispatch()` 回傳的 `TaskHandle`（含等待終態的 promise）在無狀態雲端沒有對應物 | 高 | 中 | 明說這是嵌入式路徑的 affordance，不是跨部署契約；雲端側改為輪詢 board 或終態記錄 |
| R10 | outbox 保留語義從「容量有界 ring」變成「時間有界窗口」 | 高 | 低 | 寫進 `docs/protocol.md` 運維註記與 `MailboxStore` 契約 |
| R11 | board 與提示的輪詢 QPS 在 Hyperdrive 連線池先撐不住（10x 規模最先斷的地方） | 中 | 中 | 提示表都是單行索引查詢；真到瓶頸就把 `device_presence`/`activity_tail` 單獨挪去 KV/DO，這是可局部替換的兩張表 |
| R12 | Workers 本地開發 Hyperdrive 不支援遠端資源、`ratelimit` 不共享部署限額（官方文件明載） | 高 | 低 | 本地開發跑 in-memory store，SQL 路徑走 wrangler remote 或本地 Postgres |
| R13 | 確權封套簽名格式在有人簽過之後才發現要改 | 中 | 高 | P4 就凍 `attest-v1.golden.json`；`av` 獨立於 wire `v`，留乾淨的 v2 空間 |
| R14 | 降級路徑被實作成狀態碼嗅探，違反 repo 的 no-fallback 規則 | 中 | 中 | 能力宣告端點是 P3 的驗收項；code review 檢查沒有 404/405/501 的分支 |

---

## 9. 開放決策（不阻塞 P0）

1. SQL 後端二選一：Postgres via Hyperdrive（成熟、JSONB、可移植）vs D1（零運維、同生態、單庫寫入序列化）。board 的 claim CAS 與 per-subject 序列在兩者上都成立，P2 前定即可。
2. `subject_id` 的來源形狀：SaaS mint pairing code 時攜帶，還是 pair 請求帶一個 SaaS 簽發的 subject token。這決定 `PairingManager` 的介面改動幅度。
3. board 的 claim 是否允許人搶佔 agent 已 claim 的項目（強制 unclaim）。影響 claim CAS 是否需要一條 admin 旁路。
4. `closed` 的準確語義（終止未驗收 vs 歸檔）——本方案取前者，探針未能確認 raft 的原意，若採後者則改為加 `archived_at` 欄位。
5. `@byok/cloud` 的 npm 發佈形態，與 v1 §6.1 的 `@byok-sdk/keys` 同一問題，一起定。

---

## 10. 驗證面

```bash
# 每個 P 里程碑收尾
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

# P3 board 併發驗證（N 並發 claim 只有一個成功）
pnpm --filter @byok/cloud test -- --grep "claim"
```

---

## 11. 證據附錄

**本次實地複核的 file:line（全部當場讀過）**

- 凍結面：`packages/protocol/src/version.ts:1-25`、`__tests__/freeze-guard.test.ts:180-234`（fingerprint 含 `httpApiSchemas`）、`:259-261`（每 message type 恰好一行 golden）、`http-api.ts:115-125,147-165`
- server 現狀：`task-store.ts:46-94`（全同步介面）、`blob-store.ts:36-49`（已 async）、`hub.ts:281-316`（進程內狀態）、`hub.ts:459-476`（`pollEvents` 的 `setTimeout` hold）、`index.ts:67`（`DEFAULT_LONG_POLL_HOLD_MS=50_000`）、`index.ts:179-181`（`tasks.get/list` 公開同步 API）、`http.ts:75-97,99-135,151-200,206-221,255-280`、`auth.ts:76-82`（`DeviceRecord` 無租戶欄位）、`auth.ts:155,187-197`、`pairing.ts:34-40`（pairing code 不綁 subject）、`sqlite-support.ts:1-30`
- hub 的 TaskStore 耦合實測：`grep -c "this.taskStore\." packages/server/src/hub.ts` = **29**
- client 現狀：`long-poll-transport.ts:83-92,296-335,341-351`、`connection-manager.ts:247-248`、`create-daemon.ts:743-744`、`cursor-store.ts:27-33`、`device-keys.ts:24,35,44-45`、`store.ts:13-16`、`types.ts:120-124`（credential-isolation rule）、`control-server.ts:38,170,175`
- 既有可復用模組：`packages/server/src/heartbeat.ts`、`packages/client/src/daemon/progress-batcher.ts`、`packages/client/src/daemon/control-protocol.ts`
- 落地位置：`deploy/sql/` 已存在，root `package.json` 已有 `check:deploy-sql` → `repo-harness run check-deploy-sql-order`

**Cloudflare 官方文件實查（2026-08-05）**

- Workers HTTP 請求**無 wall-time 上限**（只要 client 保持連線）；等待 I/O **不計入** CPU time；runtime 每週更新數次、in-flight 請求只有 **30 秒**寬限期（`/workers/platform/limits/`）。這同時支撐了「SSE 可行」與「50s hold 在派工路徑上不划算」兩個結論
- Workers `ratelimit` binding **2025-09-19 GA**，不需要 Durable Objects（`/workers/runtime-apis/bindings/rate-limit/`）
- 本地開發限制：Hyperdrive 遠端資源不支援、`ratelimit` 不與部署共享限額（`/workers/local-development/`）

**raft-computer v1.0.15 task board 探針（調度方提供，本次未獨立複核）**

task = message + 元數據非獨立真相源；board 是按 channel 過濾的扁平清單；5 態 todo/in_progress/in_review/done/closed；assignee 與 status 解耦；claim 是併發鎖、衝突回占有者快照帶 `observedAt`、task 層無 version/etag（同 binary 的 Wiki 有 ETag，是刻意的不同選擇）；SSE 優先 + 404/405/501 降級輪詢，參數 5s／120s／3s／limit 50；本地→雲端狀態變更是離散顯式 POST；agent 活躍度 5 級逐事件推 + 60s 心跳；活動軌跡走獨立批量通道帶 `dropped`；本機 `/internal/agent-api` 唯讀短路。

**本方案對探針的三處不照抄**（理由見 §4）：狀態碼嗅探降級改為能力宣告（repo 明禁 heuristic 路徑）；status 轉移增加 `expectedStatus` CAS（探針只在 claim 有 CAS）；本機短路 API 改掛既有 Unix socket 控制面而非 loopback HTTP 端口（byok 既有實現更嚴格）。另外砍掉跨網的獨立 wake-hint 通道（SSE 串流本身即該信號）。

**標為 [inferred] / [unverified] 的判斷**：無 DO 時 stateless Worker 無跨 isolate 喚醒原語（由「Workers 無共享記憶體、無內建 pub/sub 原語」推得，非官方明文）[inferred]；`crypto.subtle` 的 Ed25519 在 Node 20 的穩定性——因此 `verifyAttestation` 設計為注入式 verifier（照 repo 既有的 `TokenSigner`/`fetchImpl` 慣用法）[unverified]；raft 的 `closed` 究竟是「終止未驗收」還是「done 後歸檔」[unverified]。
