# byok-sdk post-0.4.2 进度与 Sprint 建议复核报告

> Date: 2026-08-20
> Repository: `Ancienttwo/byok-sdk`
> Local baseline: `main@f8bccbdffcac32c2c5e9aab3889af25006e6d5e0`
> Release baseline: `v0.4.2^{}` = `de07001c85c274ce955d1f76181de143fee2cc80`
> Purpose: 供 Claude 独立复核当前项目进度，以及原审计提出的两个后续 Sprint 是否成立。
> Scope: read-only audit。本文不修改 product truth、active plan、Sprint、todo、release version 或 deployment state。
> Independent review: 2026-08-20 `CONFIRMED / Sprint A ACCEPT / Sprint B SPLIT`；复核结果见 §12。

## 1. Claude 复核请求

请独立检查本文的事实与判断，不把本文结论当作前提。至少回答以下问题：

1. `v0.4.2` 实际包含哪些 Live Activity、approval、UI runtime 和 P5 能力？
2. `v0.4.2..main` 的真实 product delta 是否主要是 device assertion authenticator 与 migration `0008`？
3. 下一次 release 是否需要 `0.5.0`，还是应先按真实 public API/migration delta 做 semver 裁定？
4. 修订后的 Sprint A 是否足以形成 release + downstream consumption 闭环？
5. Connector operability、mutation safety、hosted multi-product auth 是否应拆成不同触发条件，而不是一个 Sprint 一次实现？
6. 本文是否遗漏会改变优先级的代码、CI、registry、Salesko 或 operator evidence？

复核输出建议采用：

- `CONFIRMED`：事实和边界成立；
- `CORRECTION`：指出文件、commit、registry 或 runtime evidence；
- `UNKNOWN`：说明还需要哪一项 live readback；
- `RECOMMENDATION`：给出修订后的 Sprint 顺序和最小充分范围。

## 2. 结论摘要

原审计对项目阶段、connector 缺口和治理漂移的方向判断大体成立，但有一个会改变下一 Sprint 范围的关键错误：它把已经随 `0.4.2` 发布的 Live Activity、approval timeline、UI runtime 和 P5 TruthStore profile persistence 误算成 post-`0.4.2` 未发布能力。

当前更准确的状态是：

> `0.4.2` release train 已完成并获得 npm/GitHub/CI 证据；其后的 device assertion authenticator 已合并并通过 main CI，但尚未形成新 release、`0.4.2 DB -> candidate` 升级演练和 Salesko candidate 消费证据。

因此：

- 原 Sprint A 的目标正确，但 release contents、migration scope 和 dogfood 范围需要收窄；
- 原 Sprint B 的问题判断正确，但混合了三个不同的触发条件，不能作为一个连续实现 Sprint 原样启动。

## 3. 证据等级与核对面

本文使用以下证据等级：

- `[live]`：本轮直接读取 GitHub、npm、git refs 或当前 checkout；
- `[repo]`：当前 `main` 上的源码、测试、Sprint、todo 或文档；
- `[downstream]`：当前本机 Salesko checkout 的 manifest、commit 与已记录 smoke evidence；
- `[judgment]`：基于上述事实的范围或优先级判断，不冒充已发布事实。

已核对：

- local `main`、`origin/main`、`v0.4.2` tag 和 `v0.4.2..main` diff；
- GitHub repository visibility、PR #72-#78、release list、main CI；
- npm `byok-sdk@0.4.2`、`@byok-sdk/ui-runtime@0.4.2`、`@byok-sdk/keys@0.2.0` metadata/integrity；
- package manifests、SQL migrations、release scripts、CI job list；
- runtime lifecycle Sprint、Salesko upstream Sprint、deferred goal ledger、architecture queue；
- `/Users/kito/Projects/salesko-new` 当前 main 的 package pins 与 S3 smoke notes。

未核对：

- production database 当前 migration ledger；
- production Worker/VPS 实际 deployment version；
- production secrets、credentials 或 private runtime logs；
- Obsidian project memory。`_AI-Memory` 当前只有 `.obsidian` 配置，没有要求的 `INDEX.md` 或项目笔记。

## 4. P1：当前架构与交付地图

### 4.1 已成立的阶段判断

`[repo][live]`

- 平台 Sprint `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` 为 `Done`。
- Runtime Adapter Lifecycle Sprint 为 `Done`，三行 backlog 均为 `[x]`：prepared operation、typed failure taxonomy、quiescent disposal。
- 审计开始时 `main == origin/main == f8bccbd` 且 checkout clean；生成本文后，预期只有本文一个 untracked documentation path。
- GitHub 将仓库识别为 `PUBLIC`，不是 private。
- 最新 GitHub/npm release 是 `0.4.2`；keys 独立版本是 `0.2.0`。
- PR #76 approval persistence、#77 approval projection、#78 device assertion authenticator 均已合并。
- 最新 main CI run `32005324582` 成功，包含 build/typecheck/test、真实 Postgres、packed migration、release pack/install、跨平台 adapter lifecycle、IPC、credential isolation、Bun/SEA packageability。
- CI 当前没有独立 lint/format job。

### 4.2 已成立的未闭合问题

`[repo]`

- `tasks/todos.md` 仍明确保留：
  - device-local toolset lifecycle/health；
  - MCP exact-tool policy、approval、redacted audit；
  - hosted multi-product instance authority。
- `tasks/current.md` 生成于 2026-08-17，按自身 24h 规则已经 stale，source commit 仍是 `4485823`。
- Salesko upstream Sprint 顶层为 `Done`，但八行 backlog 仍全是 `[ ]`。
- `docs/architecture/sdk-architecture.md` header 仍写 verified against `v0.1.1` / 2026-08-10。
- `.ai/harness/sprint/active-sprint` 仍指向已经 Done 的 runtime Sprint；`sprint-backlog next` 返回 `(none)`。
- architecture queue 当前原始输出为 `pending=1`、`blocking=1`、gate mode advisory；这里的 `blocking` 计数没有把 advisory gate 改成当前执行 hard stop，但必须在 A1 中处理。

这些不是纯排版问题。当前 workflow 会从上述投影恢复执行上下文，陈旧或互相矛盾的状态会改变后续 Agent 对 active scope 和 next task 的判断。

## 5. P2：release 与 downstream concrete trace

### 5.1 `0.4.2` 已经发布的内容

`[live][repo]`

`v0.4.2` 指向 `de07001`。在该 tag 上可直接读取：

- `examples/live-activity-host/src/index.ts`；
- `packages/ui-runtime/src/approval-timeline.ts`；
- `deploy/sql/0007_approval_timeline.sql`；
- `packages/keys/src/truth-profile-store.ts`；
- `TruthStoreProviderProfileStore` public export；
- `packages/ui-runtime/package.json` version `0.4.2`；
- `packages/keys/package.json` version `0.2.0`，依赖 `@byok-sdk/core`。

npm metadata 同时显示：

```text
byok-sdk@0.4.2
  -> @byok-sdk/client@0.4.2
  -> @byok-sdk/cloud@0.4.2
  -> @byok-sdk/cloud-dataplane@0.4.2
  -> @byok-sdk/core@0.4.2
  -> @byok-sdk/protocol@0.4.2
  -> @byok-sdk/server@0.4.2
  -> @byok-sdk/ui-runtime@0.4.2

@byok-sdk/keys@0.2.0
  -> @byok-sdk/core@0.4.2
```

所以原审计以下判断不成立：

> main 已包含 approval persistence、approval UI projection、Live Activity host reference、P5 TruthStore profile，但这些尚未进入 `0.4.2` release。

这些能力绝大部分已经在 `0.4.2` release source 和 registry graph 中。

### 5.2 `v0.4.2..main` 的真实 delta

`[repo]`

当前 commit 序列如下，按 oldest-first 排列：

```text
9e869b8 fix(release): verify ui runtime registry export
a7074ad docs: refresh release closeout status
176e99d feat: authenticate device assertions for connector binding
5ce9340 chore: align device assertion contract scope
4485823 feat(contract): complete device-assertion-authenticator
9c73b62 chore(workflow): archive device-assertion-authenticator closeout
f8bccbd Merge pull request #78
```

产品代码 delta 主要包括：

- core device assertion verification/authentication contracts；
- exact issuer/product/audience binding；
- current DeviceDirectory row-derived principal 与 revocation；
- InMemory/Postgres atomic replay authority；
- `deploy/sql/0008_device_assertion_replay.sql`；
- cloud hosted authenticator composition；
- shared conformance、real Postgres race、bounded replay cleanup；
- public exports、README/spec/architecture updates。

Verifier 修正解决的是 registry readback 预期列表漏掉已经发布的 `uiRuntime` namespace，不产生新的 tarball content，也没有移动 immutable `v0.4.2` tag。

### 5.3 migration 已有与缺失的证据

`[repo][live]`

已经存在：

- packed candidate tarball 携带 migrations 的检查；
- Empty DB 首次应用全部 migration；
- 同一目录第二次运行 no-op，并核对 checksum ledger；
- real Postgres migration runner tests；
- migration `0008` 的 Postgres replay authority tests；
- 64 个并发 assertion exchange 仅一个成功；
- replay ledger bounded `deleteExpired(before, limit)` 及测试。

仍然缺失或未取得 live readback：

- 一份真实 `0.4.2` schema/data snapshot 到 candidate 的升级演练；
- production migration ledger readback；
- production deployment/readiness readback；
- operator cadence 对 replay cleanup 的调度证据。

Approval timeline 已有 capacity、TTL 和 read-time expiry。InMemory read 会移除过期 tail；Postgres read 会过滤过期行，但当前 store surface 没有统一的物理删除 API。因此“补 approval cleanup”如果进入后续工作，应准确限定为 expired Postgres row 的运营清理，而不是重新实现 TTL semantics。

### 5.4 Salesko 已有消费证据

`[downstream]`

Salesko 当前 `main@2831252` 固定：

- `@byok-sdk/cloud@0.4.1`；
- `@byok-sdk/cloud-dataplane@0.4.1`；
- `@byok-sdk/client@0.4.1`；
- `@byok-sdk/keys@0.1.0`。

其 S3 notes 记录真实 dev topology 的 `11/11 ALL PASS`，覆盖 pair、offline negative、presence、ceiling decline、monotonic sequence、真实 no-tools model round trip、extractor、structured terminal document 和 revoke。

因此“没有真实 downstream consumption evidence”不准确。准确结论是：

> 已有 `0.4.1` registry-package + real dev topology evidence；尚无 `0.4.2` 或 post-`0.4.2` candidate 的 Salesko consumption evidence。

Salesko 同一 notes 还记录当时 VPS byok-control 仍在 `0.2` image。本文没有连接 VPS 做 current live readback，所以该条只能作为 downstream repo 记录，不能宣称为 2026-08-20 的 production fact。

## 6. P3：对原 Sprint A 的裁定

### 6.1 原建议

原 Sprint A 为 `0.5.0 Release & Pilot Closure`，包含：

- 修正项目状态；
- 冻结 UI runtime、approval、P5、device assertion 等 release contents；
- Empty DB、idempotence、`0.4.2 DB -> 0.5.0`、rollback matrix；
- Salesko 重新做包含 Gmail、timeline、provider persistence、revoke、replay、connector crash 的完整 dogfood。

### 6.2 判断

`[judgment]` 目标正确，但原范围不成立：

1. UI runtime、approval timeline、Live Activity 和 P5 已发布，不能再次作为 next-release delta。
2. Empty DB 与 idempotent migration 已有 packed-tarball CI，不应冒充缺失项。
3. Salesko 已有 `0.4.1` 11/11 baseline，不需要重建整条 pilot。
4. “connector crash 后 host 显示 typed status”依赖尚未实现的 connector operability，若放进 Sprint A 会形成对 Sprint B 的反向依赖。
5. Gmail、provider-profile UI、approval UI 若当前 downstream 没有真实 consumer path，会把 release closure 扩大为新产品集成。
6. `0.5.0` 可以是最终版本选择，但不能用已经进入 `0.4.2` 的功能作为 semver 理由。

### 6.3 建议替代 Sprint A

建议名称：

> `post-0.4.2-device-assertion-release-and-salesko-upgrade`

目标：把 `v0.4.2..main` 的真实 delta 形成可安装、可升级、可 readback、被现有下游消费的 release candidate。

建议只包含三行：

| # | Task | Acceptance |
|---|---|---|
| A1 | Reconcile authority + freeze actual release delta + semver decision | `tasks/current.md`、done Sprint marker、Salesko Sprint backlog、architecture header/queue 不再互相矛盾；release note 只列 `v0.4.2..candidate` 真实 product delta；版本号有明确兼容性理由 |
| A2 | Candidate package + `0.4.2 DB -> candidate` upgrade evidence | fixture 由 Empty DB 只应用 `0001`-`0007` 后写入代表性 mailbox/task/truth/quota seed rows，再应用 candidate 新 migration；既有 rows 保留；candidate tarball、package graph、migration checksum、isolated import/readback 全部通过 |
| A3 | Salesko candidate repin + existing smoke extension | Salesko 从 `0.4.1` repin candidate；显式裁定并验证 `@byok-sdk/keys@0.1.0 -> 0.2.0` 及其 `core@0.4.x` dependency change；既有 11/11 smoke 继续通过；新增 assertion success、same-assertion replay rejection、revoked-device rejection；记录 SDK SHA、tarball integrity、downstream SHA 和 migration result |

明确 out of scope：

- connector typed crash/readiness lifecycle；
- write/mutation connector；
- generic connector sandbox；
- hosted multi-product authority；
- 新的 Gmail 产品流程；
- production deploy，除非 operator 另行授权。

这个范围充分的原因：它闭合当前唯一未发布 product delta、唯一缺失的 prior-version upgrade path，以及现有真实下游的 candidate consumption，不要求先实现下一阶段 connector framework。

## 7. P3：对原 Sprint B 的裁定

### 7.1 原建议

原 Sprint B `Connector Safety & Operability` 同时包含：

- toolset lifecycle/health/reload；
- exact-tool policy、mutation approval、audit；
- hosted single/multi-product auth authority；
- readiness、replay、migration、cleanup 等运营证据。

### 7.2 判断

`[judgment]` 问题都真实，但它们没有同一个启动条件：

| Area | Existing trigger | Decision |
|---|---|---|
| Read-only connector operability | 第二个真实 connector，或 Gmail 进入长期运行 dogfood | 可以成为近期独立 Sprint |
| Mutation safety | 第一个 write/mutation connector 上线前 | 硬 gate，但未触发时不提前实现 |
| Hosted multi-product authority | 第一个服务多个 product 的 hosted deployment | 独立 security/architecture slice |
| Operational evidence | 随拥有该状态/动作的能力一起交付 | 不单独建设无 authority 的 dashboard |

把四者一次实现会产生两个问题：

1. read-only connector 会被尚不存在的 mutation product requirements 阻塞；
2. hosted bearer authority 会被错误地包装成 connector lifecycle 的子问题。

### 7.3 建议拆分

#### Sprint B1: `connector-readonly-operability`

启动条件：第二个真实 connector，或 Gmail 明确进入长期运行 dogfood。

最小范围：

- `installed | unauthorized | starting | ready | degraded | crashed | incompatible`；
- connector version 与 last readiness result；
- host-owned config reload；
- enable/disable 只在本地 host authority 下裁定；
- daemon restart 与 connector crash/recovery tests；
- bounded、redacted status evidence；
- SaaS 仍不得远程下发 executable definition。

#### Sprint B2: `connector-mutation-safety`

启动条件：第一个 write/mutation connector 已被产品计划确认。

最小范围：

- exact tool allowlist；
- read/mutation classification；
- task manifest 指定允许 tools；
- local approval targeting 与 expiry；
- redacted audit event；
- secret/body/header 不落日志；
- deny、timeout、crash recovery tests。

#### 独立 slice: `hosted-product-authority`

启动条件：真实 multi-product hosted deployment。

先裁定 deployment authority 是单值 product、tenant-to-product mapping，还是其他显式 contract；然后再决定 bearer principal 和 device assertion expected product 的检查位置。禁止照搬 embedded server 单 product 语义或加入双读/fallback。

## 8. 推荐执行顺序

```text
authority reconciliation
  -> actual v0.4.2..main delta freeze
  -> semver decision
  -> 0.4.2 DB to candidate upgrade
  -> candidate pack/readback
  -> Salesko candidate repin + extended smoke
  -> publish/deploy only under separate authorization

real long-running connector trigger
  -> connector-readonly-operability

first mutation connector trigger
  -> connector-mutation-safety

first multi-product hosted deployment trigger
  -> hosted-product-authority
```

这条顺序先闭合现有 release 和 consumer evidence，再让真实 connector 压力触发通用 contract。它不会把未来可能需要的 framework 变成当前 release 的前置条件。

## 9. 风险与未知项

1. `[unknown]` `0.4.2` production database 的实际 schema/data shape 尚未读取；升级 fixture 只能证明代表性路径，不能替代 production preflight。
2. `[unknown]` Salesko VPS 当前是否仍是 notes 记录的 `0.2` image，需要 live deployment readback。
3. `[decision: A1 closed]` 下一 aligned dispatch candidate 采用 `0.5.0`：新增 public API、migration `0008` 和新的 authentication authority 属 feature-level delta；pre-1.0 version policy 已写入 `docs/spec.md`。这不是 publish 授权。
4. `[resolved: A1]` `tasks/current.md`、done Sprint marker、Salesko Sprint backlog 和 architecture queue 的漂移已完成 reconciliation；见 §13 的执行证据。
5. `[risk]` 把 connector health 纳入 release A 会形成循环依赖，并把 release closeout扩大成新 framework。
6. `[risk]` 把 mutation safety延后到 write connector 已上线之后会扩大本地账号权限，因此 B2 是上线前 hard gate，不是上线后优化。

## 10. Claude 最终裁决模板

```markdown
# Independent Review Verdict

## Release boundary
- Verdict: CONFIRMED / CORRECTION / UNKNOWN
- Evidence:

## Sprint A
- Verdict: ACCEPT / REVISE / REJECT
- Smallest sufficient scope:
- Missing acceptance evidence:

## Sprint B
- Verdict: ACCEPT / SPLIT / REJECT
- Trigger ordering:
- Security boundary concerns:

## Version decision
- Recommended version:
- Compatibility rationale:
- Evidence still required:

## Final recommendation
RECOMMENDATION: <one line> - confidence: HIGH / MEDIUM / LOW
```

## 11. Reproduction commands

以下命令只读取状态，不执行 publish、deploy 或 migration：

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse v0.4.2^{}
git log --oneline v0.4.2..main
git diff --name-status v0.4.2..main

git show v0.4.2:deploy/sql/0007_approval_timeline.sql
git show v0.4.2:packages/ui-runtime/src/approval-timeline.ts
git grep -n TruthStoreProviderProfileStore v0.4.2 -- packages/keys

gh repo view Ancienttwo/byok-sdk --json isPrivate,visibility,defaultBranchRef
gh pr list --repo Ancienttwo/byok-sdk --state merged --limit 8
gh run list --repo Ancienttwo/byok-sdk --branch main --limit 8
gh run view 32005324582 --repo Ancienttwo/byok-sdk --json jobs
gh release list --repo Ancienttwo/byok-sdk

npm view byok-sdk@0.4.2 dependencies --json
npm view @byok-sdk/ui-runtime@0.4.2 version dist.integrity --json
npm view @byok-sdk/keys@0.2.0 dependencies dist.integrity --json

repo-harness run architecture-queue status --format json
repo-harness run sprint-backlog next
repo-harness run check-task-workflow --strict

git -C /Users/kito/Projects/salesko-new status --short --branch
git -C /Users/kito/Projects/salesko-new log -1 --oneline
rg -n '"@byok-sdk/' \
  /Users/kito/Projects/salesko-new/apps/byok-control/package.json \
  /Users/kito/Projects/salesko-new/apps/local-agent/package.json
```

## 12. 独立复核结果

> Source: 用户提供的 Claude independent review，2026-08-20。以下记录 review disposition；本节不把 production unknown 改写成已验证事实。

### 12.1 Verdict

- Release boundary: `CONFIRMED`。
- Sprint A: `ACCEPT`，采用 §6.3 的三行收窄范围。
- Sprint B: `SPLIT`，采用 read-only operability、mutation safety、hosted product authority 三个触发边界。
- Version recommendation: `0.5.0`，confidence `MEDIUM`；已在 A1 采用为下一 candidate，publish 仍需独立授权。
- Final recommendation: 接受事实纠正与 Sprint A/B 修订，按 §8 顺序执行，起点是 A1 authority reconciliation，优先修 Salesko upstream Sprint 的 `Done` / 全 `[ ]` 矛盾。

### 12.2 Review corrections incorporated

1. §5.2 commit list 已标注 oldest-first，避免误读 `9e869b8` 为 HEAD。
2. §4.2 已记录 architecture queue 的完整原始计数：`pending=1 blocking=1`，同时保留 gate mode advisory 的语义。
3. A2 已明确 `0.4.2` fixture 来源：Empty DB 应用 `0001`-`0007`，再写入代表性 seed rows。
4. A3 已把 Salesko `@byok-sdk/keys@0.1.0 -> 0.2.0` 和随之发生的 `core` dependency change 列为显式 compatibility acceptance。
5. §9 将 `0.5.0` 从未定候选更新为独立复核建议；A1 随后已完成 owner decision 和 version policy 落盘。

### 12.3 Still unresolved

- production migration ledger；
- production Worker/VPS deployment version；

## 13. A1 execution closeout

2026-08-20 已完成 A1 authority reconciliation：

- `tasks/current.md` 重新生成，active Sprint 为 `(none)`；已完成 runtime Sprint 的 ignored marker 已清除。
- Salesko upstream Sprint 的八行 backlog 已按 PR #50、#52-#59 和对应 plan/artifact 证据 reconciled 为 `[x]`，Execution Log 补齐历史 merge evidence。
- architecture header 已区分 published `v0.4.2@de07001` 与 `main@f8bccbd`；root queue card 已归档为 `Resolved`，queue readback 为 `pending=0 blocking=0`。
- `docs/spec.md` 已确立 pre-1.0 policy，并采用 `0.5.0` 为下一 aligned dispatch candidate；没有修改 package manifests，也没有执行 publish、deploy 或 migration。
- 验证：`repo-harness run check-task-workflow --strict`、architecture queue `status/reindex/check` 与 `git diff --check` 全部通过。

仍未闭合的是 A2/A3 的 production/deployment evidence，不属于 A1 authority reconciliation。

## 14. A2 implementation checkpoint

2026-08-20，A2 已在 linked contract worktree 完成 implementation、本地
candidate evidence 与首轮独立 review remediation；fresh review/main integration
尚未执行：

- exact packed candidate commit `3e06eee76a1ab332219235a68cc23af83c96c0fa`
  将 aligned dispatch manifests/lockfile 更新为 `0.5.0`；
  `@byok-sdk/keys` 保持 `0.2.0`。
- `v0.4.2` migration baseline 每次都直接读取 tag `v0.4.2` 的
  `deploy/sql/0001`-`0007` bytes，并要求其 SHA-256 与 committed fixture 一致；
  CI checkout 显式获取完整 tag history。
- exact candidate pack 生成九个 `0.5.0` tarballs，installed dependency graph
  闭合为单一 version set；cloud-dataplane tarball 携带与 `deploy/sql`
  双向 SHA-256 一致的八个 migrations。
- 临时 PostgreSQL 17 的 empty-install/idempotence path 使用 deployment-default
  `public` schema；tag-bound `v0.4.2` schema 的 stream、mailbox、task、truth、
  quota rows 在应用 `0008_device_assertion_replay.sql` 后保持不变。
- replay table/index readback 通过；installed tarball 的
  `PostgresDeviceAssertionReplayAuthority` 接收 64 个 concurrent consumes，
  恰好一个成功；最终 migration rerun 为 no-op。
- 对同一 database 再次执行 smoke 会 exit `1`，并明确报告必须使用 fresh
  database（无 public tables 且无 `byok_upgrade_v042` schema），而不是暴露
  无上下文的 `schema already exists`。
- `bun run build`、`bun run typecheck`、`bun run test`、release graph、
  strict workflow 和 `git diff --check` 均通过。

A2 首轮 Claude review 的 typed disposition 为 `reject`；其 P2 evidence gaps
已按上述路径修复，但旧 receipt 没有被重写为 pass，必须对 remediated subject
取得 fresh disposition。A2 没有执行 publish、push、production migration 或 Salesko repin。production
migration ledger/deployment version 仍是 release operator evidence；A3 仍负责
Salesko candidate consumption 与 assertion/revocation smoke。
