# Plan: R2 keyPrefix Immutable Deployment Config

> **Status**: Executing
> **Created**: 20260812-0400
> **Slug**: r2-key-prefix
> **Artifact Level**: work-package
> **Promotion Reason**: Sprint Row 8（salesko handoff 条目 6）：`tenantObjectKey(tenant, hash)` 硬编码 `tenants/<tenant>/objects/sha256/<hex>`（core），`R2BlobStoreOptions` 无任何 prefix 选项，host 被迫为每个产品开专用 bucket。纯降集成摩擦的 additive option。
> **Verification Boundary**: core + cloud-postgres 测试（含 keyPrefix 布局断言与默认零变化断言）、其余包零 diff、strict workflow。
> **Rollback Surface**: revert；默认空前缀即现布局，零迁移。
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-08-12-salesko-integration-handoff.md` 条目 6
> **Task Contract**: `tasks/contracts/20260812-0400-r2-key-prefix.contract.md`
> **Task Review**: `tasks/reviews/20260812-0400-r2-key-prefix.review.md`
> **Implementation Notes**: `tasks/notes/20260812-0400-r2-key-prefix.notes.md`

## Agentic Routing
- Selected route: 本 worktree 内 fast-worker 执行，gatekeeper 验收。
- Routing reason: 小型 additive option，两包联动。
- Due diligence:
  - P1 map: key 布局权威在 core 的 `tenantObjectKey`；R2 store 与 options 在 cloud-postgres（merge-gate 验收时逐字段核对过 options 无 prefix）。
  - P2 trace: `R2BlobStoreOptions.keyPrefix?`（缺省 undefined = 现布局逐字节不变；空串 `''` 视为非法配置构造期抛错——空串正是未设 env var 的形态，静默接受等于替部署定址）→ 传入 core key 构造 → `<prefix>/tenants/...`。
  - P3 decision rationale: ① 仅新 deployment 的 immutable config：文档明示改前缀会使既有对象失去定位，禁 dual-read 回退；若要切换必须独立一次性 migration（不在本 slice）。② 前缀校验 fail-closed：提供时（含空串）须匹配 `^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$`（无首尾斜杠、无空段），非法即构造期抛错。③ 默认路径逐字节不变（旧测试全绿即证）。

## Approach
1. core：`tenantObjectKey` 增 optional prefix 参数（或 options 对象，跟随现有签名风格），默认行为逐字节不变；前缀校验函数导出。
2. cloud-postgres：`R2BlobStoreOptions.keyPrefix?` 接线 + 构造期校验。
3. 测试：默认零变化断言（快照既有 key）；带前缀布局断言；非法前缀（首/尾斜杠、空段、大写、空格）构造期抛错。
4. 文档（cloud-postgres README 或 options 注释）：immutable 语义、禁 dual-read、切换需一次性 migration。

## Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| dual-read 新旧前缀 | 平滑切换 | steady-state 兼容路径，纪律禁止 | 拒绝 |
| 前缀允许任意字符串 | 灵活 | S3/R2 key 边界情况（斜杠/unicode）成隐患 | 拒绝，白名单字符集 |

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 默认路径被意外改变 | Low | High | 既有测试 + 显式快照断言 |
| 前缀被运行时改动造成对象失联 | Medium | High | 文档 immutable 语义 + 校验只在构造期（无 setter） |

## Promotion Gate
- **Merge/PR unit**: 一个 PR。
- **Rollback surface**: revert；零迁移。
- **Verification boundary**: 见 header。
- **Review/acceptance boundary**: gatekeeper 单轨。
- **High-risk surface**: 默认零变化；校验 fail-closed。
- **Why not checklist row**: 跨 core/cloud-postgres 的布局契约，独立回滚面。

## Evidence Contract
- **State/progress path**: 本 plan + contract + notes。
- **Verification evidence**: 两包测试输出。
- **Evaluator rubric**: 默认配置下全部既有 key 逐字节不变；`keyPrefix:'acme/prod'` 产出 `acme/prod/tenants/...`；非法前缀构造期抛错；其余包零 diff。
- **Stop condition**: 出现任何 dual-read/双布局回退。
- **Rollback surface**: revert commits。

## Annotations

- 已解决：依据 owner 2026-08-12 /goal 指令授权推进；immutable/禁 dual-read 语义为 owner 修订版原文。无遗留注释。

## Task Breakdown
- [ ] core prefix 参数 + 校验 + 测试
- [ ] cloud-postgres options 接线 + 测试
- [ ] 文档 immutable 语义
- [ ] gatekeeper 验收
