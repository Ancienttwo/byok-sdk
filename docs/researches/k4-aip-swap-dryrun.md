# K4（aip swap）唯讀可行性 dry-run

> 調查日期：2026-08-07。兩個 repo 全程唯讀，aip-main-open 未寫入任何位元組、未執行任何寫狀態命令。
> 本文件是 K4 動工前的事實基線，不是決策。決策權在 orchestrator。

---

## 0. 現場快照

| Repo | Branch | HEAD | Dirty |
|---|---|---|---|
| `/Users/ancienttwo/Projects/byok-sdk` | `main`（與 `origin/main` 同步） | `f81e844` chore(workflow): archive the GPT Pro architecture merge slice | 乾淨，無 WIP |
| `/Users/ancienttwo/Projects/aip-main-open` | `main`（與 `origin/main` 同步） | `fbefda1` 归档 gitignore-harness-commit 工作流工件 | 乾淨，無 WIP |

`git status --short --branch -uall` 在兩邊都只輸出 branch 行，沒有 modified / staged / untracked。aip 側沒有需要繞開的 WIP。

移植基線 `c6a5385`（修复切换账号和local-agent在线显示）在 aip 本地存在（`git cat-file -t c6a5385` → `commit`），歷史完整。`c6a5385..HEAD` 共 5 個 commit：

```
fbefda1 归档 gitignore-harness-commit 工作流工件
01a39c9 忽略 harness 运行时锁目录 .ai/harness/.locks
c1e8203 接入 repo-harness 工作流骨架与运行时忽略规则
a30e4ab 跨电脑登录区分用户
a396942 区分用户local-agent
```

驗證環境：Node v22.22.0。`packages/keys` 本次實跑 `pnpm run build`（exit 0）與 `pnpm run test`（exit 0，15 檔 328 tests 全過）。

---

## 1. Drift：`c6a5385..HEAD` 對移植面的影響

### 結論：移植面零漂移，**不需要任何回灌**。

逐檔 diff（`git diff --stat c6a5385..HEAD -- <被移植檔案>`）：

| 檔案 | 移植角色 | c6a5385..HEAD 變更 | 需要回灌？ |
|---|---|---|---|
| `apps/local-agent/src/providers.ts` | 主源（headers / clients / registry / profile store） | **0 行** | 否 |
| `apps/local-agent/src/local-data-scope.ts` | scope 信封 | **0 行** | 否 |
| `apps/local-agent/src/settings.ts` | K4 消費方 + 黃金測試宿主 | **0 行** | 否 |
| `apps/local-agent/src/providers.test.ts` | 源測試 | **0 行** | 否 |
| `apps/local-agent/src/settings.test.ts` | §4.3 黃金測試 | **0 行** | 否 |
| `apps/local-agent/src/local-data-scope.test.ts` | 源測試 | **0 行** | 否 |
| `apps/local-agent/src/index.ts` | SecretStore 介面 + 兩個 OS 實作 | **3 行**（+3/-3） | 否，見下 |

`index.ts` 唯一的 diff（`git diff c6a5385..HEAD -- apps/local-agent/src/index.ts`）：

```diff
@@ -235,10 +235,10 @@
-export const LOCAL_AGENT_VERSION = "0.1.38" as const;
-export const LOCAL_AGENT_BUILD = 40 as const;
+export const LOCAL_AGENT_VERSION = "0.1.39" as const;
+export const LOCAL_AGENT_BUILD = 41 as const;
 export const LOCAL_AGENT_RELEASE =
-  "2026-08-05.multi-account-agent-grants.v1" as const;
+  "2026-08-05.account-profile-switch.v1" as const;
 export const KEYCHAIN_SERVICE_PREFIX = "com.aiphabee.local-agent" as const;
```

三個發版常數，位在 `:238-241`。被移植的三個區段（`SecretStore` 介面 `:261-269`、macOS Keychain `:413` 起、Windows Credential Manager `:568` 起）以及 K4 需要保持位元組相容的 `KEYCHAIN_SERVICE_PREFIX = "com.aiphabee.local-agent"`（`index.ts:242`）全部未動。

這 5 個 commit 的實際變更集中在三處，都與移植面無關：

- **帳號隔離延續**（`a396942`、`a30e4ab`）：`connected.ts`（+124）、`connected.test.ts`（+219）、`apps/web/src/lib/localAgentSessionBootstrap.ts`（新增 249 行）、`apps/web/src/lib/context/SessionContext.tsx`（+84）、`apps/worker/src/local-execution.ts`（+34）
- **repo-harness 接入**（`c1e8203`）：`.ai/harness/**`、`.claude/templates/**`、`tasks/**`、`plans/**`
- **gitignore 收尾**（`01a39c9`、`fbefda1`）

> 計畫 `plans/plan-20260805-1659-byok-keys-package.md:85` 的風險行寫「aip-main-open HEAD 已漂到 `a30e4ab`，比基線多 2 個 commit」。現在是 5 個，但移植面依然是 0 行。這一行風險可以在 K4 收尾時標記為已消解。

---

## 2. Swap 面清點

### 2.1 移植的不是檔案，是三個檔案裡的部分 symbol

三個源檔案在 swap 後**都不能刪**，只能刪其中一部分 symbol：

**`apps/local-agent/src/providers.ts`（2327 行）**

| 走（已進 `@byok-sdk/keys`） | 留（AiphaBee 領域 / market_data 分支） |
|---|---|
| `LOCAL_MODEL_PROVIDER_IDS` `:30-36` | `LOCAL_PROVIDER_KINDS` `:27`、`LocalProviderKind` `:28` |
| `LocalProviderProfile` model 分支 `:38-61` | `LocalProviderProfile` market_data 分支 `:38-51` |
| `LocalProviderProfileStore` `:147-338` | `McpHttpFinanceConnector` `:339-477` |
| 兩個 client 的 **transport 半邊**（`:478-1067` 內混雜） | 兩個 provider 的 **narrative 半邊**：`planQueryIntent` `:503,862`、`generate` `:545,882`、`generateResearch` `:603,917`、`reviewResearch` `:668,960`、`analyzeImage` `:723,992` |
| `LocalProviderRegistry` model 半邊 `:1163-1488` | `UnavailableNarrativeProvider` `:1118-1160`、`createNarrativeProvider` `:1699-1712` |
| `normalizeProviderUrl` `:1558`、`requiredProviderSecret` `:1657`、`providerHeaders` `:1681`、`classifyModelProviderHttpError` `:1783` | `providerResolutionErrorCode` `:1673-1678`、`#migrateLegacyModelSecret` `:1458` |

**`apps/local-agent/src/index.ts`（2670 行，barrel）**：只切 `SecretStore` 介面 `:261-269`、macOS 實作 `:413` 起、Windows 實作 `:568` 起、`normalizeSecretNamespace` `:748-757`。其餘幾十個 local-* 模組原地不動。

**`apps/local-agent/src/local-data-scope.ts`（196 行）**：走 `localAccountDataScopeId` `:32-37`、`scopeLocalAgentSecretStore` `:100-106`、`EnvelopeScopedSecretStore` `:129-193`、`serializeSecretEnvelope` `:194-199`。留 `LOCAL_ACCOUNT_DATA_SCOPE_VERSION` `:17`、`localAccountDataDirectory` `:39-48`、`prepareLocalAccountDataScope` `:50-98`（scope manifest 落盤，aip 專屬）。

### 2.2 import 圖：誰要改

| 檔案:行 | 目前 import | swap 後 |
|---|---|---|
| `apps/local-agent/src/cli.ts:44-54` | `LOCAL_PROVIDER_KINDS`, `LocalProviderRegistry`, `normalizeProviderUrl`, `LocalProviderAuthMode`, `LocalProviderConfiguration`, `LocalProviderKind`, `LocalProviderProfile`, `LocalModelProviderId` from `./providers.ts` | 仍從 `./providers.ts` 取（adapter 就住在這），`normalizeProviderUrl` 改為 `./providers.ts` re-export 自 `@byok-sdk/keys` |
| `apps/local-agent/src/cli.ts:92` | `./local-data-scope.ts` | 不變（`prepareLocalAccountDataScope` 留在 aip） |
| `apps/local-agent/src/cli.ts:26` | `createDefaultLocalAgentSecretStore` from `./index.ts` | 不變，但工廠內部改建 `@byok-sdk/keys` 的 OS store（見 2.3 第 4 條） |
| `apps/local-agent/src/settings.ts:11-15` | `LocalProviderRegistry`, `LocalProviderConfiguration`, `LocalProviderStatus`, `LocalModelProviderId` | 不變（adapter 保持同名同形） |
| `apps/local-agent/src/connected.ts:54,72` | `LocalProviderRegistry`、`scopeLocalAgentSecretStore` | 不變 |
| `apps/local-agent/src/local-data-claim.ts:23,25` | `LocalProviderProfileStore`、`LocalAccountDataScope` | 不變（見 2.3 第 1 條） |
| `apps/local-agent/src/local-data-migration.ts:13` | `LocalAccountDataScope` | 不變 |
| 測試：`providers.test.ts:27`、`settings.test.ts:10`、`connected.test.ts:52,56`、`local-data-claim.test.ts:18,21`、`local-data-scope.test.ts:13`、`index.test.ts:38`、`local-data-migration.test.ts:9` | 同上 | 全部不變（這是 K4 的驗收條件之一） |

**關鍵事實**：aip 沒有任何檔案跨過 `providers.ts` / `local-data-scope.ts` 的模組邊界去 import 內部符號。所有消費都走這兩個模組的 export。這意味著「把 `providers.ts` 改成一層 adapter，內部改調 `@byok-sdk/keys`」可以做到**對所有消費方零 import 變更**。這是 K4 最重要的正面事實。

### 2.3 會斷的地方（逐條，都不在計畫的 K4/K4.1 清單裡）

**1. SQLite 表名與 schema 分歧 —— 這是 K4 最大的未識別風險。**

- aip：表名 `local_provider_profile`，主鍵欄 `profile_id`，同時容納 `market_data` 與 `model` 兩種 kind，有 `tool_name` 欄，CHECK 約束覆蓋兩支（`providers.ts:109-140`），部分唯一索引 `local_provider_one_active_model`（`providers.ts:141-145`）。
- byok：表名 `provider_profile`，主鍵欄 `provider_id`，僅 model，無 `tool_name`（`packages/keys/src/sqlite-profile-store.ts:33-46`），索引 `provider_profile_one_enabled`（`:57-60`）。

同一個檔案 `local-agent.sqlite` 還住著另外 11 張 aip 的表，而 `local_provider_profile` 被列在 `local-data-claim.ts:51` 的 `CLAIMABLE_TABLES` 裡 —— 帳號 claim 遷移會逐表複製記錄。若 aip 改用 `SqliteProviderProfileStore`：

- 每個既有安裝的 model profile 會「消失」（key 還在 Keychain，profile 讀不到），設定頁顯示未配置；
- `local-data-claim.ts` 的 claim 會靜默漏掉 model profile（它按表名找）；
- **黃金測試抓不到**。`settings.test.ts:328-331` 只斷言 `local-agent.sqlite` 的位元組不含 canary，不斷言表名或既有資料能讀回。

**2. `LocalProviderStatus` 少欄位。** aip 的 `LocalProviderStatus`（`providers.ts:73-85`）有 `kind` 與 `tool_name`；byok 的 `ProviderStatus`（`packages/keys/dist/registry.d.ts`）兩者都沒有。消費點：`settings.ts:522-527`（`publicModelStatuses` 用 `profile.kind === "model"` 過濾）、`settings.ts:558-565`（`canReuseExistingSecret` 讀 `status?.kind === "model"`）。adapter 必須把 `kind: "model"` 補回去，並把 aip 自己的 market_data 列合併進 `list()`。

**3. Registry 建構子形狀不同。** aip：`new LocalProviderRegistry({ dataDirectory, fetchImpl, keychain, now })`（`providers.ts:1169-1180`），用在 `settings.test.ts:55`、`connected.ts:2364-2369`、`cli.ts:293,765`。byok：`new ProviderRegistry({ profileStore, secretStore, fetchImpl, now })`。**「黃金測試原樣通過」意味著 aip 側必須保留這個建構子**，所以不可能把 `LocalProviderRegistry` 直接 alias 成 `ProviderRegistry`。

**4. `SecretStore` 介面雙向不相容。**
   - aip → byok：`LocalAgentSecretStore.scope?` 是**可選**（`index.ts:266`），byok 的 `SecretStore.scope` 是**必需**。`settings.test.ts:16-38` 的 `MemorySecretStore` **沒有實作 `scope()`**。aip 的 typecheck 是 `tsc --noEmit`，`apps/local-agent/tsconfig.json` 的 `include` 是 `["src/**/*.ts"]`，**測試檔在內**。所以把黃金測試的 fixture 直接餵給 byok 的 registry 會讓 `npm run typecheck --workspaces` 失敗 —— 這直接違反「原樣通過」。
   - byok → aip：`SecretStore.providerLabel: string`，aip 的是字面量聯集 `"macOS Keychain" | "Windows Credential Manager"`（`index.ts:262`）。byok 的 `MacOsKeychainSecretStore` 因此**不可賦值**給 `LocalAgentSecretStore`，`createDefaultLocalAgentSecretStore`（`index.ts:719`，消費於 `cli.ts:26,149`、`index.test.ts:12,111,131`）的回傳型別要一併處理。

**5. `registry.test(kind, providerId?)` 沒有對應物。** `providers.ts:1389-1416`，消費於 `cli.ts:987`。byok 的 `ProviderRegistry` 沒有 `test()`。計畫的 K4.1 三面沒列到它。

**6. `resolveDefaultModelProvider()` 語義變了。** aip 回傳 `LocalResearchNarrativeProvider | undefined`，錯誤時回傳 `UnavailableNarrativeProvider` 空物件（`providers.ts:1336-1352`）；byok 回傳 transport client 或 `undefined`，錯誤時**丟例外**。消費點 `cli.ts:778`、`connected.ts` 的雲端中繼路徑。adapter 必須 catch `ByokKeysError` 再包回 `UnavailableNarrativeProvider`，把 `providerResolutionErrorCode` 的角色接上。計畫的 K4.1 三面也沒列到它。

### 2.4 已驗證位元組相容的部分

| 項目 | aip | byok | 相容 |
|---|---|---|---|
| Keychain 條目名 | `providers.ts:1624-1632`：`model-{openai,deepseek,anthropic,custom}-api-key` | `secret-store.ts:55-60` 同字串 | ✅ 逐字相同 |
| scope id 演算法 | `local-data-scope.ts:32-37`：`acct_` + SHA-256(`${account_id}\n${workspace_id}`) | `secret-scope.ts:29-33` 同式 | ✅ 逐字相同 |
| 信封前綴 | `local-data-scope.ts:30` 硬編 `aiphabee-scoped-secrets-v1:` | `secret-scope.ts:21` 預設 `byok-scoped-secrets-v1:`，建構子 `options.envelopePrefix` 可注入 | ✅ 需明確傳值 |
| service prefix | `index.ts:242` `com.aiphabee.local-agent` | `DEFAULT_SECRET_SERVICE_PREFIX = 'com.byok.keys'`，兩個 OS backend 建構子可注入 | ✅ 需明確傳值 |
| namespace 驗證式 | `index.ts:750` `/^[a-z0-9][a-z0-9_-]{7,95}$/u` | `secret-name.ts:25` 同式 | ✅ 逐字相同 |
| `providerLabel` 值 | fixture 斷言 `"macOS Keychain"`（`settings.test.ts:17`，經 `settings.ts` 進 status 文字，`settings.test.ts:330` 斷言） | `macos-keychain.ts:52` `'macOS Keychain'` | ✅ 逐字相同 |

---

## 3. 兩處 `instanceof LocalExecutionError`

`LocalExecutionError` 定義在 `packages/local-device-runtime/src/index.ts:88`。全 repo 共 14 個 `instanceof` 站點；與 K4 相關的在兩個被移植檔案裡有 4 個，其中只有 **2 個真的要改**。

### 3.1 `settings.ts:358` —— `publicSettingsError()`

現狀（`settings.ts:348-371`）：

```ts
function publicSettingsError(error: unknown): { code?: string; error: string } {
  if (error instanceof ResearchExecutionError) { ... }
  if (error instanceof LocalExecutionError) {
    return {
      code: error.code,
      error: error.code.startsWith("MODEL_") || error.code === "PROVIDER_REQUEST_TIMEOUT"
          ? modelValidationErrorMessage(error.code)
          : error.message          // ← 未知碼會把 error.message 原文吐給 HTTP client
    };
  }
  if (error instanceof SettingsHttpError) { return { error: error.message }; }
  return { error: "本机设置操作失败" };
}
```

**改成 code-based 的正確形狀是白名單，不是 duck-typing。** 現在 `instanceof` 失敗會落到最後的通用文案；若換成 `typeof (error as any).code === 'string'`，Node 的系統錯誤（`ENOENT`、`EACCES` 等都帶 `.code`）會命中這一支，把含檔案路徑的 `error.message` 洩漏進 HTTP 回應。這是一個真實的行為退化。

`@byok-sdk/keys` 已經 export `BYOK_KEYS_ERROR_CODES`（`packages/keys/src/errors.ts:39-74`），所以白名單可以直接寫：

```ts
function structuredErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return undefined;
  return (error instanceof LocalExecutionError
       || error instanceof ResearchExecutionError
       || code in BYOK_KEYS_ERROR_CODES) ? code : undefined;
}
```

保留 `instanceof` 兩支是必要的：`settings.ts` 自己就丟 `LocalExecutionError`（`:445`、`:502`、`:545`、`:580`），這些 code 不在 `BYOK_KEYS_ERROR_CODES` 裡。改用 code-based 的動機不是「替換 instanceof」，而是「跨 npm 套件邊界的 `instanceof` 在雙實例安裝下會失效」，所以是**擴充**判斷，不是替換。

**code 覆蓋度核對**（`modelValidationErrorMessage`，`settings.ts:373-392`）：

| code | 在 `BYOK_KEYS_ERROR_CODES`？ |
|---|---|
| `MODEL_PROVIDER_AUTH_FAILED` | ✅ |
| `MODEL_PROVIDER_BALANCE_INSUFFICIENT` | ✅ |
| `MODEL_PROVIDER_MODEL_NOT_FOUND` | ✅ |
| `MODEL_PROVIDER_RATE_LIMITED` | ✅ |
| `MODEL_RESPONSE_INVALID` | ✅ |
| `PROVIDER_REQUEST_TIMEOUT` | ✅ |
| `MODEL_PROVIDER_TIMEOUT`（`settings.ts:384`） | ❌ —— 但全 aip 只有這一行提到它，**沒有任何產生者**，是既有死碼，非缺口 |

結論：`@byok-sdk/keys` 的 code 覆蓋 `publicSettingsError` 需要的全部有效判斷值，**無缺口**。

### 3.2 `providers.ts:1673-1677` —— `providerResolutionErrorCode()`

```ts
function providerResolutionErrorCode(error: unknown): string {
  return error instanceof LocalExecutionError || error instanceof ResearchExecutionError
    ? error.code
    : "PROVIDER_CONFIGURATION_UNAVAILABLE";
}
```

消費於 `providers.ts:1305,1321,1337,1351`，全部餵給 `UnavailableNarrativeProvider`；fallback 值 `PROVIDER_CONFIGURATION_UNAVAILABLE` 一路傳到前端 `apps/web/src/lib/localExecutionPresentation.ts:78`。

同一個 `structuredErrorCode()` 白名單用在這裡即可，`?? "PROVIDER_CONFIGURATION_UNAVAILABLE"`。注意 `PROVIDER_CONFIGURATION_UNAVAILABLE` **不在** `BYOK_KEYS_ERROR_CODES` 裡，這是對的 —— 它是 aip 的空物件語義，不該進 keys。

### 3.3 另外兩個站點：不用改

- **`settings.ts:428`** `isSubscriptionAuthorizationFailure` —— 判斷 6 個訂閱碼（`ENTITLEMENT_OFFLINE` / `ENTITLEMENT_REVOKED` / `PAYMENT_REQUIRED` / `QUOTA_EXCEEDED` / `SUBSCRIPTION_EXPIRED` / `SUBSCRIPTION_REQUIRED`），來源是 aip 的 `subscription-access.ts`，沒有一個出現在 `BYOK_KEYS_ERROR_CODES`。維持 `instanceof` 正確且更嚴格。
- **`providers.ts:1758`** 在 `readModelProviderResponse` 內 —— 這段本身就是被移植的 transport，會隨移植刪除，不需轉換。

---

## 4. `SECRET_NAMESPACE_INVALID` 歸屬

### 現狀：**兩邊都定義了，但兩邊都只丟不判**。

| | 定義處 | 丟出處 | 分支消費者 |
|---|---|---|---|
| aip | `apps/local-agent/src/index.ts:752`（字面量，內聯在 throw 裡） | `normalizeSecretNamespace`（`index.ts:748-757`） | **無**。呼叫點只有 `index.ts:471`（macOS `scope()`）與 `index.ts:632`（Windows `scope()`），都只是組 servicePrefix |
| byok | `packages/keys/src/errors.ts:72`（`BYOK_KEYS_ERROR_CODES` 常數） | `assertSecretNamespace`（`packages/keys/src/secret-name.ts:47`） | **無產品程式碼**。只有 5 個測試檔斷言它 |

驗證式逐字相同：aip `index.ts:750` 的 `/^[a-z0-9][a-z0-9_-]{7,95}$/u` == byok `secret-name.ts:25` 的 `SECRET_NAMESPACE_PATTERN`。

### swap 後歸屬：**keys，且不會出現雙定義** —— 前提是 aip 連 `normalizeSecretNamespace` 一起刪。

`normalizeSecretNamespace` 是 `index.ts:413` / `:568` 兩個 OS store 的私有 helper，只有它們兩個呼叫。移植這兩個 store 就必然一起刪掉它 `:748-757`，字串在 aip 側隨之消失。K4 的 checklist 需要明確包含這一刪除，否則會留下一個死的重複定義。

**順帶記一個文件缺陷**：`packages/keys/src/errors.ts:30-36` 的註解說 `SECRET_NAMESPACE_INVALID` 「no source code string is recorded for its rejection path — so treat the code itself as this package's, not as a compatibility surface K4 must match」。這不成立 —— `aip index.ts:752` 就是逐字的 `"SECRET_NAMESPACE_INVALID"`。實務影響為零（兩邊都無分支消費者），但這段註解正好寫在定義 K4 相容面的檔案裡，應該修正為「字串與源相同，且兩側皆無分支消費者，因此不構成相容約束」。

---

## 5. Publish 就緒度

### 5.1 已就緒

| 項 | 狀態 |
|---|---|
| `name` | `@byok-sdk/keys` ✅ |
| `type` / `exports` / `main` / `module` / `types` | ESM-only，`.` + `./package.json` 雙 export，與 `@byok/protocol|server|client` 完全一致 ✅ |
| `files` | `["dist"]`；`npm pack --dry-run` 實測 22 個檔案，README.md 7.3kB 有進包（npm 永遠打包 README/LICENSE/package.json） ✅ |
| `sideEffects: false` | ✅ |
| `engines.node` | `>=20`，與 `isSqliteAvailable()` 的執行期閘門一致（K3 notes 已論證） ✅ |
| 依賴 | 只有 `zod ^4.4.3`；實測 `dist/index.js:1` 是 `import { z } from 'zod'`，external 未 bundle，宣告正確 ✅ |
| `node:sqlite` | 型別為 `import type`，執行期走 `createRequire(import.meta.url)("node:sqlite")`（`dist/index.js:1178`），無原生依賴 ✅ |
| build | `pnpm run build` exit 0（tsup ESM 48.59 KB + `tsc -p tsconfig.build.json` 產 18 個 `.d.ts`） ✅ |
| test | `pnpm run test` exit 0，15 檔 328 tests 全過 ✅ |
| README | 136 行，有 Security boundary、Not in this package、Node/backend 說明、Provenance ✅ |

### 5.2 缺什麼（按阻斷性排序）

1. **未登入 npm。** `npm whoami` → `401 Unauthorized`。硬阻斷。
2. **npm identity 已在 2026-08-08 更正為 `@byok-sdk/keys`。** `byok-sdk@0.0.1` 是占位包且其 description 明定正式 packages 使用 `@byok-sdk`；`npm org ls byok-sdk --json` 讀回 `ancienttwo: owner`。原 `@byok/keys` Web Auth 後 PUT E404，不能使用且不保留 alias。
3. **缺 `publishConfig`。** scoped package 首次 `npm publish` 預設 `restricted`；免費帳號會直接失敗。四個 package 都沒有 `publishConfig: { "access": "public" }`。
4. **缺 `LICENSE` 檔案。** repo 根目錄與 `packages/keys/` 都沒有，但四個 package.json 都宣告 `"license": "MIT"`。
5. **`dist/` 被 gitignore（`.gitignore:2`），且沒有 `prepublishOnly`。** 目前發佈完全依賴人工先跑 build，一旦漏跑就會發出空包或舊包。建議加 `"prepublishOnly": "pnpm run build"`。
6. **缺 `repository` / `homepage` / `bugs`。** 非阻斷，但影響 npm 頁面與 provenance。
7. **README 的 `## What is in K0` 表只列 7 個模組，實際 18 個。** notes 已記為刻意留下的 deviation（標題限定 K0，是不完整而非錯誤）。首次公開發佈前值得補成完整模組表，否則 npm 頁面對讀者是誤導。
8. **（repo 級，非 keys 專屬，不阻斷 K4）** tsup 把 `node:` 前綴剝掉了：`dist/index.js:2-6` 是 `from 'child_process'` / `'crypto'` / `'fs'` / `'module'` / `'path'`，而 `src/` 全部用 `node:` 前綴。`@byok/server` 與 `@byok/client` 的 dist 也一樣。在 Node 下無影響，但在只解析 `node:` 前綴的 runtime（Deno、Workers、部分 Vite SSR 設定）會解析失敗。aip 的 local-agent 跑在 Node，K4 不受影響。

---

## 6. K4.1 三面：aip 側 adapter 現狀與缺口

### 6.1 `testConfiguration()`

- **aip 現狀**：`providers.ts:1263-1296`。用未落盤的 configuration 造一個臨時 profile，secret 取 `secret ?? await keychain.get(...)`，然後 market_data 走 `McpHttpFinanceConnector.testConnection()`、model 走 `createNarrativeProvider(...).testConnection()`。消費於 `settings.ts:270`（`/api/model/configure` 的 test-before-save）。
- **byok 現狀**：`ProviderRegistry` **沒有** `testConfiguration()`，也沒有「由 configuration 造 client 但不落盤」的 API。但兩個 client 都有 `testConnection(signal?): Promise<void>`（實測 `dist/openai-client.d.ts:48`、`dist/anthropic-client.d.ts:34`）。
- **缺口**：adapter 需自己 `new OpenAiCompatibleChatClient({ profile, secret, fetchImpl })` / `new AnthropicMessagesClient(...)` 再呼叫 `testConnection()`；market_data 分支留在 aip 原樣不動。工作量小，形狀明確。

### 6.2 多 kind `delete()` / `list()`

- **aip 現狀**：`delete(kind, providerId?)`（`providers.ts:1234-1251`）、`list(): LocalProviderStatus[]`（`:1253-1261`）。消費：`settings.ts:325`（`delete("model", providerId)`）、`settings.ts:211,239,248,262,275,287,309,326`（八處 `list()`）、`cli.ts:1007`（`delete(kind)`）、`cli.ts:964`（`list()`）。
- **byok 現狀**：`delete(providerId: ModelProviderId): Promise<boolean>`、`list(): Promise<ProviderStatus[]>`，皆 model-only，且 `ProviderStatus` 無 `kind` / `tool_name`。
- **缺口**：adapter 依 `kind` 分派；model 轉發 byok 並在回傳上補 `kind: "model"`；market_data 走 aip 自己的 store；`list()` 合併兩邊並按 `kind` 排序（aip 現在是 `ORDER BY kind ASC`，`providers.ts:232`）。

### 6.3 code-based 錯誤識別

見 §3。三個站點（`settings.ts:358`、`providers.ts:1673`、adapter 內新的 `publicSettingsError` 對接）用同一個 `structuredErrorCode()` 白名單，一起落地。

### 6.4 計畫漏掉的第四、五面

- **`test(kind, providerId?)`**（`providers.ts:1389-1416`，消費 `cli.ts:987`）：byok 無對應物。adapter 要用已存 profile 取 secret 再 `testConnection()`。
- **`resolveDefaultModelProvider()` 的空物件語義**（`providers.ts:1331-1354`，消費 `cli.ts:778` 與 `connected.ts` 的雲端中繼路徑）：byok 丟例外，aip 回 `UnavailableNarrativeProvider`。adapter 要 catch `ByokKeysError` → `providerResolutionErrorCode(error)` → 包回空物件。**同時**，byok 回的是 transport client，aip 要的是 `LocalResearchNarrativeProvider`（帶 `planQueryIntent` / `generate` / `generateResearch` / `reviewResearch` / `analyzeImage`），所以 aip 的兩個 narrative provider 必須從「自己 fetch」重構成「組合 byok 的 client」。

> 這第五面是 K4 真正的工作量所在，也是計畫「swap PR 只做刪碼 + 換依賴，零行為變更」這句話**不成立**的地方。aip 的 `OpenAiCompatibleNarrativeProvider` / `AnthropicNarrativeProvider`（`providers.ts:478-1067`，約 590 行）裡 narrative 與 transport 是交織的：每個方法都自己組 body、自己叫 `fetchWithProviderGuards`、自己 `providerHeaders`。要用 `@byok-sdk/keys` 的 client，這 590 行要逐方法改寫成「組 messages → 呼叫 client.createChatCompletion / createMessage → 用 aip 的 validator 解析」。這是重構，不是刪除。

---

## 7. K4 執行順序建議

### 7.1 先決決策：profile store 走哪條路

| 方案 | 內容 | 判斷 |
|---|---|---|
| **A（建議）** | aip 保留 `LocalProviderProfileStore` 與 `local_provider_profile` 表，把它收窄成實作 `@byok-sdk/keys` 的 `ProviderProfileStore` 介面（model 分支），注入 byok 的 `ProviderRegistry` | **採用**。零資料遷移；`local-data-claim.ts:51` 的表名清單不動；market_data 列繼續住同一張表；aip 現有的部分唯一索引（`providers.ts:141-145`）語義與 byok 的兩條 invariant 完全一致。K2 把 `ProviderProfileStore` 做成可插拔就是為了這一刻 |
| B | aip 改用 `SqliteProviderProfileStore` | **否決**。表名 / 主鍵欄 / `tool_name` / market_data 共表四項全不相容，需要對每個既有安裝做資料遷移，而黃金測試抓不到失敗 |
| C | 給 `SqliteProviderProfileStore` 加可設定表名 | **否決**。仍解不掉 `profile_id` vs `provider_id`、`tool_name`、共表 market_data；而且為單一 consumer 預埋設定項，違反 HANDOFF §3「不在只有一個消費者的階段預埋推測性配置項」 |

方案 A 的代價：aip 保留約 190 行 SQLite 程式碼（`providers.ts:147-338`），「刪碼」的帳面收益變小。這是正確的取捨 —— 那 190 行承載的是安裝基數的資料，不是可移植的邏輯。

### 7.2 建議順序

0. **Drift 確認**：已完成（§1，零漂移）。K4 收尾時把 plan `:85` 的 drift 風險行標記為已消解。
1. **byok 側 publish 前置**（本 repo，可與 aip 側並行）：
   - 確認 `ancienttwo` 仍是 `@byok-sdk` owner；以 Web Auth 完成 publish write authentication
   - 四個 package.json 補 `publishConfig: { "access": "public" }`、`repository`
   - 加根 `LICENSE`（MIT）
   - `packages/keys` 加 `"prepublishOnly": "pnpm run build"`
   - README 的 `## What is in K0` 改成完整 18 模組表
   - 修 `errors.ts:30-36` 對 `SECRET_NAMESPACE_INVALID` 來源的錯誤陳述
2. **發佈 `@byok-sdk/keys@0.1.0`**（版本理由見 §7.3）。發完 `npm view @byok-sdk/keys` 驗證，並在乾淨目錄 `npm i @byok-sdk/keys` + `node -e "import('@byok-sdk/keys')"` 做一次安裝煙測。
3. **aip 側先加 adapter，不刪任何東西**（K4.1 全部五面）：`apps/local-agent/package.json` 加 `"@byok-sdk/keys": "^0.1.0"`；在 `providers.ts` 內把 `LocalProviderRegistry` 改成 adapter 外殼，內部**仍呼叫既有實作**。此時跑 `npm run typecheck --workspaces` + `npx vitest run apps/local-agent/src`，應該全綠 —— 這一步證明 adapter 的介面形狀對，且黃金測試不動。
4. **切換內部實作**：adapter 內部改調 `@byok-sdk/keys` 的 `ProviderRegistry`（注入方案 A 的 profile store、注入 `servicePrefix: "com.aiphabee.local-agent"` 與 `envelopePrefix: "aiphabee-scoped-secrets-v1:"`），narrative provider 重構成組合 byok 的 client。
5. **刪除被取代的 symbol**：`providers.ts` 的 transport 半邊、`index.ts:413/:568/:748-757`、`local-data-scope.ts:129-199`。
6. **轉換兩個 `instanceof`**（`settings.ts:358`、`providers.ts:1673`），用 §3.1 的白名單形狀。
7. **驗收**：`npm run typecheck --workspaces`（含測試檔）、`npx vitest run apps/local-agent/src`、確認 `settings.test.ts` diff 為空、外加一次手動安裝升級煙測（既有 `local-agent.sqlite` + 既有 Keychain 條目，確認 model profile 讀得回、`/api/status` 顯示已配置）。

### 7.3 版本號建議：`0.1.0`

- `0.0.1` 是四個 package 共用的 monorepo 佔位值，從未發佈過。第一個被外部 repo pin 住的產物應該與佔位值可區分。
- aip 會寫 `"^0.1.0"`；npm 的 0.x caret 語義是 `>=0.1.0 <0.2.0`，形成真實的相容柵欄。若發 `0.0.1`，`^0.0.1` 等於 `=0.0.1`，任何 patch 都要改 aip 的 lockfile。
- 保持 0.x，讓 pre-1.0 的 breaking change（例如把 `test()` / `testConfiguration()` 上提進 registry）可以正常落地。
- 其餘三個 package 暫不發 —— K4 不需要它們，而且它們一旦發佈就進入 M5 audit 的公開承諾範圍，應該獨立決策。

### 7.4 風險點

| 風險 | 嚴重度 | 觸發條件 | 緩解 |
|---|---|---|---|
| **SQLite 表名分歧造成既有安裝的 model profile 靜默消失** | 高 | 採用方案 B/C | 走方案 A；並在驗收加一次真實升級煙測（黃金測試抓不到這個） |
| **`MemorySecretStore` 缺 `scope()` 打斷 `tsc --noEmit`** | 高 | adapter 把 fixture 直餵 byok registry | adapter 在注入點做 `scope()` 補墊；保持 `LocalAgentSecretStore` 的 `scope?` 可選 |
| **narrative provider 590 行重構引入行為變化** | 高 | 步驟 4 | `providers.test.ts`（1173 行）與 `connected.test.ts`（1702 行）原樣通過作為門禁；步驟 3/4 分成兩個 commit，讓 diff 可讀 |
| **SEA / npx 打包沒帶進新的 external 依賴** | 中 | `scripts/build-local-agent-download.mjs` 與 `build-local-agent-npx-package.mjs` | 步驟 2 之後先跑一次 `npm run build:local-agent-download` 驗證產物 |
| **`resolveDefaultModelProvider` 由「回空物件」改為「丟例外」洩漏到雲端中繼路徑** | 中 | adapter 漏掉 catch | `connected.test.ts` 覆蓋；adapter 的 catch 必須是 `ByokKeysError` 白名單而非 catch-all |
| **`publicSettingsError` 改 code-based 時 duck-typing 洩漏 `error.message`** | 中 | 用 `typeof error.code === 'string'` | 用 `BYOK_KEYS_ERROR_CODES` 白名單（§3.1） |
| **npm scope 不可用 / 未登入** | 中 | 步驟 2 | 步驟 1 先驗證，別等到刪碼之後才發現發不出去 |
| **aip 是 npm workspaces，不是 pnpm** | 低 | 加依賴時誤用 pnpm | `apps/local-agent/package.json` 現有 7 個 `file:../../packages/*`，加 registry 依賴後跑 `npm install` 更新根 lockfile |

---

## 8. K4.1 該不該與 K4 同一個 PR

### 結論：**必須同一個 PR。**

三條理由，都可驗證：

1. **不存在中間綠態。** K4 的驗收條件是 `settings.test.ts` 原樣通過。而 `settings.ts:11-15` import 的 `LocalProviderRegistry` / `LocalProviderConfiguration` / `LocalProviderStatus` / `LocalModelProviderId`、`settings.ts:211-326` 的八處 `list()` + `testConfiguration()` + `delete("model", id)`、以及 `settings.test.ts:55` 的建構子形狀，全部只在 adapter 存在時才編得過。先刪碼後補 adapter，中間任何一個 commit 都是紅的。
2. **K4.1 就是 K4 的實作方式，不是後續增強。** §2.2 已證明 aip 沒有跨模組邊界的內部符號引用 —— 這意味著 swap 的唯一可行形狀就是「把 `providers.ts` 變成 adapter」。adapter 不是 K4 之外的一層，adapter 就是 K4。
3. **回滾面一致。** 計畫 `:104` 說「K4 reverts independently」。若拆兩個 PR，回滾 K4 會留下一個無主的 adapter；一個 PR 則 revert 一次即可回到 `fbefda1` 的行為。

但**應該拆 commit**：步驟 3（adapter 就位、內部仍是舊實作、全綠）與步驟 4-6（切換實作、刪碼、轉 instanceof）分成至少兩個 commit。前者的 diff 是純新增且可獨立驗證介面形狀，後者的 diff 才是真正的行為遷移。這讓 review 能分別回答「介面形狀對不對」和「行為變了沒有」。

---

## 附：本次執行過的驗證命令

```bash
# 現場快照（兩 repo，唯讀）
git -C /Users/ancienttwo/Projects/aip-main-open status --short --branch -uall   # 只有 branch 行
git -C /Users/ancienttwo/Projects/byok-sdk       status --short --branch -uall   # 只有 branch 行

# Drift
git -C .../aip-main-open cat-file -t c6a5385                                     # commit
git -C .../aip-main-open rev-list --count c6a5385..HEAD                          # 5
git -C .../aip-main-open diff --stat c6a5385..HEAD -- \
  apps/local-agent/src/{providers,index,local-data-scope,settings}.ts \
  apps/local-agent/src/{providers,settings,local-data-scope}.test.ts             # 只有 index.ts | 6 +++---

# byok 側就緒度
cd packages/keys && pnpm run build      # exit 0
cd packages/keys && pnpm run test       # exit 0, 15 files / 328 tests
cd packages/keys && npm pack --dry-run  # 22 entries, README.md included
npm view @byok-sdk/keys version             # 404
npm whoami                              # 401
```
