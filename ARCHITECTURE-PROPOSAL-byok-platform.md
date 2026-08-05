# BYOK 平台架構方案 v1（proposal）

> 狀態：待審批。搭配文件：`HANDOFF-byok-keys.md`（K 線移植細節）。
> 依據：raft-computer v1.0.15 兩輪實地拆解（2026-08-05，方法見 §8）+ byok-sdk 現狀實測（基線 6037c3b，typecheck 綠、1229 tests 全過）。
> 審批後建議轉 repo-harness plan 再動工。

---

## 1. 平台定位：一個品牌傘、兩條產品線、兩個安全模型

```
byok-sdk monorepo
├── K 線（key 管理，bring-your-own-key）
│   └── @byok/keys                ← 新建，從 aip-main-open 按層剝離移植
│       安全模型：主動管理使用者的 provider API key（OS Keychain/Credential Manager）
│
└── C 線（agent 調度，bring-your-own-agent）
    ├── @byok/protocol            ← 現有，wire v1 FROZEN
    ├── @byok/server              ← 現有，SaaS 端嵌入式 coordinator
    └── @byok/client              ← 現有，本機 daemon + RuntimeAdapter
        安全模型：credential-isolation——絕不接觸任何憑證（M5 audit 承諾）
```

**鐵律**：兩線互不依賴。`client`/`server`/`protocol` 不得 import `keys`；`keys` 的存在必須在 docs/security.md 明文與 M5 credential-isolation claim 劃界，避免污染 C 線的安全承諾。

## 2. 參考基準：raft-computer v1.0.15 完整拆解

Raft（botiverse，內部代號 slock）的本機 computer-agent daemon，與 C 線同型態、比 C 線多兩年產品化打磨。模組地圖：

| 模組 | raft 的實現 |
|---|---|
| auth | OAuth device-code（`/api/auth/device/*`），token 存檔案（`~/.slock/profiles/`，非 Keychain） |
| attach | 一機多 server（`/api/computer/attach`），per-server 目錄 `computer/servers/<id>/` |
| supervisor | 自建三層進程樹：`__service`（detached 頂層）→ `__run <serverId>`（每 server 一個子進程，獨立 pid/log，崩潰互不傳染，2s backoff 重啟）→ 每 agent 的 Driver spawn。v1 之前用 launchd/systemd，遷移後保留完整 legacy 偵測+清理（doctor 掃描 `~/Library/LaunchAgents` 並給精確卸載命令） |
| 控制面 | CLI↔daemon 走 Unix socket `computer/run/service.sock`（Windows 用 sha256 派生 named pipe） |
| runner | 不自帶推理 runtime，spawn 第三方 coding CLI；10 個 Driver 類（Claude/Codex/Cursor/Gemini/Grok/Copilot/Antigravity/OpenCode/Pi/Kimi），共用 `ChildProcessRuntimeSession` 基類 |
| runner 憑證 | **spawn 前先 mint**：daemon 用長期憑證向 `POST /internal/computer/runners/{agentId}/credentials` 換該 agent 專屬短期 key（`sk_agent_*` 前綴校驗、帶 scope 清單、停止即 revoke）。mint 失敗整個啟動失敗，fail-closed |
| 憑證代理 | 本地回環 HTTP 代理（127.0.0.1 隨機端口）：agent 子進程只拿一次性 proxy token，真憑證由代理轉發時注入 Authorization；還做 inbox/events 本地短路快取。只代理 Raft 自家 API，模型流量由各 CLI 自己直連 |
| 退避 | 兩級：spawn 失敗（本地問題）1s→30s；credential-mint 失敗（服務端問題）60s→600s。併發閘：同時最多 5 個 agent 啟動、間隔 500ms |
| watchdog | 三級：compaction 停滯 5min → 只廣播診斷不動進程；review 停滯 10min → 廣播 + 強制推進狀態機；真卡死 → SIGTERM，10s 未退 → SIGKILL + trace |
| wrapper 自癒 | 每 agent 一個入口腳本（`agents/<id>/.slock/opencli`，exec SEA 內嵌 node），daemon 升級後首次連線一次性重寫全部 wrapper，防止指向已被替換的舊 binary |
| upgrade | channel（latest/alpha/pinned:semver）持久化 + `upgrade --dry-run/--rollback`；install.sh 全鏈路 sha256 + `file -b` 平台防呆 + staged 原子安裝 |
| diagnostics | `status` / `doctor --fix`（自癒）/ `logs`，全部聲明 secrets never printed/redacted |

## 3. byok-sdk 現狀對位（實測）

**已對齊、不用動**：
- 控制面：M4 的 IPC control socket，且防護比 raft 嚴（symlink/uid 檢查、拒絕二重 daemon——`daemon/control-server.ts:38,170,175`）
- fail-closed 文化：未配對拒啟動、URL 白名單 unconditional refusal（`create-daemon.ts:178,527`）
- runner 模型：RuntimeAdapter ≈ raft Driver，同樣是 spawn 第三方 CLI + credential-isolation
- CLI 命令面已有：pair/unpair、start、status、service、tasks、approvals、runtimes、workspaces

**我們更強、保持**：
- K 線用 OS Keychain 存 key；raft 連自家 OAuth token 都存檔案。憑證儲存這層 byok 標準更高
- per-task Git checkpoint（workspaces）raft 沒有對應物

**真缺口（C 線候補里程碑的素材）**：
1. doctor 自診斷（含 legacy 殘留掃描）+ logs 脫敏查看 + setup 複合命令
2. channel + self-upgrade + rollback 體系（byok 只有 packaging 範本，無升級面）
3. 兩級退避與啟動併發閘（現有 M5 P3 資源限制未區分故障類型）
4. watchdog 分級（診斷廣播 vs SIGTERM→SIGKILL 硬升級）
5. 短期憑證 mint + 本地憑證代理（條件性，見 §4）

## 4. 架構決策（逐條，含理由）

**D1 採納：doctor / logs / setup（C 線第一優先）。** 純 CLI 層工程，不動協議與安全模型，對「SDK 被宿主產品打包後的現場排障」價值最高。raft 的 doctor 連舊版殘留都掃——byok 未來換進程模型時同樣需要這層。

**D2 採納：channel + upgrade + rollback。** byok-sdk 要走到「宿主產品把 daemon 打包分發給終端使用者」，沒有升級面就意味著每次修 bug 都要宿主重新發版。install.sh 的驗證鏈（sha256×2 + `file -b` + staged 原子安裝 + Rosetta 防呆）已完整審計過，照抄。

**D3 採納：兩級退避 + watchdog 分級 + 啟動併發閘。** 直接落到 @byok/client 現有的進程管理層，參數照 raft 的量級起步（spawn 1s→30s；遠端故障 60s→600s；SIGTERM 10s 後 SIGKILL），是純強化、無介面變更。

**D4 條件採納：短期憑證 mint + 本地回環憑證代理。** 現狀 byok 的 agent 經 stdio 與 daemon 溝通、從不持有 SaaS 憑證，安全性等價。只有當「spawn 出去的 agent 需要直連宿主 SaaS API」的需求出現時才引入這層——引入時照抄 raft 全套：短期 key 前綴校驗、scope 清單、進程退出即 revoke、真憑證只在代理轉發時注入。

**D5 不採納：OAuth device-code 中央登入。** raft 是中心化平台，需要全域帳號；byok 是嵌入式 SDK，每個宿主產品自己有帳號體系，pairing code + Ed25519 device key 更貼合，保留現狀。宿主要 device-code 可以在自己的 embedder 層做。

**D6 不採納（現階段）：多 server attach + 三層進程樹。** byok 的部署單位是「一個宿主產品一個 daemon」，單連接單進程夠用。raft 的 per-server 子進程隔離（崩潰不傳染、可單獨 restart）記入儲備——若未來出現「一台機器同時服務多個工作區」需求，按這個模型擴。

**D7 維持：OS service 範本（launchd/systemd/WinSW），不跟隨 raft 的自建 supervisor。** raft 自建 supervisor 換來升級自控與跨平台一致，但付出了完整的 legacy 遷移/清理代價。byok 是 SDK，宿主產品對「開機自啟」的偏好各異，OS 範本交給宿主選擇成本最低。若日後 D2 的 self-upgrade 與 OS service 衝突（升級要重啟服務），屆時再評估自建 supervisor，並提前設計 raft 式的 legacy 偵測+清理。

**D8 採納（打包期）：wrapper 自癒模式。** byok 的 SEA/Bun 打包範本一旦讓 daemon 攜帶內嵌 runtime，升級後路徑失效問題與 raft 完全同構。把「daemon 升級後首次啟動重寫派生腳本」寫進 packaging 範本的驗收清單。

## 5. 里程碑總排序

| 順序 | 線 | 內容 | 依據 |
|---|---|---|---|
| 1 | K | K0-K2：@byok/keys 骨架→SecretStore→Registry | HANDOFF-byok-keys.md，已定案先行 |
| 2 | K | K3（設置頁 server 取捨）、K4（回接 aip-main-open，需協調） | 同上 |
| 3 | C | C1 = D1（doctor/logs/setup） | 缺口清單 #1 |
| 4 | C | C2 = D2（channel/upgrade/rollback） | 缺口清單 #2 |
| 5 | C | C3 = D3（退避/watchdog/併發閘） | 缺口清單 #3-4 |
| 儲備 | C | D4（憑證代理）、D6（多連接進程樹）、D7 重評 | 需求觸發制 |

K 線先行的理由已在 HANDOFF §0 定案；C 線三個里程碑相互獨立，可按產品節奏插隊。

## 6. 開放決策（不阻塞 K0）

1. `@byok/keys` npm 發佈形態：公開（repo MIT）vs GitHub Packages 私有——K4 前定。
2. K3 設置頁 server 進包與否。
3. C 線啟動時機：等 K 線落地後由產品需求觸發，不預先排期。

## 7. 驗證面

```bash
# 基線（每個里程碑收尾必跑）
pnpm -r typecheck && pnpm -r test && pnpm -r build   # + repo-harness gates

# K 線 parity 黃金測試（K4 門禁，在 aip-main-open 側）
npx vitest run --root . apps/local-agent/src/settings.test.ts
```

## 8. 證據與方法附錄

- raft-computer 拆解方法：install.sh 全文審計（496 行）→ 安裝 v1.0.15 → CLI 全命令面實測 → `strings -n 8`（868,175 行）targeted grep → 未登入行為實驗（start 被 attach-gate 拒絕、零殘留）→ 公開文件（raft.build / docs.raft.build）比對。**未做**真實 login/attach，故 daemon 帶負載運行時的 run/ 目錄內容與 wss 實際連線為 [inferred]。
- raft 內部代號 slock（env 前綴 `SLOCK_*`、舊 npm org `@slock-ai`、現 org `@botiverse`）；runner 憑證前綴 `sk_agent_*`。
- byok-sdk 現狀證據：`packages/client/src/daemon/control-server.ts`、`bin/commands/`（pair/start/status/service/tasks/approvals/runtimes/workspaces/unpair）、M0-M5 commit 序列、1229 tests 實測全過。
- aip-main-open 側證據與 K 線剝離地圖：見 `HANDOFF-byok-keys.md` §4。
