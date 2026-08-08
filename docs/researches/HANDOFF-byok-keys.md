# Handoff: 在 byok-sdk 新建 `@byok-sdk/keys`（key-based BYOK 獨立包）

> 使用方式：在 `~/Projects/byok-sdk` 開新 session，把本文件作為第一手上下文。
> 本 repo 走 repo-harness 工作流（見 AGENTS.md/CLAUDE.md），建議第一步先把本 handoff 轉成正式 plan（`tasks/current.md` 目前 Idle、Active Plan 為 none），再進入實作。
> 產出本文件的調查基線：aip-main-open@c6a5385、byok-sdk@6037c3b（2026-08-05）。

---

## 0. 已定決策：先走 byok-sdk，copy-port（2026-08-05 定案）

**結論**：`@byok-sdk/keys` 直接在本 repo 從零建包，把 aip-main-open 的實作按層剝離移植過來；aip-main-open 在 K4 之前一行不動。

**依據（都已實測）**：
1. **移植本質是按層剝離，不是搬檔案**——`providers.ts` 的 AiphaBee 拖掛全部集中在 narrative 領域層（見 §4.5），通用層（headers/clients/registry/secrets/scope）拖掛趨近於零。剝離工作在哪個 repo 做都一樣重，那就在不干擾任何人的地方做。
2. **零協調成本**——copy-port 不碰 aip-main-open 任何檔案，開發人員的日更完全不受影響；反之若先在 aip-main-open 內部抽包，等於在他每天編輯的檔案上動遷移手術。
3. **所有權現實**——byok-sdk 100% 在使用者自己名下，今天就能開工；aip-main-open 的 repo 轉移還沒完成。
4. **本 repo 基線已驗綠**（2026-08-05）：`pnpm -r typecheck` 通過，`pnpm -r test` 1229 個測試全過（protocol 181 / server 178 / client 870），可安全接收新包。

早前「先在 aip-main-open 內部抽包」的兩階段建議由此作廢；其核心顧慮（邊界未經驗證）已被 §4.5 的 symbol 級 import 地圖解決，parity 風險由 K4 的黃金測試門禁兜底。

## 1. 任務一句話

把 AiphaBee（`~/Projects/aip-main-open`）裡已上線、有端到端測試的 **key-based BYOK** 實作（API key 存 OS 憑證庫 → 直連 LLM provider），移植成 byok-sdk monorepo 裡的獨立包 `@byok-sdk/keys`，讓 aip-main-open 和使用者的其他專案都能以 npm 依賴的方式消費。

## 2. 背景：三個 repo 與「BYOK」撞名真相

| Repo | 是什麼 | BYOK 含義 |
|---|---|---|
| `~/Projects/aip-main-open`（chenrenya/aip-main-open） | AiphaBee 產品主線，另一位開發人員維護、日更中 | bring-your-own-**key**：使用者貼 API key，local-agent 直連 provider。**這是要移植的源** |
| `~/Projects/byok-sdk`（Ancienttwo/byok-sdk，本 repo） | bring-your-own-**agent** task-dispatch SDK，M5 完成，未發 npm | 調度使用者本機已登入的 claude/codex/pi CLI，明確**不做** key 管理 |
| `~/Projects/AiphaBee`（Ancienttwo/aiphabee） | 舊主線，389 commits，已凍結為參考庫 | 無任何 BYOK 程式碼 |

血緣：aip-main-open 的 `local-execution-protocol`（aiphabee-local-exec-v1）從本 repo 早期協議形狀 fork（共用 `task.offer`/`task.progress`/`task.cancel`），之後兩邊獨立演進成不同產品。本次任務**不**統一協議，只新增 key 管理包。

戰略意圖：`@byok-sdk/keys` 落地後，byok-sdk 成為品牌傘——`@byok/protocol|server|client` 管 agent dispatch，`@byok-sdk/keys` 管 key 管理，撞名問題以包名自解釋的方式解決。

## 3. 目標與非目標

**目標**
1. 新建 `packages/keys`（`@byok-sdk/keys`），沿用本 repo 工具鏈（pnpm workspace、tsup、vitest、TypeScript）。
2. 行為與 aip-main-open 現有實作對等（詳見 §6 驗收），API 面向「任意 SaaS/本機 app」而非 AiphaBee 專屬。
3. 最終里程碑：aip-main-open 的 `apps/local-agent` 刪除被移植的程式碼，改依賴 `@byok-sdk/keys`。

**非目標（明確不做）**
- 不移植 AiphaBee 領域邏輯：narrative/意圖規劃 prompts、finance schemas、`aiphabee://` 協議註冊、legacy secret migration（`#migrateLegacyModelSecret`）。
- 不動 `@byok/client|server|protocol` 的現有行為與 frozen wire v1。
- 不在只有一個消費者的階段預埋推測性配置項——第二個專案接上時再泛化。

## 4. 源材料地圖（aip-main-open，全部已查證）

移植源集中在 `apps/local-agent/src/`，耦合面已量過：**只有 4 個檔案** import BYOK 模組（cli.ts、connected.ts、settings.ts、local-data-claim.ts）。

### 4.1 要移植的核心（→ 進 `@byok-sdk/keys`）

| 能力 | 位置（file:line，基線 c6a5385） |
|---|---|
| Provider 白名單 `LOCAL_MODEL_PROVIDER_IDS`（openai/deepseek/anthropic/custom） | `apps/local-agent/src/providers.ts:30-36` |
| `LocalProviderProfile` 型別（adapter/auth_mode/base_url/model，**不含 key**） | `providers.ts:38-61` |
| SQLite profile 表 schema + `chmod 0o600` | `providers.ts:109-140,158` |
| Registry：`configure()` 寫 Keychain | `providers.ts:1212` |
| Registry：`resolveDefaultModelProvider()` 讀 profile+secret → 建 client | `providers.ts:1331-1348` |
| Keychain 條目命名 `MODEL_PROVIDER_SECRET_NAMES` | `providers.ts:1624-1642` |
| **`providerHeaders()`：bearer → `Authorization: Bearer`；x_api_key → `x-api-key` + `anthropic-version: 2023-06-01`** | `providers.ts:1680-1697` |
| OpenAI-compatible HTTP client（chat/completions） | `providers.ts:511-587` |
| Anthropic HTTP client（Messages API） | `providers.ts:831-1067` |
| `SecretStore` 介面 | `apps/local-agent/src/index.ts:258-268` |
| macOS Keychain 實作（呼叫 `/usr/bin/security`） | `index.ts:413` 起 |
| Windows Credential Manager 實作 | `index.ts:568` 起 |
| 租戶 scope 信封：`scopeLocalAgentSecretStore` + `EnvelopeScopedSecretStore`，scopeId = SHA-256(account_id+workspace_id) | `apps/local-agent/src/local-data-scope.ts:32-37,100-106,129-169` |

### 4.2 可選移植（→ subpath export 或獨立包，K3 再決定）

本機一次性設置頁 server（localhost 隨機端口 + token/Host/Origin/CSP 防護 + `/api/model/configure`、`/api/model/test`）：`apps/local-agent/src/settings.ts:107,244,262-274,493,836,1422`。品牌文案和喚起協議（AiphaBee 用 `aiphabee://settings/model`）必須參數化。

### 4.3 行為對等的黃金測試（移植時作為 parity 依據）

`apps/local-agent/src/settings.test.ts:221-334`（`describe("Local Agent BYOK settings workflow")`）：
- `:313-318` 斷言 provider 端真的收到 `Authorization: Bearer <canary>`、URL 為 `https://api.openai.com/v1/chat/completions`
- `:328,333` 斷言 SQLite 檔案與 status JSON **不含**明文 key

### 4.4 消費方現狀（swap 里程碑時要改的面）

- `cli.ts` import 清單：`LOCAL_PROVIDER_KINDS`、`LocalProviderRegistry`、`normalizeProviderUrl`、`LocalProviderAuthMode`、`LocalProviderConfiguration`、`LocalProviderKind`、`LocalProviderProfile`、`LocalModelProviderId`
- `cli.ts:778`（/ask 取 provider）、`cli.ts:1299-1329`（喚起設置頁）、`connected.ts:2051,2176,2351`（雲端中繼任務取 provider + scope 綁定）
- `apps/local-agent/package.json` 現以 `file:../../packages/*` 依賴 7 個 `@aiphabee/*` 包——swap 時 `@byok-sdk/keys` 以 npm 依賴加入

### 4.5 源檔案的對外拖掛（symbol 級，K0 剝離的依據）

2026-08-05 實測四個源檔案的 outbound imports：

- **`local-data-scope.ts`（scope 信封）**：node 內建 + `LocalExecutionError`（來自 `@aiphabee/local-device-runtime` 的通用錯誤類，移植時在包內重定義即可）+ `KeychainSecretName`/`LocalAgentSecretStore` 型別（本來就要一起移植）。**趨近零拖掛。**
- **`providers.ts`**：通用層只掛 node 內建（sqlite/path/fs/crypto）；AiphaBee 拖掛集中在 narrative 領域層——`createStockQueryIntentPrompt`、`validateStockQueryIntentV1`、`validateStockResearchAnalysisV1`、`STOCK_RESEARCH_ANALYSIS_V1_VERSION`、`ResearchExecutionError`（均來自 `@aiphabee/research-execution-runtime`）+ `StockSdkFinanceConnector`（來自 `./index.ts`）。**這些 symbol 及其所在的 narrative provider 方法留在 aip-main-open**；`@byok-sdk/keys` 只帶走 transport 骨架（providerHeaders、chat/completions 與 Messages API 的通用呼叫、streaming 如有）。
- **`settings.ts`**：額外掛 `./subscription-access.ts`（AiphaBee 訂閱檢查）——佐證 K3 的設置頁 server 若進包必須把這類產品邏輯做成注入點，或乾脆不進包。
- **`index.ts`**：barrel 檔，掛著幾十個 local-* 領域模組；只切走 `SecretStore` 介面與兩個 OS 實作（`:258-268,413,568`），絕不移植整檔。

**K0 的剝離法則**：以「symbol 是否出現在上表拖掛清單」為切線——在清單裡的留下，不在的帶走；帶走後在 aip-main-open 側以 re-export 墊片過渡到 K4 一次清除。

## 5. 目標 repo（本 repo）慣例與約束

- pnpm monorepo（`pnpm@10.33.4`，node >=20），包版本 0.0.1，tsup 打包，vitest 測試（現有 118 個測試檔），protocol 有 frozen golden（`v1.frozen.json`）文化——`@byok-sdk/keys` 的公開 API 穩定後同樣值得立 golden。
- repo-harness 檢查：`check:task-workflow --strict`、`check:task-sync` 等（見根 package.json scripts）。新包、新 plan 都要過這些 gate。
- **安全邊界聲明（本次設計的關鍵約束）**：`@byok/client` 的 credential-isolation rule（`packages/client/src/types.ts:120-124`）與 M5 pilot audit（`docs/security-review-m5-pilot-entry.md`）承諾「agent-dispatch 側永不接觸任何憑證」。`@byok-sdk/keys` 是**獨立包、獨立安全模型**（它的本職就是管 key）。必須做到：
  1. `client`/`server`/`protocol` 三包**不得**新增對 `keys` 的依賴；
  2. 在 `keys` 的 README 和 docs/security.md 增補一節，明說兩個安全模型的分界，避免污染 M5 audit 的 claim。

## 6. 建議里程碑（沿用本 repo 的 M 字頭文化，用 K 字頭區隔）

- **K0 — 骨架 + 純函式層**：`packages/keys` 建包；`ProviderProfile` 型別（zod schema，與 protocol 包風格一致）、`providerHeaders()`、OpenAI-compatible + Anthropic 兩個 client（注入 fetchImpl，mock 測試）。無 OS 依賴，全平台可測。
- **K1 — SecretStore 層**：`SecretStore` 介面 + `InMemorySecretStore`（測試用）+ macOS Keychain + Windows Credential Manager 實作 + scope 信封。OS 實作用 smoke script 驗（照 templates/service 的 smoke-test 模式），CI 跑 fake。
- **K2 — Registry 層**：configure/resolve 生命週期 + 可插拔 profile 持久化（InMemory + SQLite 雙實作，照 server 包 `InMemoryTaskStore`/`SqliteTaskStore` 的既有模式）。移植 §4.3 黃金測試的包內版本。
- **K3 — 設置頁 server（可選）**：決定進 subpath（`@byok-sdk/keys/settings-server`）還是砍掉；品牌/喚起協議參數化。
- **K4 — 回接 aip-main-open（跨 repo，需協調）**：發佈 `@byok-sdk/keys`（npm 公開或 GitHub Packages，待定）；在 aip-main-open 刪除 §4.1 移植走的程式碼、換 npm 依賴；黃金測試 `settings.test.ts` 留在 aip-main-open 作為整合證明，必須原樣通過。

每個 K 收尾跑：`pnpm -r typecheck && pnpm -r test && pnpm -r build`，加 repo-harness gates。

## 7. 風險與協調事項

1. **源碼在漂移**：aip-main-open 的開發人員每天在改 `providers.ts`/`local-data-scope.ts`（「账号隔离」剛動過這兩處）。移植按基線 c6a5385 做；K4 swap 前先 `git diff c6a5385..HEAD -- apps/local-agent/src/providers.ts apps/local-agent/src/index.ts apps/local-agent/src/local-data-scope.ts` 補齊增量。
2. **K4 需要對方配合**：swap 動的是他的日常工作面，動手前對齊時間窗；swap PR 只做「刪碼 + 換依賴」，零行為變更。
3. **Windows 實作細節未深讀**：`index.ts:568` 起的 Credential Manager 實作具體用什麼機制（cmdkey/PowerShell/API）本次未展開，移植時先讀原碼再定測試策略。
4. **npm 發佈形態未定**：公開（repo 是 MIT）vs GitHub Packages 私有——影響其他專案的接入方式，K4 前定即可。

## 8. 參考方案：raft-computer（2026-08-05 實地探索）

`curl -fsSL https://cdn.raft.build/computer/install.sh | sh` 安裝的 `raft-computer` v1.0.15（botiverse/slock，Raft 的本機 computer-agent daemon）。它和 `@byok/client` 是同型態產品：本機 daemon 連 SaaS、讓雲端 agents 跑在使用者機器上。實測值得抄的點：

**安裝與分發（byok-sdk 的 packaging/service 側直接參考）**
- 單檔 SEA binary（~42MB gz，無 Node 依賴）；install.sh 全鏈路驗證：manifest sha256 → gz sidecar 驗證 → 解壓後再驗 → `file -b` 比對 host 平台/arch（防止裝錯平台 binary 上 PATH，腳本註解裡記了一次真實 regression 的教訓）→ staged 原子安裝（`.install.$$` + `mv -f`）
- Release channel 體系：`latest` / `alpha`（staging）/ `pinned:<semver>`，安裝時持久化，`upgrade` 跟隨 channel，支援 `--dry-run` 和 `--rollback`（保留上一版可回滾）
- Rosetta 防呆：darwin 上查 `hw.optional.arm64` 而非信任 `uname -m`
- npm 舊安裝偵測：找到 shadowing 的 npm global 版就勸退，不動使用者的 npm
- Windows 另走 install.ps1（與 aip-main-open 現有 `apps/web/public/downloads/install-windows.ps1` 同路線）

**CLI UX（`@byok/client` 的 bin/byok-agent 參考）**
- `setup <serverSlug>` 複合命令 = login（如需）+ attach + start，一步到位；`--no-start`/`--foreground`/`-y` 逃生口俱全
- `login` 用標準 OAuth device-code flow（瀏覽器開 `app.raft.build/login/device?user_code=XXXX-XXXX`，CLI 輪詢等完成，600s 過期）——比自製 pairing code 更標準，且同一 code 可在手機上完成
- `status` / `doctor --fix`（診斷 + 安全範圍內自癒）/ `logs`，三者都明示 "Secrets are never printed / redacted"——與 aip-main-open 黃金測試「key 不進 status JSON」是同一關注點的產品化表達
- 多 server attach 模型（一台機器連多個 server；logout 保留 attachments）；`runners list/stop` 管理本機在跑的 agents
- 狀態統一放 `~/.slock/`（SLOCK_HOME 可覆寫），跨 binary 換代時登入態自動延續

**與本 repo 的差距對照**：byok-sdk 已有 service lifecycle 範本（launchd/systemd/WinSW）和 SEA/Bun packaging 範本，缺的是 channel + self-upgrade + rollback 體系和 doctor 這類自診斷命令——若要補，歸 `@byok/client` 的後續里程碑，**不進 `@byok-sdk/keys` 範圍**。

## 9. 開工驗證命令

```bash
# 本 repo 健康基線
cd ~/Projects/byok-sdk && pnpm install && pnpm -r typecheck && pnpm -r test

# 源材料現場（隨時可對照）
cd ~/Projects/aip-main-open && git log --oneline -3   # 確認基線之後的漂移
npx vitest run --root . apps/local-agent/src/settings.test.ts   # 黃金測試
```
