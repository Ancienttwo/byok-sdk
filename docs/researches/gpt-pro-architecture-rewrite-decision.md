# 決策:GPT Pro 架構重寫 bundle 的採納方式

> 日期:2026-08-07
> 對象:`_ref/byok-architecture-rewrite/`(基線 `ff2a5d4`,與本地 HEAD 一致)
> 結論:**部分採納(方案 B)。不整份替換 canonical 文件,不執行 bundle 的 `apply.sh`。**
> 核對方式:Opus(effort max)對照本地源碼逐條驗證重寫版對當前 runtime 的宣稱;本文件只保留裁定與執行單,完整證據見核對記錄段落。

## 裁定

- `docs/architecture/sdk-architecture.md` 保留現有 P1/P2/P3 + file:line 證據骨架,作為「當前狀態」權威。
- 重寫版中的目標設計增量(狀態模型、storage/journal/crash matrix、身分與 tenant 六層、capability 三層、可觀測性、ADR 帳本、I1-I9、GAP 帳本、交付路線)併入現有 §12-§15,全部掛「目標設計」標記。
- 重寫版對當前 runtime 的錯誤宣稱一律拒收(見下)。
- sprint 檔可作 Proposed 新增到 `plans/sprints/`,但有 4 項前置修正,且需先確認不與 active plan(K 線,Executing)的 `check-task-workflow --strict` 衝突。

## 拒收的錯誤宣稱(重寫版行號 → 源碼證據)

| # | 錯誤 | 證據 |
| --- | --- | --- |
| E1 | daemon 關閉順序寫成 7 步(多出 release leases、preserve workspace) | `create-daemon.ts:793-816` 實際 5 步;`gitLease?.release()` 只在 `task-runner.ts:1246` 的 adapter 啟動失敗路徑 |
| E2 | control socket RPC 虛構 `workspaces`、`unpair` 方法 | `create-daemon.ts:979-1038` 只有 6 個方法;`bin/commands/workspaces.ts` 不走 control client;unpair 走 `shutdown` |
| E3 | Codex network 策略方向寫反(`enforce network:false | no`) | `adapters/codex/permission-mapping.ts:118-125`:fail-closed 在 `network === true` 方向 |
| E4 | presence 五級詞彙錯誤歸因給 RAFT | `raft-architecture-reference.md` 全文 presence 零命中;真實來源 `proposal-byok-platform-v2-opus.md:205` |
| E5 | RAFT board 轉移圖丟 `[unverified]` hedge,還加了證據裡沒有的邊 | `raft-architecture-reference.md:1068` 明標 unverified |
| E6 | P0-P5 編號三重語義衝突(階段 vs 優先級 vs dangling P5) | `ARCHITECTURE-PROPOSAL-byok-platform.md:33-34,692-698` 是權威編號 |
| E7 | 兩張 mermaid 與源碼失配(Blob factory 邊被刪、errors.ts 節點消失) | `packages/server/src/index.ts:143,157`;`packages/protocol/src/errors.ts` |
| E8 | 「reconnect 無 jitter」誤導 | `ws-transport.ts:248-254` 已有 ±20% random jitter,缺的是確定性種子 |
| E9 | 漏 `GET /byok/records/:kind/:key`;丟 RFC 8785 規範號;三個 domain 前綴大小寫不一致 | `ARCHITECTURE-PROPOSAL:195`;`tenant-isolation-decision.md:204` |

> **2026-08-10 evidence correction**：E4 已被 hash-matched RAFT 1.0.15 bundle 推翻。五个值确实存在于 `AGENT_ACTIVITIES`；需要保留的 hedge 是「RAFT 称 activity，BYOK 自有 presence 抽象与 authority」，而不是「词汇不是 RAFT 的」。校正证据见 `2026-08-10_research-raft-cli-dynamic-report.md` F-006。E4 作为历史裁定保留，但不再作为 canonical 依据。

## 併入清單(全部掛「目標設計」標記)

重寫版 §6(四套狀態與一致性模型)、§7(storage/journal/crash matrix/retention)、§9(身分模型、tenant 六層、device proof、rotation;補回 RFC 8785 與統一 domain 前綴)、§11.3(capability 三層)、§12.3-12.5(credential isolation/bypass REJECTED/updater 信任根)、§13.2-13.4(jitter/quarantine/並發表)、§15(可觀測性)、§17(ADR-001..018)、§19.3(I1-I9,與 `tenant-isolation-decision.md:235-243` 零篡改對應)、§22(GAP-001..014,優先級記號改為不與 P 線衝突的寫法)、§20(交付路線,先修 E6)。

## canonical 自身要修的錯(與採納方案無關,一律要改)

1. §7.1:`EnvelopeScopedSecretStore` scope 實為 `account_id + workspace_id`(`packages/keys/src/secret-scope.ts:12-15`),不是 tenant/product/account。
2. §5.1:control socket RPC 面據實列 6 個方法。
3. §11 缺口表補 GAP-004(裸 nonce 無 domain separation,`packages/server/src/auth.ts:155` + `http.ts:125`)與 GAP-005(DeviceRecord 無 tenant 綁定,`auth.ts:76-82`)。
4. §14.2:reconnect 行改為「已有 random jitter,缺 device-id 派生的確定性種子」。
5. §3.3:steer gate 補「`hub.ts:1493-1503` 連 connection-level capability 都不查;`claimedRuntime` 已存在 task record(`hub.ts:145,766`)」。
6. §13:RAFT 表補兩句 hedge(presence 來源、board 轉移 unverified)。

## sprint 檔(Proposed)的 4 項前置

1. 補 P0-P5 / T0-T4 ↔ S0-S7 crosswalk;GAP 優先級改用不衝突記號。
2. 顯式記錄兩處對已決事項的改動:signNonce domain separation P4→S1(保留,理由:與 T0 的 breaking auth cut 合併發布);I1-I9 入口閘分期(S3 進入時 I3/I4/I6 未綠,需聲明 supersede)。
3. 撤回 C1/C2:`AuthenticatedDevice` 在 S1 恢復為 `{deviceId, tenantId, productId}`(`keyId`/`keyEpoch` 移到 S6);`TenantIdLike` 改回 `TenantId`。
4. 修正 sprint 第 8 行的 workflow 狀態誤判(active plan 是 K 線且 Executing,不是 Idle),並實跑 `repo-harness run check-task-workflow --strict` 確認新增檔不紅閘。
5. 另:刪 story points 與人力假設;S4 拆主後端+parity;K-501 不得塞進已封口的 K 線,走新 plan 或 `tasks/todos.md`。

## 為什麼不是整份替換(A)也不是僅存檔(C)

兩份文件不是同一類:canonical 是可復算的 due-diligence 快照(78 處 file/path 引用、LOC 復算命令、CI 六層實證、Git workspace 八項顯式不做);重寫版是設計憲章(ADR/GAP 帳本、狀態模型、測試矩陣)。整份替換會用 4 條當前 runtime 錯誤宣稱換掉 11 類已核實證據,還會拆掉 CLAUDE.md 要求的 P1/P2/P3 結構;重寫版是在無本地 checkout 的 read-only connector 下寫的,E1/E2 這類裝配順序錯誤正是該盲區的產物。僅存檔則浪費已核實的真增量——GAP-004 是 canonical 缺口表漏掉的真缺陷,I1-I9 是零篡改轉錄,crash matrix 與 journal 契約是 canonical 完全空白的面。

## 記功

重寫版規避了 canonical 既有的 secret-scope 錯誤,且 GAP-004/GAP-005 經源碼核實成立;sprint 的 rollback 節與崩潰注入清單(S3.4 六個注入點、S6.3 十四條對抗測試)顆粒度可直接投 contract。

---

## v2 supersede 記錄(2026-08-07)

> 對象:`_ref/byok-architecture-rewrite-v2/`,取代 `_ref/byok-architecture-rewrite/`。
> ZIP SHA-256:`5ee566272d3f4baa23705f78fb5c2530ce54143ff9a301d580af0aeb65148d95`。
> 權威 delta:`diff -u` 兩份 bundle 的 `docs/architecture/sdk-architecture.md` 與 `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md`。

### delta 主題

v2 只動儲存層。本機側把 durable local journal 從 file implementation 改為 SQLite canonical(`SqliteLocalTaskJournal`、WAL/`foreign_keys`/ack-critical `synchronous=FULL`、envelope 與 receipt 同 transaction 才能推 cursor),並新增 `LocalStoragePolicy` 的磁盤水位、分類清理順序與永不自動刪除清單。雲端側把主生產組合定案為 **Postgres + R2**(取代 Postgres/S3 primary + D1/R2 parity;D1 降為 optional post-Beta adapter),新增 tenant storage entitlement/usage/reservation 契約、`quota.ts` core module、reservation/finalize 兩階段防超賣、5 個穩定錯誤碼、滿額行為表與 R2 tombstone/reconcile GC。帳本側新增 ADR-019~022、GAP-015/016、不變量 21~24、storage metrics 與兩條 risk。sprint 側 S2 插入 quota 契約 story、S3 改寫為 SQLite journal + disk-pressure drills、S4 改寫為 Postgres + R2 + quota/GC。

### 裁定

- v1 的併入 rubric 延續適用:仍是方案 B(不整份替換、不執行 `apply.sh`),目標設計增量掛「目標設計」標記併入 repo 現有段落,E1-E9 的拒收清單繼續有效。
- v2 delta 經逐 hunk 篩查**全部為目標設計增量**,沒有新的 current-runtime 事實宣稱,因此不需要新增拒收條目;canonical 的 P1/P2/P3 + `file:line` current-state 骨架一字未動。
- 併入面按 repo 現狀適配而非按 bundle 結構複製:repo 的 sprint 已刪 story points(本文件第 48 行的裁決),v2 的 55 points 規模改以 story 分配到 S4A/S4B 表達,不把 points 加回來;repo 的 S4A/S4B 結構保留但語義重切為「數據面 / quota+GC」,原「第二後端 parity」降為 S4B.8 的 optional adapter 記錄。
- 主生產 backend 選型從待決閘變成已裁定,以 sprint 的 D-3 條目追記,不刪除原 D-1/D-2 與原決策行。

### 本 slice 的工作面

- plan:`plans/plan-20260807-1058-architecture-v2-storage-merge.md`
- contract:`tasks/contracts/20260807-1058-architecture-v2-storage-merge.contract.md`
- notes:`tasks/notes/20260807-1058-architecture-v2-storage-merge.notes.md`
