# Plan: ADR-024: R2 Hash Authority

> **Status**: Executing
> **Created**: 20260808-1542
> **Slug**: r2-hash-authority-adr
> **Artifact Level**: work-package
> **Promotion Reason**: S4B 的 GC/reconcile 需要先确定 object identity 的权威来源，而 `object_manifest` 四态与 `0002_core_domain.sql` 已冻结。该决定跨 daemon、cloud、Postgres manifest 与 R2 bytes 的责任边界，必须在 S4B schema/实现前形成独立 ADR，避免把未经观测的 reservation hash 冒充 cloud 验证值，或为不可用的 checksum 能力预埋兼容分支。
> **Verification Boundary**: docs-only；compose dataplane hard gate 下 fresh 运行 `pnpm -r run typecheck`、`pnpm -r run test`、`pnpm -r run build` 与 `repo-harness run check-task-workflow --strict`；`packages/**`、`deploy/sql/**` 相对 `main` 零 diff；canonical architecture 不再把 R2 `HEAD` 描述为 SHA-256 验证方。
> **Rollback Surface**: 回滚本 PR 恢复 ADR 前的文档与 sprint/todo 状态；不修改 runtime API、schema、migration、对象或数据库状态。
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/s4a-dataplane-design.md` §3/§6、Cloudflare R2 S3 compatibility、S4A-c object-suite probe evidence
> **Task Contract**: `tasks/contracts/20260808-1542-r2-hash-authority-adr.contract.md`
> **Task Review**: `tasks/reviews/20260808-1542-r2-hash-authority-adr.review.md`
> **Implementation Notes**: `tasks/notes/20260808-1542-r2-hash-authority-adr.notes.md`

## Agentic Routing
- Selected route: parent-agent, docs-only
- Routing reason: 用户已批准完整裁定与文件范围；本刀只把已验证事实投影到唯一 ADR 索引、canonical architecture、sprint 与 todo，不需要并行 research 或 runtime 实现。
- Due diligence:
  - P1 map: daemon 在 `BlobClient` 计算 SHA-256；cloud 认证 tenant/device、校验 declaration 并签入 size/type；Postgres `object_manifest` 保存声明与四态；R2 保存 bytes。`docs/architecture/sdk-architecture.md` 附录 A 是 ADR 编号/状态唯一索引，不新增 `docs/adr/`。
  - P2 trace: `BlobClient` 声明 hash → `POST /byok/blobs` → `object_manifest.pending` → presigned PUT → R2 `HEAD` 仅返回存在性、size、content-type → manifest commit。压力点是当前接口含 `observedContentHash`，但 HEAD 从未观测 digest。
  - P3 decision rationale: paired daemon 的声明是 hash authority；cloud 不读回重算，也不声称验证 SHA-256。这样保留现有四态和跨 provider 组合，不支付每对象一次完整 read-back 的带宽/计算成本；代价是 tenant 内受信 device 可把同 size/type 的 bytes 错标为某 digest，该风险必须显式记录。

## Workflow Inventory
- Active plan: `plans/plan-20260808-1542-r2-hash-authority-adr.md`
- Sprint contract: `tasks/contracts/20260808-1542-r2-hash-authority-adr.contract.md`
- Sprint review: `tasks/reviews/20260808-1542-r2-hash-authority-adr.review.md`
- Implementation notes: `tasks/notes/20260808-1542-r2-hash-authority-adr.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: contract `allowed_paths`
- Concurrency rule: 本 docs-only plan 临时借用 active-plan 槽位；验收归档后切回 `plans/plan-20260805-1659-byok-keys-package.md`。
- Execution isolation: 在独立 contract worktree 与 `codex/r2-hash-authority-adr` 分支执行。

## Approach

### Strategy
1. 写 ADR-024，记录 context、三类替代方案、裁定、后果、tenant 内风险与严格 supersede 条件。
2. 修正 canonical architecture 的 hash/HEAD/commit/dedupe/reconcile 语义，并在附录 A 登记 `ADR-024 Accepted`。
3. 在 platform sprint 新增 D-9、标记 S4A 已交付并把下一 slice 改为 S4B；消费 todo；把 S4A research 的 `[unverified]` checksum 结论更新为 probe 结果。
4. 以 compose dataplane hard gate 运行全量验证，做 docs-only diff 与错误表述审计。

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| daemon 声明为 hash authority | 无额外 read-back；符合 paired-device tenant trust；不改 schema/四态 | tenant 内恶意或故障 daemon 可错标同 size/type bytes | **采用**；边界与下载端责任显式记录 |
| cloud 同步读回并重算 SHA-256 | cloud 可独立证明 digest | 每对象额外完整带宽、CPU、延迟，破坏直传价值并需要新状态语义 | 拒绝 |
| 依赖 R2 checksum | 可由 storage 返回摘要 | R2 当前不支持 PutObject SHA-256 `FULL_OBJECT`，只支持 `COMPOSITE` | 拒绝，不加 fallback |
| 阻塞 S4B 等待 R2 能力 | 避免当下 trust 裁定 | Beta 能力时间无界，GC 仍缺 identity authority | 拒绝 |

## Detailed Design

### File Changes
| File | Action | Description |
|------|--------|-------------|
| `docs/researches/r2-hash-authority-decision.md` | Create | ADR-024 Accepted；候选、后果、风险、supersede 条件与官方 capability 依据 |
| `docs/architecture/sdk-architecture.md` | Edit | daemon-declared canonical hash、HEAD/committed/reconcile 真实语义；附录 A 登记 |
| `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` | Edit | D-9；S4A 已交付；S4B 下一 slice；解除前置 |
| `tasks/todos.md` | Edit | ADR 待办标记已消费，仅在 supersede 条件成立时重开 |
| `docs/researches/s4a-dataplane-design.md` | Edit | 将 checksum `[unverified]` 更新为 MinIO/R2 probe 裁定 |
| `packages/**`, `deploy/sql/**` | Do not touch | runtime API、schema 与 migration 零 diff |

### Data Flow
`BlobClient` 计算并声明 canonical SHA-256 → cloud 验证 principal/tenant、hash 格式、size/type 并创建 `pending` manifest → R2 直传 → cloud `HEAD` 观测存在性、size/type → 匹配后 `committed`。`committed` 不等于 cloud-verified digest；若下载方声称内容完整性，下载方按声明摘要重算 bytes。

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 文档仍暗示 cloud/R2 验证 SHA-256 | 中 | 高 | canonical phrase audit；ADR 定义 `committed` 的正/负语义 |
| S4B 又把 reservation hash 作为 observed hash | 中 | 高 | ADR/sprint 明列首个实现约束：删除 `StorageFinalizeInput.observedContentHash` |
| schema 预埋 `hash_verified` 或双模式 | 低 | 高 | 明列 `0003` 禁止新增验证态/字段；supersede 必须走新 ADR |
| tenant 内 bytes 被同 size/type 替换而 reconciler 无法发现 | 中 | 高 | 显式 residual risk；跨 tenant key 隔离；完整性消费者自行 rehash |
| R2 capability 描述随时间漂移 | 中 | 中 | 链接官方 capability 表；仅在 `FULL_OBJECT` SHA-256 或 threat model 改变时 supersede |

## Task Contracts
- Contract file: `tasks/contracts/20260808-1542-r2-hash-authority-adr.contract.md`
- Review file: `tasks/reviews/20260808-1542-r2-hash-authority-adr.review.md`
- Implementation notes file: `tasks/notes/20260808-1542-r2-hash-authority-adr.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260808-1542-r2-hash-authority-adr.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present.

## Handoff
- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate
- **Merge/PR unit**: 一个 docs-only PR；ADR、canonical architecture、sprint/research/todo 同步为一个不可拆的 truth update。
- **Rollback surface**: Revert PR；无 runtime 或外部状态。
- **Verification boundary**: compose hard gate + 四项 required checks + runtime/migration zero-diff + canonical wording audit。
- **Review/acceptance boundary**: 对照 S4A-c probe、官方 R2 capability 表与实际 `HEAD` shape 做 self-review；receipt reviewer/source 使用 Codex/codex-review。
- **High-risk surface**: shared integrity contract 的诚实语义与 S4B schema 约束。
- **Why not checklist row**: 该裁定跨 daemon/cloud/Postgres/R2 且是 S4B 的 schema hard prerequisite。

## Evidence Contract
- **State/progress path**: 下方 `## Task Breakdown` 与 platform sprint D-9。
- **Verification evidence**: `.ai/harness/checks/latest.json`、contract review、PR CI、zero-diff/phrase-audit 命令结果。
- **Evaluator rubric**: ADR 明确 read-back 成本、R2 checksum 不可用、tenant 内风险、supersede 条件；architecture 不再称 HEAD/hash verified；S4B 四项约束完整；全量 gates 绿色且 packages/deploy/sql 零 diff。
- **Stop condition**: 任一 runtime/schema/migration diff；引入 checksum/readback fallback；新增第二 ADR 索引；把 `committed` 写成 digest verified。
- **Rollback surface**: Revert docs-only PR。

## Annotations

已核对：contract scope 仅覆盖本刀 docs/workflow artifacts；acceptance reviewer/source 使用 `Codex` / `codex-review`。

## Task Breakdown
- [x] 建立并批准 docs-only contract/worktree，切到 `codex/r2-hash-authority-adr`
- [x] 新增 ADR-024 并同步 architecture、sprint、todo、S4A research
- [x] compose dataplane hard gate 全绿；runtime/migration zero-diff；canonical wording audit 通过
- [ ] review/receipt/PR/CI 合入，归档本 workflow 并归还 K-line active-plan 槽位
