# byok-sdk 优化 handoff（供新 session）

> 2026-08-13。承接一次过夜多刀运行。本文自包含:新 session 读此即可继续,无需回放上一段对话。

## 0. 一分钟状态

- `origin/main` 已合入三刀(下方「已完成」)。本地 main 可能领先 origin 1 个 commit（`chore(todos)` CI 加固记账),owner 自行决定是否 push。
- 工作流:repo-harness 驱动。每刀 = `capture-plan`(主模写 body)→ 填 contract brief(Why/Goal/Scope/Falsifier/Allowed Paths/Exit Criteria)→ `contract-worktree start` → 把 contract/review/notes `mv` 进 worktree + `switch-plan` → 派 worker → gatekeeper 验收 → `verify-sprint --prepare-acceptance`(跑两次,首次自举 checks/latest.json 会假 FAIL)→ `acceptance-receipt record --disposition external_pass --reviewer Claude --source claude-review` → `verify-sprint` finalize → `verify-contract`(翻 Status=Fulfilled)→ `ship-worktrees`(push+draft PR)→ 改 PR body + `gh pr ready` → 盯 CI → `gh pr merge --merge` → 删远程分支 → ff 本地 main → `contract-worktree cleanup --slug <slug>`。
- 模型路由(owner 铁律):主循环只做计划/编排/综合,**不 hand-edit 源码**(harness `MainLoopDispatchGuard` 会拦);执行派 `fast-worker`,难/跨包派 `deep-worker`,验收派 `gatekeeper`,调研派 `deep-reasoner`,只读定位派 `explorer`。所有 subagent 必须显式 model/agent-type。

## 1. 已完成(本轮三刀,均在 origin/main)

| 刀 | PR | 合并提交 | 内容 | 证据要点 |
|---|---|---|---|---|
| B-1 | #61 | `3ef5110` | pg Pool `'error'` handler(`packages/cloud-postgres/src/pool.ts`)+ undici keep-alive teardown(`src/__tests__/support/disable-fetch-keepalive.ts` + `vitest.config.ts`) | 合入后 Node22+24 dataplane 首次零重跑全绿,证实 `socket hang up` flake 消除;instrument-first 证伪 pg-pool 假设,定位 undici→MinIO |
| A-1 | #62 | `b9e7598` | `PostgresSkillPackStore` + `deploy/sql/0005_skill_packs.sql` + skillPacks 转 `CORE_STORE_NAMES` 强制成员、`CORE_NON_COMPOSITION_PORT_NAMES` 归空 | Postgres conformance 对真实 DB 全绿(228+137);中途补了 `tests/sql/control_plane_invariants.sql` 的 0005 order 登记门 |
| B-2 | #63 | `c8f3d50` | 27 个 `/byok/*` 路由常量收敛到 `@byok-sdk/protocol`(`http-api.ts`)+ B-6(a) `DEVICE_PROOF_HEADER` 归 `@byok-sdk/core` | 路由字节漂移可证为零(`http-routes.test.ts` 独立见证);freeze-guard 纯新增 +121/-0,golden 未变 |

不变量(全程守住):`packages/protocol` 全程零 diff;凭证隔离铁律不碰;无 steady-state 兼容双路径;每刀单 PR 可回滚。

## 2. 剩余优化候选(按杠杆排;证据来自 deep-reasoner 现状调研 + 本轮发现)

### 强烈建议先做

**O-1 CI 稳定性刀(合并两个既有 flake)** — 已记入 `tasks/todos.md`。
- `packages/client` `daemon-owner.ts:324` `acquireStoreMutex`:确定性 mutex 端口在满仓并发下与真实进程/并行 worker 碰撞抛 `DaemonOwnerActiveError`;本轮完成门偶发假红多次,隔离/重跑即过。
- cloud-postgres dataplane MinIO teardown 偶发 `Unexpected HTTP response: 503` + `socket hang up`(B-1 修了纯 keep-alive reset,server 主动 503 是另一模式)。
- 方向:mutex 端口随机化+重试 / 碰撞可恢复,或竞争下 skipIf;MinIO teardown 前 drain/close object client 或对 503 有界重试。**杠杆最高**——不修则每刀 CI 都靠重跑绕过,掩盖真实信号。

### 值得做(bounded,独立可 ship)

**O-2 Windows `O_NOFOLLOW` symlink guard 失效(B-3,MED risk,安全相邻)**:`packages/client` `task-runner.ts:653-657` 的 `O_NOFOLLOW` 在 Windows 上 undefined,`?? 0` no-op,而 symlink/TOCTOU 测试(`daemon-blob.test.ts:361-397,459+`)无平台 `skipIf`,在 windows-latest 上「通过」的是 Node 默认行为而非声称的 atomic-open。要么补真实 Windows 保护,要么 skipIf 并显式记录 Windows 不保证该 guard。

**O-3 长轮询 auth/校验不对称(A-4,S 尺寸,安全相关)** — 已在 `tasks/todos.md`。WS 的 `conn.hello` 校验 `protocolVersions`/`productId`/`deviceId`(`server/src/ws-server.ts:111,121`),而长轮询 `/byok/events`、`/byok/messages`(`http.ts` 约 :271-272,:320-321,行号本轮 B-2 后可能微移)只跑 `authenticateBearer`,漏 productId/protocolVersion 等值检查。给长轮询补等价校验面,或写显式豁免。

**O-4 `verifyDeviceAssertion` 无仓内消费方(B-4,安全路径)**:`packages/core/src/device-assertion.ts:320-383` 文档化了 caller 义务(audience/issuer/productId 复检 + jti 销号)但只有测试演练,无 conformance 向量。补一个可执行的 reference-verifier 向量把义务钉死(呼应 buzz「grammar-without-evaluation」教训)。

**O-5 `GitErrorCategory`/`GitWorkspacePhase` 运行时值集在 client 内复制 4-6 次(B-5,S-M,纯清理)**:`git-workspace.ts:10-21` 的 union 与 `format.ts:37-48`、`audit-log.ts:165-180`、`tasks-view.ts:17-28`、`workspaces.ts:5-14` 的独立 Set 副本;收敛到单源 + drift 守卫。B-6(b)(c)(base64url、dispatchSelection.runtimeId)本轮判定为「有意不收敛」(impl primitive / 失败语义分叉),除非有新证据不重开。

### 已排期但更重/更高风险(owner 已在 todos 定触发条件)

- **Bun 迁移**(A-2):本轮 ship 已攒足实证——vitest/bun 的 `vi.setConfig` 不可移植、默认超时 5s vs 10s;`repo-harness` 本身跑在 bun 上。迁移刀需单独验 better-sqlite3 原生模块、`scripts/release/pack-and-smoke.mjs` 的 pnpm-pack 语义、harness 模板与 CLAUDE.md Required Checks 全量改写。触发条件已满足,是个自然的下一独立刀。
- **P5**(A-3):keys profile 持久化接 core `TruthStore`——会把 `@byok-sdk/core` 引入 keys 依赖图(当前 keys 仅依赖 zod),security-boundary 改动,需独立安全审查。
- 其余 todos 项(审计账本、scheduled dispatch、R2 条件文法、R3 单飞行、Git 长任务账本)均 BLOCKED,触发条件在 `tasks/todos.md`,无下游拉力前不动。

## 3. RAFT-study 状态(关联,非 byok 仓)

- `~/Projects/RAFT-study`:owner 正深挖(新增 server contract boundary / runtime launch / **upgrade migration authority research** / credential lifecycle 等 slice)。
- 本轮我补的两份仍在:`docs/architecture/cross-version-security-parity.md`(P1,登记了四个 baseline 安全发现作为待对 1.0.16 复核的 open question——**未引入任何 1.0.16 探针事实**)、`docs/architecture/byok-sdk-extraction-bridge.md`(P2,接下游 byok 用途)。
- 「upgrade migration authority research」很可能正在销账 cross-version-security-parity 的 S1(升级签名验证缺口)。新 session 若继续 RAFT 侧:销账后把结论写回 `modules/computer/upgrade.md`,并在 parity 表标 confirmed/fixed/changed;`upgrade.md:33` 把 base-URL 覆盖框成「安全 invariant」的措辞在复核前视为待定。
- 铁律:RAFT-study 是 hash-bound 静态拆解,**不得伪造 1.0.16 探针事实**;真正销账需拿 baseline 探针清单跑本机 `work/raft-cli-architecture/` 的 1.0.16 大样本(该目录 ignored,不在任一仓 git)。

## 4. 新 session 起手建议

1. 读 `tasks/todos.md`(deferred ledger,含本轮两条 CI 加固)+ 本文。
2. 先确认 `git -C ~/Projects/byok-sdk log --oneline -6 origin/main` 含 #61/#62/#63;若本地 main 领先,决定 push 与否。
3. 推荐第一刀:**O-1 CI 稳定性**(杠杆最高,解锁后续所有刀的干净 CI)。走第 0 节的 repo-harness 流程。
4. 预期两个既有 flake(daemon-owner mutex、MinIO 503)会在完成门/CI 偶发——在修好 O-1 前用「隔离/重跑 + 确认非本刀」处理,不误判为回归。
