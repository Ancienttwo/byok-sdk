RECOMMENDATION: 租戶隔離採四層結構性強制——pairing code 服務端攜帶 tenant 綁定(DTO 零改動、protocol golden 零觸碰)、`TenantId` 品牌型別單一鑄造點、handler 只拿租戶預綁 store facade、全表 tenant_id 前綴複合主鍵——`DeviceRecord` 立即 breaking 加 required `tenantId`/`productId`,無單租戶預設 — confidence: HIGH

# 平台 v2 租戶隔離方案(decision)

> 狀態:決策文檔,supersedes 兩份 proposal 中關於租戶的分散表述(opus §8 R1、codex §6 D3 的 tenant 相關段)。
> 依據:2026-08-05 現場複核(本文所有 `file:line` 當場讀過)+ 已定案的 v2 synthesize 共識(core 契約包 + 無狀態 cloud、device proof 採 codex `DeviceProofEnvelopeV1`、wire v1 FROZEN 零改動)。
> 邊界:本文只定租戶隔離;不重開 board 狀態機、儲存選型、包拆分等已定案內容。

---

## 0. 結論總表

| 問題 | 決定 |
|---|---|
| 身分模型 | `tenant_id` 是唯一安全隔離邊界;`product_id` 是 audience 維度;`scope_id` 是租戶內資料分區(非安全邊界);opus 的 `subject_id` 正名為 `tenant_id`。board 可見性邊界 = tenant 層 |
| pairing 綁定 | 宿主 control plane 簽發 pairing code 時綁定 claims(`{tenantId, productId}`);設備永不自報租戶;`PairRequest` DTO 零改動,golden 零觸碰 |
| DeviceRecord | `tenantId`/`productId` 皆 required、無預設;單租戶 = 顯式命名的一個租戶,不是「無租戶」;registry 無持久化,零資料遷移 |
| enforcement | 三層結構保證:品牌型別鑄造點唯一 → handler 只拿租戶預綁 facade → 全表 tenant 前綴 PK;外加路由窮舉矩陣測試。漏一個 handler 也洩漏不了 |
| proof 閉環 | 等值檢查以「租戶前綴複合鍵查找」結構化實現,權威側 = DB device 行;rotation 不可變更租戶,re-pair 不延續、由新 code 重新綁定 |
| 測試面 | I1-I9 九項,列為 P1 入口閘(§6) |

---

## 1. 正規身分模型

兩份 proposal 的表結構都有租戶欄——opus 全用 `subject_id`(device/task/attested_record/presence/activity),codex 全用 `tenant_id`(device_keys/terminal_records/profiles/...)並另有 `scope_id`。已定案的 `DeviceProofEnvelopeV1` claims 用 `tenantId`。同一概念兩個名字是漂移源,正規模型定一次:

| 識別子 | 語義 | 簽發方 | 在隔離中的角色 |
|---|---|---|---|
| `tenant_id` | 宿主 SaaS 的帳戶/組織單位,安全與計費邊界 | 宿主 control plane(mint pairing code 時) | **唯一的安全隔離邊界**。所有表的分區前綴、所有 principal 的必備欄位、board 可見性的邊界 |
| `product_id` | 哪個宿主產品整合(wire `conn.hello` 已有此欄) | 宿主 control plane(同上) | audience 維度:綁進 device 行、proof claims 攜帶、等值檢查。**不是**可見性邊界——要產品級隔離就開兩個租戶 |
| `device_id` | 租戶成員身分,伺服器在 pair 時生成(`ids.ts:15-17`) | `POST /byok/pair` handler | 恰屬一個 `(tenant, product)`。mailbox/presence 在租戶之下按它分區;board 是跨設備面,不按它隔離 |
| `scope_id` | 租戶內真相層鍵空間分區(如 workspace/project),codex 表結構已有 | 宿主產品語義 | **不是安全邊界**。fail-closed 的地板永遠是 tenant;per-scope entitlement 是後續授權細化,不在本方案驗收面 |

```
tenant ──1:N── device(pairing 時綁定,行內帶 product_id)
   │
   ├──1:N── scope(真相層 profile/memory 鍵空間)
   ├── board(5 態 task,channel 過濾)      ← 可見性邊界 = tenant
   └── outbox / presence / activity        ← 分區鍵 (tenant, device) / (tenant, task)
```

**board 可見性的邊界是 tenant 層。** 同租戶的所有設備與人可見全板;`channel` 是檢視過濾器,不是安全邊界;`assignee` 是指派記錄,不是讀權限。opus 文中「pairing 時綁 subject_id」照此讀作「pairing 時綁 tenant_id」;attestation 封套(若真相層保留 record 級簽名)的 `subject` 欄位同樣正名 `tenantId`,與 proof claims 一致——一個概念一個名字,落庫欄位、封套欄位、型別全用它。

---

## 2. pairing 綁定機制

### 2.1 現狀與新形狀

`createPairingCode()` 今天零參數、code 無主(`pairing.ts:37-42`);`redeemPairingCode()` 只驗一次性與 TTL、不回傳任何身分(`pairing.ts:51-63`);pair handler 兌換成功後憑空 register 設備(`http.ts:82-92`)。新介面:

```ts
// packages/server/src/pairing.ts
export interface PairingCodeClaims {
  tenantId: string;   // non-empty,zod 驗證
  productId: string;  // non-empty
}

export interface CreatePairingCodeOptions {
  ttlMs?: number;       // 預設沿用 10min
  codeLength?: number;  // 預設 8;雲端 composition 固定傳 12(§2.3)
}

class PairingManager {
  createPairingCode(claims: PairingCodeClaims, opts?: CreatePairingCodeOptions): PairingCodeInfo;
  /** 驗證並消耗 code,回傳簽發時綁定的 claims;無效即拋 PairingCodeInvalidError。 */
  redeemPairingCode(code: string): PairingCodeClaims;
}
```

pair handler 的新佈線(`http.ts:75-97`):

```ts
const claims = deps.pairing.redeemPairingCode(pairingCode);
const deviceId = generateDeviceId();
deps.devices.register({ deviceId, tenantId: claims.tenantId, productId: claims.productId, deviceName, devicePublicKey });
```

公開 API(`index.ts:84-85,175-176`)同步改為 `pairing.createPairingCode(claims, opts?)`。

### 2.2 綁定在誰手上、為何 golden 不動

**綁定發生在宿主 control plane 簽發 code 的那一刻。** 自託管:嵌入方在自己已認證的會話裡 in-process 呼叫 `server.pairing.createPairingCode(...)`。雲端:control-plane 認證的 mint 端點 `POST /byok/admin/pairing-codes` `{tenantId, productId, ttlMs?}` → `{code, expiresAt}`。設備側從頭到尾不出現租戶欄位——設備自報租戶就是信任客戶端斷言自己的安全邊界,直接否掉。

**`PairRequest` DTO 零改動是硬約束,已核實其必要性:** `PairRequestSchema` 在凍結指紋的 `httpApiSchemas` 區塊內(`freeze-guard.test.ts:218-232`),任何欄位增減都會漂 `golden/v1.frozen.json`,而 v2 鐵律 4 要求整條 P 線 golden 一個 byte 不動。把租戶載體放在 code 的服務端 claims 是唯一同時滿足「綁定必達」與「golden 零觸碰」的位置。code 的 mint 面本來就不在凍結面上——`http-api.ts:18-22` 的註釋明寫 code 是「out-of-band、由 SaaS 自己的 auth/device-flow UI mint」。

**原子性:** 雲端 redeem + device insert 必須在同一 SQL transaction(code 行標記 `used_at` + device 行 insert 要麼全落要麼全不落);自託管進程內兩個 Map 操作同步連續,無中間態暴露。

### 2.3 轉交攻擊與 code 生命週期

code 本質是 tenant A 的 join token:誰兌換,誰的設備就進入 A。「B 租戶設備使用 A 的 code」不會把 A 的資料錯標到 B——那台設備成為 A 的設備、看見 A 的板,這正是 code 洩漏攻擊的形狀。防線按面列:

| 面 | 機制 |
|---|---|
| 簽發 | code 只在宿主已認證會話內 mint 並經 TLS 顯示;SDK 不提供任何未認證 mint 路徑 |
| 熵與嘗試率 | 現行 8 字 × 32 字母表 = 40 bits(`ids.ts:4-13`)。自託管保留 8(單租戶、通常內網)。雲端公網 redemption:(a) mint 固定 `codeLength: 12`(60 bits);(b) redemption 端點掛 per-IP 與全域率限(Workers `ratelimit` binding,已定案選型);(c) DB 只存 `sha256(code)`(`code_hash`),庫洩不露活碼 |
| 一次性 + TTL | 沿用 single-use + 10min(`pairing.ts:3,51-63`);雲端 redeem+register 同 transaction,不存在半兌換 |
| 事後可見 | pair 成功寫 join 審計事件 `(tenantId, deviceId, deviceName, at)`;宿主 UI 列新設備、可走既有 `devices.revoke`。`deviceName` 是兌換方可控字串——顯示,不作信任依據 |

不採「pending 直到人工確認」閘,理由見否選項 #8。殘餘風險明說:code 在 TTL 窗口內被截獲即等於一次受限的 join——這是 join token 的本質,SDK 層的答案是縮窗(TTL/一次性/熵/率限)加事後可撤(審計+revoke),不是假裝能消除。

---

## 3. DeviceRecord 遷移

### 3.1 新形狀

```ts
// packages/server/src/auth.ts(取代 :76-82)
export interface DeviceRecord {
  deviceId: string;
  tenantId: string;      // required, non-empty,無預設
  productId: string;     // required
  deviceName: string;
  devicePublicKey: string;
  revoked: boolean;
}

// DeviceRegistry.register 改整體傳入,取代三參數位置簽名
register(record: DeviceRecord): void;
```

token 與 bearer 鏈同步收緊:

```ts
// auth.ts:27-29 →
export interface AccessTokenClaims { deviceId: string; tenantId: string; }

// auth.ts:220-227 →
export interface AuthenticatedDevice { deviceId: string; tenantId: string; productId: string; }
authenticateBearer(header, deps): Promise<AuthenticatedDevice | undefined>;
```

`authenticateBearer` 的解析順序:verify token → `registry.get(deviceId)` → revoked/unknown 拒 → **`claims.tenantId !== record.tenantId` 拒**(registry 是權威,token claims 只做交叉驗證,防簽發側錯配)→ 回 principal。`NonceStore` 不動——nonce 綁 deviceId,token mint 時的租戶取自 registry 行,不取自請求。

### 3.2 單租戶語義:required、無預設、「無租戶」不可表達

自託管 `@byok/server` 的單租戶場景,`tenantId` 仍是 required。單租戶的正確表達是**恰好一個、顯式命名的租戶**——嵌入方 mint code 時傳自己選的租戶字串(它的 org id,或它自己定義的常量),所有隔離檢查照常運行,單租戶下恆真、零成本。SDK 不提供 `'default'` 之類的預設:預設值就是隱式全域租戶,嵌入方漏傳即靜默共池,恰好是 fail-closed 要拒的形狀。「無租戶」在型別層不可表達(non-optional)、在邊界層被 zod non-empty 拒絕、在 SQL 層被 `NOT NULL` 拒絕——三層同一句話。

### 3.3 遷移成本:breaking 免費、零資料遷移

- 四包皆 `0.0.1` 未發 npm(本次核實 `packages/*/package.json`),API breaking 無下游。
- `DeviceRegistry` 純進程內 Map、從不持久化(重啟即空,codex 複核 §2.2 亦證),**不存在任何存量 device 資料要遷**——自託管嵌入方升級後重新 pair 即可。
- 改動面:`auth.ts`、`pairing.ts`、`http.ts:75-97`、`index.ts` 公開 API、examples、server 測試。

### 3.4 附帶硬化:conn.hello.productId 等值檢查

`hub.ts` 今天完全不讀 `conn.hello.productId`(本次 grep 零命中)。T0 一併加:處理 `conn.hello` 時檢查 `record.productId === hello.productId`,不符即拒連。純伺服器端行為,wire 零改動;讓 pairing 綁進去的 product 維度真正閉環,而不是寫進行裡就再也沒人看。

---

## 4. enforcement 落點:結構性保證,不是 handler 紀律

核心驗收標準:**漏一個 handler 也洩漏不了**。逐 handler 手寫 `WHERE tenant_id=?` 是紀律不是結構,一次 code review 走神就是整板洩漏——否選。三層結構保證,每層獨立成立:

### 第一層(代碼):品牌型別鑄造點唯一 + 租戶預綁 facade——主保證

```ts
// @byok/core
declare const TenantIdBrand: unique symbol;
export type TenantId = string & { readonly [TenantIdBrand]: true };
```

- **鑄造點唯一**:只有 auth 層(`verifyDeviceProof` / `authenticateControlPlane` / `authenticateBearer`)能把 string 升格為 `TenantId`。repo 級 guard:`as TenantId` 斷言只允許出現在 auth 模組與測試 fixture(I7)。
- **store port 無裸鍵方法**:core 的所有 port(`DeviceAuthorityStore`/`MailboxStore`/`TruthStore`/`BoardStore`/`PresenceStore`)每個方法第一參數是 `TenantId`;不存在任何「以裸 deviceId/taskId 查詢」的簽名。
- **handler 拿不到原始 store**:`@byok/cloud` 的 auth middleware 驗出 principal 後構造 `TenantStores`——每個 store 的租戶預綁視圖,`tenantId` 已閉包進去——handler 只注入這個 facade。漏寫檢查的 handler 能表達的每一條查詢都已經被租戶過濾:不是「應該檢查」,是「無法不檢查」。

principal 兩型,收斂到同一個鑄造點:

| principal | 認證 | 租戶來源 |
|---|---|---|
| `DevicePrincipal { tenantId, productId, deviceId }` | device proof(雲端 device-plane)或 bearer(凍結派工路徑/自託管) | DB device 行——查找即裁決,見 §5 |
| `ControlPlanePrincipal { tenantId }` | per-deployment 部署憑證 | 請求斷言。宿主後端被信任為本部署**全租戶**的權威——宿主 SaaS 本來就是 mint code、渲染 board UI、代表人寫 board status 的一方(opus §4.4「board status 是 subject-authed 普通寫入」的實體就是它);對宿主設租戶牆沒有對象。牆設在租戶與租戶、設備與設備之間 |

信箱認證面無論最終落在凍結 bearer 長輪詢(opus P1「client 零改動」)還是 proof 簽名 pull(codex),兩條路徑都收斂到同一鑄造點與同一 facade——隔離保證與這個選擇正交,不需要在此二選一。

### 第二層(數據):全表 tenant_id 前綴複合主鍵

一條規則統一兩份 proposal 的表:**查找鍵要麼以 `tenant_id` 開頭,要麼本身是 ≥128-bit 服務端隨機 capability(`auth_nonce` 的 nonce、blobId、presigned sig),且行內仍攜帶 `tenant_id` 供綁定驗證。** pairing code 是唯一的低熵例外(它是 join token,防線在 §2.3)。

對 opus §4.6 草案的具體修訂:

- `subject_id` 全部正名 `tenant_id`(task/attested_record/device_presence/activity_tail/subject_stream→tenant_stream);
- `device` 表加 `product_id TEXT NOT NULL`;
- `outbox` PK `(device_id, seq)` → `(tenant_id, device_id, seq)`;`device_stream`、`inbound_dedup` 同理加前綴;
- 新增 `pairing_code` 表:`(code_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, product_id TEXT NOT NULL, expires_at, used_at)`;
- **不建任何裸 `device_id`/`task_id` 的 unique 索引**:想繞過租戶查詢,schema 層就沒有索引可走,手寫 SQL 也逃不掉帶 tenant。

Postgres 部署可再加 RLS(`SET LOCAL app.tenant_id = <principal>`)作額外一道牆;D1 無 RLS,所以 RLS 定位是 additive 硬化,**不是被依賴的主機制**——主保證必須在可移植的 facade 層,兩種 SQL 後端行為一致,不出現「Postgres 安全、D1 靠自覺」的分叉。

### 第三層(測試):路由註冊表窮舉矩陣

測試迭代 cloud router 的**全部已註冊路由**:每條 device-plane 路由必須出現在跨租戶拒絕矩陣 fixture,或顯式標記為 public(如 healthz)。新增 handler 而未入矩陣 → 測試自身失敗,CI 紅。這是「漏一個 handler」在測試層的網;facade 是代碼層的網;複合 PK 是數據層的網。詳 §6 I1。

### blob 特例

兩條 `/content` 路由是 presigned capability、非 bearer-authed(`http.ts:140-149` 註釋);租戶閘設在**簽發面**:`POST /byok/blobs` 建立時記 tenant,`GET /byok/blobs/:id/url` 簽發前檢查 `blob.tenant === principal.tenant`(facade 層自動成立)。URL 本身是短時效 capability,持有即用——與今日語義一致,不新增語義。

---

## 5. 與 device proof 的閉環

已定案 `DeviceProofEnvelopeV1` claims 含 `tenantId`/`productId`/`deviceId`(detached header、RFC 8785 + domain separator、60s skew、requestId 冪等)。租戶交叉驗證的形狀:

**等值檢查以「租戶前綴查找」結構化實現,權威側 = DB device 行。** 驗證順序中的 device/key/epoch binding 一步就是複合鍵查找:

```sql
SELECT ... FROM device_keys
WHERE tenant_id = :claims.tenantId AND device_id = :claims.deviceId
  AND key_id = :proof.keyId AND status = 'active'
```

`claims.tenantId` 是**查找鍵,不是可信輸入**:設備聲稱不屬於它的租戶 → 查無此行 → 401。等值檢查是查找的構造性結果,不是可漏寫的第二步。禁止「先按裸 deviceId 反查、再比對租戶」——那條路需要一個 schema 裡不存在的裸索引(第二層已封),且把單步裁決拆成兩步紀律。

配套規則:

- **401 統一措辭**,不區分 unknown / wrong-tenant / revoked,避免租戶存在性 oracle。
- principal 建立後全程只用 `principal.tenantId`(取自查中的行),claims 不再被讀。
- 簽後篡改 claims 的 `tenantId` 直接死在簽名驗證(claims 在 protected 段內)——I3 測之。
- **key rotation**:以現行有效 key 簽 proof 註冊新 key,`keyEpoch+1`,舊 epoch 立即失效(已定案)。旋轉發生在同一 `(tenant_id, device_id)` 行族之內;**不存在任何能更新 `tenant_id` 的操作**——store port 不暴露該方法、應用層無此 UPDATE、測試斷言之(I4/I7)。租戶綁定對 rotation 不變且不可變。
- **re-pair 不延續租戶綁定**:撤銷後重配對走新 pairing code,綁定由新 code 的 claims 重新建立;deviceId 由伺服器重新生成(現行為即如此,`ids.ts:15-17`),舊行保持 revoked 作審計。同一把設備私鑰(協議 §6.3 允許復用,`device-keys.ts:3-8`)出現在兩個租戶下是合法場景(一台機器服務兩個客戶)——隔離不受影響,因為 key 查找是租戶前綴的,簽名驗證用的是「該租戶行內存的那把公鑰」。
- requestId 冪等收據鍵 `(tenant_id, device_id, request_id)`(codex `device_request_receipts` 表已如此)。

自託管 bearer 路徑的對應閉環在 §3.1:token claims 帶 tenantId、registry 行是權威、不符即 401。

---

## 6. 測試面(P1 入口閘驗收清單)

P1(cloud 骨架)合入前,以下全綠才算隔離落地;I2/I5/I8/I9 隨 T0 先行:

| # | 測試 | 斷言 | 落點 |
|---|---|---|---|
| I1 | 跨租戶路由窮舉矩陣 | 迭代 router 全部已註冊路由;tenant B 的 device principal 打 tenant A 的每種資源(board list/claim/status、mailbox pull/ack、records get/put、presence、activity、blob url 簽發)→ 一律 401/404、零行;存在未分類路由 → 測試自身失敗 | `@byok/cloud` isolation-matrix 測試 |
| I2 | pairing 跨租戶 | A 的 code 兌換 → 設備落 A 且僅 A;code 二次兌換 401;過期 401;無 claims 無法 mint(型別層拒 + runtime zod 拒) | `@byok/server` pairing 測試 |
| I3 | proof 租戶不符 | 合法簽名 + `claims.tenantId = B`(設備屬 A)→ 401;簽後篡改 tenantId → 簽名敗;requestId 重放 → 冪等原結果/409;skew > 60s → 拒 | core/cloud proof 測試 |
| I4 | store conformance 跨租戶不變式 | 每個 store port 方法:T1 寫入、以 T2 讀 → empty/undefined;port 不存在可變更 tenant_id 的方法;InMemory 與 SQL 後端跑同一份套件(沿既有雙實現慣例) | store conformance suite |
| I5 | bearer 交叉驗證 | token `claims.tenantId` 與 registry 行不符 → 401;registry 為權威 | `@byok/server` auth 測試 |
| I6 | board_seq 隔離 | 併發雙租戶寫入下,A 的 SSE/輪詢流永不出現 B 的行;per-tenant 序列互不推進 | cloud board 測試(P3 併入矩陣) |
| I7 | 鑄造點唯一 | `as TenantId` 只出現在 auth 模組與測試 fixture(grep/lint 測試);store port 簽名全部 tenant-first(型別測試) | repo 級 guard |
| I8 | golden 零漂 | `git diff --exit-code packages/protocol/src/__tests__/golden/` + freeze-guard 全綠——機檢證明 pairing 綁定未碰 DTO | 既有機檢 |
| I9 | productId 等值 | `conn.hello.productId` 與 device 行不符 → 拒連 | `@byok/server` hub 測試 |

---

## 7. 遷移步驟

| 步 | 時點 | 內容 | 驗證 |
|---|---|---|---|
| **T0** | 即刻,先於 P 線任何資料落庫 | `@byok/server` breaking cut:`DeviceRecord` + tenantId/productId、`PairingCodeClaims`、redeem 回傳 claims、pair handler 佈線、`AccessTokenClaims` + tenantId、`authenticateBearer` → `AuthenticatedDevice`、`index.ts` 公開 API、conn.hello productId 檢查、examples 與測試更新 | `pnpm -r run typecheck/test/build`;I2/I5/I8/I9 |
| **T1** | P0(core 契約包) | `TenantId` 品牌、Principal 型別、store port 全部 tenant-first 簽名 | I7;core 無 protocol 依賴斷言(既定 P0 驗收) |
| **T2** | P1 入口閘 | cloud auth middleware(proof + control-plane)→ `TenantStores` facade;隨第一條路由建立 I1 矩陣骨架;control-plane mint 端點 | I1/I3 |
| **T3** | P2(SQL) | 全表 tenant_id 前綴 PK migration(`deploy/sql/`,過 `check:deploy-sql`);`pairing_code` 表(code_hash);conformance 跨租戶不變式;Postgres RLS 作可選硬化 | I4;`pnpm run check:deploy-sql` |
| **T4** | P3(board) | board/presence/activity 路由自動入 I1 矩陣;join 審計事件;board_seq 隔離 | I1 擴展、I6 |
| 文檔 | 隨 K3 的 `docs/security.md` 編輯窗 | 新增多租戶邊界節:隔離三層結構、control-plane 信任模型、pairing 轉交攻擊殘餘風險 | review |

回滾:T0 無存量資料(registry 進程內),revert commit 即回;T1-T4 皆為新增包/新增表,刪除即回。整條路徑不需要任何資料遷移腳本。

---

## 8. 否選項

1. **tenantId 進 `PairRequest` DTO(設備自報租戶)**——雙重否:漂凍結的 `httpApiSchemas` 指紋(`freeze-guard.test.ts:218-232`),且信任客戶端斷言自己的安全邊界。
2. **optional tenantId + 單租戶預設 `'default'`**——隱式全域租戶;嵌入方漏傳即靜默共池,違 fail-closed。
3. **逐 handler 手寫 `WHERE tenant_id=?`**——紀律不是結構;正是驗收標準要排除的形狀。
4. **只靠 Postgres RLS 作主機制**——D1 無 RLS,雲端主線不可移植;降為第二道牆。
5. **JWT/proof claims 直接作租戶權威**——claims 是斷言;DB 行是權威,claims 只做查找鍵與交叉驗證。
6. **deviceId 全域唯一即可、保留裸索引反查**——留下裸索引就留下繞過面;複合鍵讓「忘了帶租戶」在 SQL 層不可表達。
7. **scope_id 升格為安全邊界(per-scope 硬隔離)**——v2 過度設計;tenant 是地板,scope 是授權細化,entitlements 到需要時再加。
8. **pairing pending-confirm 閘(人工確認後才生效)**——多一個設備狀態與一段宿主 UX,而宿主本來就掌握 mint→顯示→撤銷全鏈;SDK 提供 join 審計事件即可,宿主要確認閘可自建在 mint 流程裡。
9. **雲端另發一套與自託管不同的 DeviceRecord 形狀**——兩份真相;單一 `DeviceRecord` 契約進 core,雲端與自託管共用。

---

## 9. 上抛

逐條比對後,已定案內容與租戶隔離**無真衝突**。兩處表面分歧在本方案內消解,不需重開共識:

1. **命名**:opus 全文 `subject_id`/attestation `subject` vs 已定案 proof claims `tenantId`——同一概念,正名 `tenant_id`,落庫、封套、型別一律用它(§1)。
2. **信箱認證面**:opus 沿用凍結 bearer 長輪詢、codex 用 proof 簽名 pull——principal 構造收斂到同一鑄造點與同一 facade,隔離保證與該選擇正交(§4 第一層);P1 實作按已 synthesize 的端點表取捨即可,不影響本方案任何條款。

---

## 10. 證據

本次現場複核(2026-08-05,全部當場讀過):

- 缺口本體:`packages/server/src/auth.ts:76-82`(`DeviceRecord` 無租戶欄)、`packages/server/src/pairing.ts:34-42,51-63`(code 無主、redeem 無回傳)、`packages/server/src/http.ts:75-97`(pair handler 憑空 register)。
- 凍結面:`packages/protocol/src/__tests__/freeze-guard.test.ts:218-232`(`httpApiSchemas` 含 `pairRequest`/`pairResponse` 在指紋內)、`packages/protocol/src/version.ts:25`(v1 FROZEN)、`packages/protocol/src/http-api.ts:18-29`(pairing code 定位為 out-of-band mint;`PairRequestSchema` 三欄)。
- 現場輔證:`packages/server/src/ids.ts:4-13`(8 字 × 32 字母表 = 40 bits)、`ids.ts:15-17`(deviceId 每次 pair 重新生成)、`packages/server/src/index.ts:84-85,175-176`(`createPairingCode` 公開面)、`packages/client/src/daemon/device-keys.ts:3-8`(keypair 跨 re-pair 復用)。
- 本次命令核實:`grep -n "productId" packages/server/src/hub.ts` → 零命中(hub 不讀 conn.hello.productId);`packages/{protocol,server,client,keys}/package.json` 皆 `0.0.1`(未發 npm,breaking 免費);`DeviceRegistry` 無持久化路徑(auth.ts 全文,Map only;sqlite 側僅恢復 task record)。
- 已定案輸入:`docs/researches/proposal-byok-platform-v2-opus.md`(§4.6 表結構、§8 R1、鐵律 4)、`proposal-byok-platform-v2-codex.md`(§5.2 表結構、§6 `DeviceProofEnvelopeV1`、§11.1 invariant 5)、`ARCHITECTURE-PROPOSAL-byok-platform.md`(兩線鐵律)、`docs/security.md`(credential-isolation 邊界、SaaS-as-proposer 定位)。
