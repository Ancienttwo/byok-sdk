# Implementation Notes: domain-model-adr

> **Status**: Active
> **Plan**: plans/plan-20260903-0442-domain-model-adr.md
> **Contract**: tasks/contracts/20260903-0442-domain-model-adr.contract.md
> **Review**: tasks/reviews/20260903-0442-domain-model-adr.review.md
> **Last Updated**: 2026-09-03 04:46
> **Lifecycle**: notes

## Design Decisions

- 附录 A 的当前最大编号是 **ADR-025**（`docs/architecture/sdk-architecture.md:2123`），不是计划预估的 022，因此本刀写的是 **ADR-026 – ADR-034**，不是 ADR-023–031。
- 新文件 `docs/architecture/adr-2026-09-03-domain-model-and-authority.md`（178 行），九条 ADR 各带 Context / Decision / Consequences / Status，Context 一律引审查报告章节 + 本 worktree 复核过的 `file:line`。
- 两条标 Supersedes，都给了审查报告出处：
  - **ADR-032 Supersedes ADR-004**（server 不演化为 hosted Hub）。ADR-004 让 server 保有与 cloud 零共享的第二套协调权威；review §7 V4 实证该双权威已漂移，§6 O1 两轨一致、§8 D1 采纳折叠。折叠不改 self-hosted 交付形态，只取消第二套语义。
  - **ADR-034 Supersedes ADR-002**（v1 冻结、新能力一律走 wire 外 HTTP）。review §7 V6 实证该策略失效（v1 号下 5 种 offer + 20 flag），§8 D2 裁定 1.0 前切 wire v2。v1 本身仍冻结，取代的是「永不开 v2」这一条。
- 没有任何一条标 `Proposed`：九个议题在 review §6 / §8（WP 表 + D1–D5）/ §12 / §13 里都有已裁定的结论，无需本刀新决策。
- 兼容而未取代的既有 ADR，在正文里显式点名：ADR-025（Device/Agent/placement 分权，本刀只把 Device 一格确认为 Installation）、ADR-023（`workspaceHint` reserved，其要求的 resolver 前提由 ADR-031 的 WorkspaceRef 提供，v1 退场时由 v2 `workspaceRef` 承接）、ADR-010（声明式 capability，ADR-030 在其上加 registry）、ADR-008 / ADR-009 / ADR-006（ADR-029 / ADR-033 叠加而非替换）、ADR-017（Deferred 的 async TaskStore，触发条件由 ADR-032 满足）。
- 帐本只追加九行到 `sdk-architecture.md` 附录 A 表尾，列形状与既有行一致，文件其余部分零改动；`docs/architecture/index.md` 新增一个 `## Decision Records` 段与一条链接行。`docs/spec.md` 未触碰。

### 引用过的 file:line（本 worktree 逐条 grep 复核）

`packages/server/src/types.ts:131,261`、`packages/protocol/src/http-api.ts:51`、`packages/cloud/src/stores/ports.ts:233-242,251-269`、`packages/client/src/agent-home.ts:600-607,613`、`packages/protocol/src/version.ts:35,108-129`、`packages/core/src/capabilities.ts:22`、`packages/protocol/src/agent-egress.ts:87`、`packages/server/src/ws-server.ts:9`、`packages/server/src/index.ts:139,203`、`packages/client/src/daemon/url.ts:15`、`packages/client/src/daemon/task-runner.ts:1482,1569-1573`、`packages/client/src/daemon/create-daemon.ts:289,1160-1161`、`packages/client/src/daemon/session-workspace-store.ts:14,21,99`、`packages/client/src/daemon/agent-session-handoff-store.ts:245-250`、`packages/client/src/bin/config.ts:63-67`、`packages/client/src/adapters/claude/claude-adapter.ts:456`、`packages/client/src/adapters/pi/pi-adapter.ts:486-500`、`packages/protocol/src/envelope.ts:63-64`、`docs/spec.md:551-553`、`README.md:87`、`docs/host-local-storage-layout.md:64`。

## Verification Tails

```
$ bun run check:version-authority
error: Script not found "check:version-authority"
```
该脚本随 WP1（分支 `codex/api-surface-golden`）落地，本分支 `codex/domain-model-adr`（base `4cc765f`）的根 `package.json:16-30` 里没有它。契约 `exit_criteria.commands_succeed` 列了它，本刀无法运行，按计划 Stop Condition 报告并跳过；spec 未被触碰，该检查的被检对象也未变。

```
$ repo-harness run check-task-workflow --strict
[workflow] OK
```

```
$ git diff --check
(no output, exit 0)
```

```
$ git status --short
 M docs/architecture/index.md
 M docs/architecture/sdk-architecture.md
?? docs/architecture/adr-2026-09-03-domain-model-and-authority.md
?? plans/plan-20260903-0442-domain-model-adr.md
?? tasks/contracts/20260903-0442-domain-model-adr.contract.md
?? tasks/notes/20260903-0442-domain-model-adr.notes.md
?? tasks/reviews/20260903-0442-domain-model-adr.review.md
```

## Deviations From Plan Or Spec

- 编号从 ADR-026 起而非计划预估的 ADR-023：附录 A 当前最大值已是 ADR-025。计划 Annotations 明确允许「worker 找到更高编号则从那里续起」。
- `bun run check:version-authority` 在本分支不存在，未运行（见上）。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| ADR-032 标 Supersedes ADR-004 vs 只写「细化」 | Supersedes | ADR-004 把 server 定为独立协调权威，折叠后这一点不再成立；写「细化」会让帐本同时留下两条互斥的 Accepted |
| ADR-034 标 Supersedes ADR-002 vs 保持 ADR-002 | Supersedes | review §7 V6 判定 v1 冻结策略已失效、§8 D2 裁定切 v2；v1 仍冻结，被取代的是「新能力一律走 wire 外 HTTP」 |
| 九条全 Accepted vs 部分 Proposed | 全 Accepted | 九个议题在 review §6 / §8 / §12 / §13 均已裁定，无一项需要本刀新决策 |

## Open Questions

- `bun run check:version-authority` 属契约 exit criteria，但脚本随 WP1 落地，本分支跑不了；合入前需确认接受该缺口或等 WP1 合入后补跑。

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
