# Sprint: Salesko Handoff Upstream Program

> **Status**: Done
> **Slug**: salesko-upstream-asks
> **Created**: 2026-08-12 02:18
> **Updated**: 2026-08-12 02:18
> **Source PRD**: (none — source research) `docs/researches/2026-08-12-salesko-integration-handoff.md`
> **Source Spec**: `docs/spec.md`
> **Goal Mode**: incremental

Program-level sprint container. The Source PRD summary and ordered backlog
decompose product intent into ordered rows. Contract rows become task-contract
slices after `$think` expansion; inline rows stay in the sprint backlog or
active plan Task Breakdown.
`tasks/todos.md` stays the deferred-goal ledger and never carries this backlog.

## PRD

Source of truth: `docs/researches/2026-08-12-salesko-integration-handoff.md`（salesko 首次真实集成的十条实证清单，全部主张已于 2026-08-12 对照仓库核实）+ `docs/researches/2026-08-12-salesko-consumption-evidence.md`（下游消费证据包：frame 尺寸包络实测、result-document 首个消费形态、testkit API 面规格、presence dogfood 承诺、凭证桥需求语义）+ owner 已定裁决原则（核心层在 byok-sdk、胶水层在下游）+ owner 修订并批准的执行顺序（2026-08-12 会话）。

### Problem

- 首次真实下游集成（salesko Phase A）证明当前验收体系只验证「模块内部自洽」，未验证「外部产品拿发布物能完成真实工作」：presence 有路由无 producer、发布的 tarball 缺 runner 所需 SQL、结构化结果无传输位、下游被迫重实现协议细节做冒烟。
- 每个缺口的共同根因是能力定型时没有真实消费方；需要把「下游集成证据」纳入 freeze/宣称的前置条件（dogfood freeze-order：candidate tarball → 下游集成证据 → 冻结/宣称）。

### Users

- Host SaaS 集成方：salesko（首个真实下游，Phase C 被 presence 阻塞）、aip（候选第二下游）。
- 未来所有用 byok-sdk 发布品牌 CLI/daemon 的白标产品团队及其 CI。

### Success Criteria

- 外部 host 仅凭发布的 npm tarball（不访问源码 checkout）即可完成安装、数据库迁移、daemon 运行与协议级冒烟。
- 每个已宣称的 capability 都有第一方实现背书（presence.hints 有 producer）。
- 下游发现的每类盲点在上游固化为回归断言（testkit/conformance），教训变成回归面而不是记忆。

### Acceptance Scenarios

- 从精确 tarball fresh install 后，`migrationsDir()` 定位全部 migration 并完成空库迁移，重跑幂等。
- 已配对 daemon 在宣称 `presence.hints` 的 composition 上，一个心跳周期内出现在 presence 列表；停发后 TTL 过期即消失。
- host 通过 `task.complete` 的 bounded `document` 拿到结构化终态结果，旧 server 组合经 `result-document` capability 协商不静默丢失。
- 下游 CI 以 devDependency 引入公开 testkit，用 device simulator 完成 pair/challenge/token/presence/revoke 正负向断言，不重实现签名/nonce 细节。
- 同装 sibling CLI 经 daemon local broker 换取短期 device assertion（audience 白名单、短 TTL、revoked 复查），审计不落 assertion 本文。

### Non-goals

- Linux secret backend、host MCP 注入面（需求触发再立项）。
- presence level 映射扩展（thinking/working/error）、停机显式 offline 发布。
- 协议 v2 或任何冻结语义重写；仅 additive-minor。
- salesko 侧产品胶水（账号布局、UI 语义、部署命令、品牌 prefix）。
- 通用 `credentials.get` 或任何触碰 runtime CLI 凭证隔离铁律的桥。

## Architecture Notes

### Capabilities Touched

- `packages/client`（daemon：capability discovery、presence publisher、assertion broker、pi adapter env 声明）。
- `packages/cloud-postgres`（发布物完整性：SQL projection + `migrationsDir()`；R2 keyPrefix）。
- `packages/protocol` + `packages/server`/`packages/cloud`（additive：`task.complete.document` 与 `result-document` capability flag 及其投影）。
- 新公开 testkit 包（只依赖 protocol；conformance 保持 private 并消费它）。
- `scripts/release` + CI（两层 smoke：确定性断言永久在线，PG 真库迁移进 service container）。

### Dependency Order

- Row 1（presence）与 Row 2（SQL）文件面不相交，且均已有 approved plan；Row 1 已在 contract worktree 执行中。
- Row 3（TaskResult）为协议级 additive 改动，属 IP 锁定级：必须双轨评审（gatekeeper 实跑 + Codex 对抗二审），骑 CAPABILITY_FLAGS 现成机制（approval_resolved 先例）。
- Row 4（testkit）先于后续 conformance 吸纳：它是协议级盲点回归断言的载体；simulator 复用 protocol codec 与 client device-keys 同源细节，禁止重实现。
- Row 5（assertion broker）安全敏感：先 deep-reasoner 设计轮 + 双轨评审，再实现；建立在 M5 P2 authenticated control socket 之上，不触碰 runtime 凭证隔离。
- Row 6/7 为独立低成本项，可穿插；Row 8 最后（纯降摩擦）。

### Risks

- 协议冻结纪律：Row 3 只允许 additive-minor（optional field + capability flag + 新消息类型）；`.strict()` 例外面（PermissionPolicy/instruction blob-ref）不可加字段。
- Broker 是新的本地认证面：audience/TTL/jti/revoked 复查/审计脱敏任一疏漏都是真实安全洞；历史上安全面 gatekeeper PASS 被 Codex 二审多次推翻，双轨不可省。
- dogfood 外部依赖（2026-08-12 更新：消费证据包已入仓 `docs/researches/2026-08-12-salesko-consumption-evidence.md`）：Row 3 的 byte-cap 包络（bytes ≈ 4 KiB + 1.65 KiB × nodes；下游声明 ≥256 KiB 可用、512 KiB 舒适；cap 必须按 byte、reject-at-boundary 不截断）、Row 4 的 API 面规格（§3，15 条断言替换条件）、Row 5 的需求语义（§5）均已具备。Row 3 的最终冻结仍需 salesko Phase B 完成后的 payload 实样；presence（Row 1）dogfood 承诺 tarball 到手当天回证。
- Sprint 队列纪律：backlog 行不并行（sprint 文件冲突）；Row 1/2 的既有 plan/contract 先于本 sprint 存在，run 路由遇到已填 Plan 列的行应路由到既有工件而非重新展开。

## Backlog

Ordered execution queue; keep rows in dependency order. Mode `contract` runs
the full plan -> contract -> worktree flow; `inline` allows primary-tree
execution for small tasks. Every row needs a concrete acceptance line.

| # | Status | Task | Mode | Acceptance | Plan |
|---|--------|------|------|------------|------|
| 1 | [ ] | Presence producer + hosted capability discovery（已在 contract worktree 执行中，勿重复展开） | contract | `repo-harness run verify-contract --contract tasks/contracts/20260812-0201-presence-producer-capability-discovery.contract.md --strict` exits 0 | plans/plan-20260812-0201-presence-producer-capability-discovery.md |
| 2 | [ ] | cloud-postgres SQL build projection + `migrationsDir()` + 两层 release smoke | contract | `node scripts/release/pack-and-smoke.mjs` exits 0 且输出包含 dist/sql 与 deploy/sql 的 SHA-256 一致断言；`ls packages/cloud-postgres/dist/sql/*.sql` 非空 | plans/plan-20260812-0201-cloud-postgres-sql-projection.md |
| 3 | [ ] | `task.complete` bounded `document` 槽位 + `result-document` capability flag + `TaskResult.document` 投影（cap 决策输入见消费证据 §1：按 byte、reject-at-boundary、≥256 KiB 可用/512 KiB 舒适） | contract | `pnpm --filter @byok-sdk/protocol run test && pnpm --filter @byok-sdk/server run test` exits 0，且 freeze-guard 金样本零 diff（既有字段无类型变更） | (pending) |
| 4 | [ ] | 公开 headless testkit 包（device simulator：pair/challenge/token/presence/revoke + 负向断言），conformance 保持 private 并消费它（API 面规格见消费证据 §3） | contract | `pnpm -r run build && pnpm --filter @byok-sdk/conformance run test` exits 0，且 testkit 包 `package.json` 无 `"private": true` 并只依赖 protocol/core | (pending) |
| 5 | [ ] | daemon local device-assertion broker（audience 白名单、TTL ≤5 min、iat/exp/jti、revoke 联动失效、审计脱敏；先设计轮再实现；消费方需求见消费证据 §5） | contract | `pnpm --filter @byok-sdk/client run test` exits 0 且包含 broker 的 audience 拒绝/TTL 过期/revoked 拒发/审计不含 assertion 本文四类断言 | (pending) |
| 6 | [ ] | pi provider base-URL probe：headless RPC 是否加载指定目录 models.json、`runtimeEnvironment.pi.allow` 通路、`PI_CODING_AGENT_DIR` 是否入 adapter baseNames | inline | `test -f docs/researches/pi-provider-baseurl-probe.md` 且文件含实测命令输出与 adapter 决策结论 | (inline) |
| 7 | [ ] | Runtime 隔离能力矩阵：从 docs/security.md 提炼 per-runtime host 决策清单 | inline | `test -f docs/host-runtime-isolation-matrix.md` 且含 pi/claude/codex 三行矩阵 | (inline) |
| 8 | [ ] | R2 `keyPrefix`：`R2BlobStoreOptions` 可选前缀（仅新 deployment 的 immutable config，禁 dual-read） | contract | `pnpm --filter @byok-sdk/cloud-postgres run test` exits 0 且含 keyPrefix 布局断言；`grep -q keyPrefix packages/cloud-postgres/src/` 递归命中 | (pending) |

## Execution Log

Keep this section last; `repo-harness run sprint-backlog complete-task` appends rows here.

| When | Task | Plan | Result |
|------|------|------|--------|
