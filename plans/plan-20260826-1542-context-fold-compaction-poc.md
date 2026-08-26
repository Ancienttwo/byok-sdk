# Plan — context-fold compaction 隔离兼容性 PoC（falsifier-gated）

> Created: 2026-08-26 · Owner: Fable 主循环编排 · Status: **DEFERRED @ Phase 0**（falsifier gate 未过，已入 `tasks/todos.md`）
> Scope repo: `byok-sdk` · Capability: `root` (packages/client pi adapter)

## Phase 0 结果（2026-08-26）— NO FALSIFIER → DEFERRED

- Adapter 边界半：安全 by construction。`compaction_start/end` → `undefined` 且 ∈ `ROUTINE_PI_EVENT_TYPES`（`packages/client/src/adapters/pi/events.ts:116`；迭代器续拉不告警 `pi-adapter.ts:486`），无 SDK 侧状态依赖。*(inferred from code；未跑 suite)*
- Pi 模型半：`fake-pi.mjs` 是脚本化 stub、无真实 model context，结构上无法复现 native compaction 语义；grep 确认无任何 e2e 驱动真实 compaction。真证伪须对活 BYOK provider 跑逼近上下文上限的长 session（本 plan 排除项），且真失败属 pi 内部 bug，非 context-fold 定位可修的 SDK 边界缺陷。
- 判定：无 falsifier → 不进 Phase 1，整体降级入 `tasks/todos.md`，revisit trigger 见该表。
- 可选后续（未做，需另行授权）：加一条边界回归测试断言"compaction 帧是 SDK 边界 no-op"，把上面 adapter 半从 inferred 升到 verified——但这是 hardening，非本 PoC 的一部分。

## Goal

裁定 deterministic 外部 compaction 扩展（context-fold）能否在**不破坏 BYOK task/session authority** 的前提下，作为 Pi native compaction 的可选替代——**只做隔离 PoC，不改默认行为，不进生产依赖**。

## Locked Decisions（已拍板，不在本 plan 重议）

1. **生产默认永远是 Pi native compaction。** 无已验证 downstream falsifier 之前，不引入任何新的 context/compaction authority。
2. **@sting8k/pi-vcc 淘汰。** ambient 全局 config + synthetic continuation + heuristic semantic extraction 撞 BYOK 铁律（禁本地重导 LLM 语义权威 / task-scoped 隔离），且缺 LICENSE 未过发布门。
3. **pi-auto-compact 不叠加。** 涉及模型选择/全局 config/synthetic resume/紧急截断，与其它扩展共用 `session_before_compact` 会争所有权。
4. **`session_before_compact` 是单一行为所有权边界**，禁止多 compact 扩展叠加成中间件链。
5. **PoC 若上，只可 context-fold，且 disabled-by-default + task-scoped 开关 + 无共享全局 config + 明确 spool 生命周期。**

## Phase 0 — Falsifier gate（先跑，可证伪，最便宜）

**目的**：在写任何集成代码前，证明 native compaction 在 BYOK 场景下确有值得替换的问题。立不出来就停。

- [ ] 定义"native compaction 失败"的可观测判据：BYOK 特定的 context 丢失 / continuation 断裂 / 成本或 token 膨胀 / resume 后状态错乱，任一。
- [ ] 用现有 RPC fixture 复现一次长 session → 触发 native compaction → 检查上述判据。入口：`packages/client/src/adapters/pi/` 现有测试夹具。
- [ ] 判定：
  - **有 falsifier** → 记录可复现证据，进 Phase 1。
  - **无 falsifier** → 本 plan 整体降级，写入 `tasks/todos.md` deferred ledger，revisit trigger = "出现具体 native-compaction 失败证据"。**不进 Phase 1。**

## Phase 1 — context-fold 源码门（read-only 验证）

前置：Phase 0 通过。

- [ ] clone/读 context-fold 当前发布版源码，逐项确认（对照用户 P2 已发现的事实）：
  - spool/index/heartbeat 建在 **session 目录**（session-scoped，非跨 session）。
  - 默认接管 hard compaction 的开关点在哪、能否关成 disabled-by-default。
  - 有无 `ctx.ui.*` blocking dialog 调用、有无网络请求、有无写 session 目录以外的路径。
  - unfold/recall tool 的注册点与 context projection contract。
  - **packed artifact 的 LICENSE 与 license metadata**（发布门，缺则直接卡）。
- [ ] 产出：一页 context-fold 行为契约摘要 + 是否过门结论。不过门 → 停，回 todos。

## Phase 2 — 隔离集成（disabled-by-default，task-scoped）

前置：Phase 1 过门。写域仅限 `packages/client/src/adapters/pi/`。

- [ ] 在 `resolve-extensions.ts:1` 的扩展解析里，把 context-fold 作为**显式 opt-in、默认关闭**的扩展路径接入（不改 native 默认；不加 ambient config）。
- [ ] task-scoped 开关：随 task/session 传入，禁止进程级全局状态；spool 生命周期绑定 task，close 时清理（对齐现有 `cleanupMcpConfigDir` 的 task-owned cleanup 语义）。
- [ ] 保证不与其它 compact 扩展共存（单一 `session_before_compact` 所有权断言）。

## Phase 3 — 行为验收（PoC 是否保住 BYOK authority）

- [ ] RPC 通道：headless `--mode rpc` 下扩展注入不破坏事件流。
- [ ] fresh-session：全新 session 行为不被 spool 污染。
- [ ] resume：折叠后 resume 状态正确、原文可 recall。
- [ ] agent-settled：compaction/fold 不干扰 `agent_settled` 终结语义（`events.ts` 的 terminal 判定）。
- [ ] packed artifact：产物可 readback，license 合规。
- [ ] task/session authority：fold 前后 task 边界、凭证隔离、continuation 权威不漂移。
- [ ] 判定 PASS/FAIL → 只是 PoC 结论，**不等于授权进生产默认**。

## Verification 命令

- `bun run build` / `bun run typecheck` / `bun run test`
- `repo-harness run check-task-workflow --strict`
- 针对性：pi adapter RPC fixture、fresh-session/resume 测试。

## Out of Scope

- 改动 native compaction 默认路径。
- pi-vcc / pi-auto-compact / 任何 OpenAI-Codex 专属或跨-session-memory 扩展。
- 多扩展叠加。
- 把 context-fold 提为生产依赖（本 plan 最多产出 PoC 结论 + 建议，是否入生产是另一次决策）。

## Risks

- **投机风险**：Phase 0 无 falsifier 却仍推进 = anti-pattern #4。Phase 0 gate 就是防这个。
- **所有权冲突**：任何时刻只能有一个 compaction authority；集成必须断言独占。
- **隐性全局状态**：context-fold 若无法关成 task-scoped/disabled-by-default，Phase 2 直接失败，不 workaround。
