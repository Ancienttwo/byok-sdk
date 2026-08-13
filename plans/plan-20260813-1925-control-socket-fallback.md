# Plan: controlSocketPath fallback — fixed root, env-independent address

> **Status**: Executing
> **Created**: 20260813-1925
> **Slug**: control-socket-fallback
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: todos:O-1 Closed 行残余登记
> **Artifact Level**: work-package
> **Promotion Reason**: O-1 残余:controlSocketPath 与已修的 mutex 同款 os.tmpdir() 缺陷——深 TMPDIR 下 control socket 静默不可用(CLI 控制路径从未被 credential-isolation job 覆盖)、地址随环境漂移;实证与修复形状均来自 PR #64
> **Verification Boundary**: client 全量测试 + 守卫红→绿 + pnpm -r typecheck;其余包零 diff
> **Rollback Surface**: revert;零迁移;degrade 语义零变化
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260813-1925-control-socket-fallback.contract.md`
> **Task Review**: `tasks/reviews/20260813-1925-control-socket-fallback.review.md`
> **Implementation Notes**: `tasks/notes/20260813-1925-control-socket-fallback.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: todos:O-1 Closed 行残余登记
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260813-1925-control-socket-fallback.md`
- Sprint contract: `tasks/contracts/20260813-1925-control-socket-fallback.contract.md`
- Sprint review: `tasks/reviews/20260813-1925-control-socket-fallback.review.md`
- Implementation notes: `tasks/notes/20260813-1925-control-socket-fallback.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260813-1925-control-socket-fallback.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260813-1925-control-socket-fallback.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260813-1925-control-socket-fallback.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260813-1925-control-socket-fallback.contract.md`
- Review file: `tasks/reviews/20260813-1925-control-socket-fallback.review.md`
- Implementation notes file: `tasks/notes/20260813-1925-control-socket-fallback.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260813-1925-control-socket-fallback.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260813-1925-control-socket-fallback.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: revert;零迁移;degrade 语义零变化
- **Verification boundary**: client 全量测试 + 守卫红→绿 + pnpm -r typecheck;其余包零 diff
- **Review/acceptance boundary**: `tasks/reviews/20260813-1925-control-socket-fallback.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: O-1 残余:controlSocketPath 与已修的 mutex 同款 os.tmpdir() 缺陷——深 TMPDIR 下 control socket 静默不可用(CLI 控制路径从未被 credential-isolation job 覆盖)、地址随环境漂移;实证与修复形状均来自 PR #64

## Evidence Contract

- **State/progress path**: `plans/plan-20260813-1925-control-socket-fallback.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260813-1925-control-socket-fallback.contract.md`, `tasks/reviews/20260813-1925-control-socket-fallback.review.md`, and `tasks/notes/20260813-1925-control-socket-fallback.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260813-1925-control-socket-fallback.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: revert;零迁移;degrade 语义零变化

## Captured Planning Output

# Plan: controlSocketPath fallback — fixed root, env-independent address

> **Spec**: `docs/spec.md`
> **Research**: O-1 刀的实证(PR #64,`tasks/archive/notes-20260813-1124-ci-stability-flakes.md` follow-up 节;credential-isolation smoke 日志里 `control socket failed to start (continuing without it): listen EINVAL`)

## Agentic Routing
- Selected route: fast-worker 执行(缺陷已由 O-1 探针实证,修复形状已验证,无需再派 root-cause-prover),gatekeeper 验收。
- Routing reason: S 尺寸单面改动,evidence 已在档。
- Due diligence:
  - P1 map: 派生权威在 `packages/client/src/daemon/control-protocol.ts:66-70` `controlSocketPath`:`<storeDir>/control.sock` 超 `sun_path` 预算(104/108)时 fallback 到 `path.join(os.tmpdir(), 'byok-<shortHash(storeDir)>', 'sock')`。消费方:daemon 侧 `control-server.ts` bind,CLI 侧(status/unpair 等)connect——两侧同函数派生,地址一致性靠单源。win32 named pipe 分支不受影响。
  - P2 trace(O-1 已实证的同款机制): smoke 把 `TMPDIR` 设进长树 → fallback 比原路径更长 → bind `EINVAL` → control server 走 degrade 分支「continuing without it」→ CLI 控制路径静默不可用(credential-isolation job 从未真正覆盖过 CLI 控制面);且地址含 `os.tmpdir()`,同 store 不同环境(service manager vs operator shell)派生不同地址,CLI 连不上活 daemon。
  - P3 decision rationale: ① 与 O-1 mutex 同判:fallback 根改固定 `/tmp` 字面量,地址只由 canonical storeDir 派生,永不超预算、不随环境漂移;`byok-<hash>` 一级嵌套 + 0700 属主校验保护保持(在 world-writable /tmp 下更重要,对齐 daemon-owner.ts 的 `assertOwnedPrivateDir` 已有形状)。② degrade 语义不动:control socket 本就非 fail-closed 权威,本刀只修派生,不改「bind 失败继续跑」的行为。③ 无兼容双读:不探测旧 `os.tmpdir()` 地址;地址变更只影响「深 TMPDIR 且长 storeDir」这一原本就废掉的场景,正常场景 `<storeDir>/control.sock` 逐字节不变。

## Approach
1. `control-protocol.ts`:fallback 根改固定 `/tmp`(win32 分支不动);必要时提取与 daemon-owner.ts 共享的常量/属主校验(仅当两处逐字节同构才共享,否则各自保留——不为一次复用造抽象)。
2. 测试(`packages/client/src/__tests__/`):O-1 守卫 E/F 同型——(E) 深 TMPDIR + 长 storeDir 下派生地址必在预算内且 daemon control socket 真正可用(bind 成功,CLI 侧可 connect);(F) 地址不随 TMPDIR 变。对旧实现红。
3. 全量 client suite + `pnpm -r typecheck`;credential-isolation 拓扑的本地等价 smoke(非 strace 部分)确认 `continuing without it` 不再出现。
4. gatekeeper 验收。

## Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| 双地址探测(新旧 fallback 都试) | 平滑升级 | steady-state 兼容路径,纪律禁止;旧地址场景本就废的 | 拒绝 |
| 顺手把 degrade 改 fail-closed | 控制面更严 | 改变产品语义,超本刀范围,control socket 非安全权威 | 拒绝 |
| 与 daemon-owner 共享 fallback helper | 单源 | 两处预算/命名/属主校验细节不同则强行抽象 | 仅逐字节同构才共享 |

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 正常场景 control.sock 路径意外变化 | Low | High | 守卫断言 `<storeDir>/control.sock` 逐字节不变 |
| /tmp 属主/符号链接攻击面 | Low | Med | 沿用 0700 + 属主/symlink 校验既有形状,gatekeeper 核对 |

## Promotion Gate
- **Merge/PR unit**: 单 PR。
- **Rollback surface**: revert;零迁移。
- **Verification boundary**: client 全量测试 + 新守卫红→绿 + `pnpm -r typecheck`;其余包零 diff。
- **Review/acceptance boundary**: gatekeeper 单轨。
- **High-risk surface**: 控制面地址派生;degrade 语义零变化。
- **Why not checklist row**: 生产 daemon 路径改动 + 独立回滚面。

## Evidence Contract
- **State/progress path**: 本 plan + contract + notes。
- **Verification evidence**: 守卫红→绿输出、client suite、smoke 等价验证。
- **Evaluator rubric**: 正常路径逐字节不变;深 TMPDIR 下 control socket 可用;地址环境无关;degrade 分支行为未变。
- **Stop condition**: 任何双地址探测或 degrade 语义改动。
- **Rollback surface**: revert commit。

## Annotations

- 已解决:方向即 O-1 残余登记(todos Closed 行 + gatekeeper O 系观察);无遗留注释。

## Task Breakdown
- [x] fast-worker: fallback 派生修复 + 守卫 E/F 同型测试(先红后绿)——RED artifact + 3 守卫绿,111 文件/1167 测试全绿
- [x] 本地 smoke 等价验证——深 TMPDIR 下 before 含 EINVAL degrade 行,after 无 control socket 行且 smoke PASS
- [x] gatekeeper 验收——PASS,六项不变量逐条核实,LOW/INFO 观察已消费(todos 销账 + doc-drift 新条目)

