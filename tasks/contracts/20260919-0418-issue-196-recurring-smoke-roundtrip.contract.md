# Task Contract: issue-196-recurring-smoke-roundtrip

> **Status**: Complete
> **Plan**: plans/plan-20260919-0418-issue-196-recurring-smoke-roundtrip.md
> **Task Profile**: code-change
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-19 04:18
> **Review File**: `tasks/reviews/20260919-0418-issue-196-recurring-smoke-roundtrip.review.md`
> **Notes File**: `tasks/notes/20260919-0418-issue-196-recurring-smoke-roundtrip.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Issue #196（[P2][release-test]）：现有 recurring packed smoke 对 `readAgentMessageDisposition` / `readTaskAgentMessage` 只检查函数存在与不存在消息时的 undefined——一个对所有查询返回 undefined 的读回实现仍能通过。这是安装产物检查层的空洞性反例，不是宣称 SDK 恢复实现缺失。

## Goal

recurring packed smoke 从空值/导出检查扩展为真实消息决议与重启回读：隔离 npm tarball 安装中经支持的 authenticated inbound/message consumer 路径产生真实 admission，断言非空 payload、冻结 context、exact disposition、accepted + 非 accepted、finalize 失败后的同身份精确重放恢复、accepted 后 cancel 保留、跨身份不可借用；durable leg 在独立进程同一临时持久存储上重开 server/consumer，公开 API 回读且恢复不启动新模型 Execution。保留全部既有断言。

## Scope

- In scope：`scripts/release/recurring-smoke.mjs` 扩展（store-parameterized：in-memory leg + env-pair-gated durable leg）；`.github/workflows/ci.yml` dataplane job 新增一步（ubuntu，复用 `bun run check:release-pack` 驱动与 compose Postgres）；mutation check RED 证据到 `tasks/runs/`；输出 source SHA / artifact hashes / store/OS/runtime-fixture 信息；四件套 artifacts。
- Out of scope：`scripts/release/pack-and-smoke.mjs`（设计上无需改动：substrate env 经 `run()` 默认继承直达 smoke；若实现中发现 wiring 必须改动，先扩本契约再动手）；`packages/client/src/__tests__/**`（场景逻辑按 dispatch 偏好复制进 smoke，不抽公共 helper、不重构产品测试）；#178 umbrella namespace smoke；#195 ContextPack 链路；#180 reserved message MCP 授权；新增生产 Conversation store；自动 Execution 重试；付费模型调用；伪造 SDK 私有 receipt JSON。
- Taste constraints: 恢复场景从 source-truth 测试移植（agent-message-readback / completion-gate:288-340），不重写恢复实现；合成 fixture 通过不标成真实 provider 验收；no skip-produced success——substrate 不支持的 leg 结构性缺席，不 skip 计数。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- BLOCKED protocol（dispatch）：若 restart leg 结构性不可行（无公开 composition 将 Postgres stores 接入 kernel），停止并报告最小反例（file:line）+ 失败的契约句 + 最小诚实替代。注意：`createByokServer` storage 仅 memory/sqlite（packages/server/src/types.ts:29-39），公开 durable composition 是 `createByokCloud` + `createPostgresCloudStores`（dataplane conformance 同款）——这不是 BLOCKED 条件，是设计的一部分。

## Falsifier

把安装的 `@byok-sdk/cloud` 读回（readTaskAgentMessage / readAgentMessageDisposition）patch 成对非空消息返回 undefined → 扩展后的 installed smoke 必须失败（RED 证据留档）；保留的 namespace/strict-input/offer/cancel 断言继续成立；若 patch 后 smoke 仍绿 = FAIL。

## Issue #196 验收条件（逐字移植）

- [ ] 从实际安装的 tarballs 导入，经过支持的 authenticated inbound/message consumer 路径产生真实 admission；断言非空消息 payload、冻结 context 和 exact disposition，不能直接伪造 SDK 私有 receipt JSON。
- [ ] 覆盖 accepted 与至少一个非 accepted 结果；在 hosted/embedded 公共读回面获得一致结果。不能把 held/refused/pending 当作可展示的 accepted 正文。
- [ ] consumer 事务已提交、SDK finalize 或响应失败时，以同一身份恢复；精确重放保持原结果，Host 正文不重复物化。不要把“consumer 只调用一次”误写成通用跨事务契约。
- [ ] accepted 后 cancel 仍保留消息；cancel intent 不伪装成 device terminal；不同 task/device/AgentRef/message/body 不得借用原决定。
- [ ] 在同一临时持久存储上用独立进程重新打开 server/consumer，旧 TaskHandle 不存在时仍可用公开 API 回读；验证恢复不启动新的模型 Execution。
- [ ] 做一个局部 mutation check：将非空消息读回错误替换成 undefined，新增 installed smoke 必须失败；保留现有 namespace/strict-input/offer/cancel 断言。
- [ ] 输出精确 source SHA、artifact hashes、store/OS/runtime-fixture 信息。先复用已有 CI job 和构建产物，避免无依据复制全平台全排列；合成 fixture 通过不标成真实 provider 验收。

## Workflow Inventory

- Source plan: `plans/plan-20260919-0418-issue-196-recurring-smoke-roundtrip.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260919-0418-issue-196-recurring-smoke-roundtrip.review.md`
- Notes file: `tasks/notes/20260919-0418-issue-196-recurring-smoke-roundtrip.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"gatekeeper","source":"independent-gate","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - scripts/release/recurring-smoke.mjs
  - .github/workflows/ci.yml
  - plans/plan-20260919-0418-issue-196-recurring-smoke-roundtrip.md
  - tasks/contracts/20260919-0418-issue-196-recurring-smoke-roundtrip.contract.md
  - tasks/reviews/20260919-0418-issue-196-recurring-smoke-roundtrip.review.md
  - tasks/notes/20260919-0418-issue-196-recurring-smoke-roundtrip.notes.md
  - tasks/runs/
```
（ci.yml 仅限 dataplane job 段；pack-and-smoke.mjs 与 packages/client/src/__tests__/** 按 dispatch 为条件性路径，当前设计不需要，进入前必须先扩本契约）

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Delegation Contract

```yaml
delegation:
  budget:
    tokens: null
    runner_invocations: null
    wall_time_minutes: null
  permission_scope:
    mode: inherit_allowed_paths
    writable_paths: []
    network: inherited
  roles:
    parent:
      mode: narrate_and_gatekeep
      purpose: approval_checkpoint_owner
    explorer:
      mode: read_only
      purpose: codebase_research
    worker:
      mode: edit_within_allowed_paths
      purpose: implementation
    verifier:
      mode: read_only
      purpose: exit_criteria_review
  runner:
    preferred:
      - subagent
    fallback: null
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - plans/plan-20260919-0418-issue-196-recurring-smoke-roundtrip.md
    - tasks/runs/
  artifacts_exist:
    - tasks/notes/20260919-0418-issue-196-recurring-smoke-roundtrip.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {"id":"build","kind":"command","command":"bun run build","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"tree builds","inputs":{"env":[]}},
    {"id":"typecheck","kind":"command","command":"bun run typecheck","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"tree typechecks","inputs":{"env":[]}},
    {"id":"api-surface","kind":"command","command":"bun run check:api-surface","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"golden","inputs":{"env":[]}},
    {"id":"version-authority","kind":"command","command":"bun run check:version-authority","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"version authority","inputs":{"env":[]}},
    {"id":"smoke-in-memory-isolated-install","kind":"command","command":"node recurring-smoke.mjs","cwd":"/private/tmp/byok-196-isolated","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"extended in-memory leg green from installed tarballs (isolated install of the pack-and-smoke tarballs)","inputs":{"env":[]}},
    {"id":"smoke-durable-local-substrate","kind":"command","command":"BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 node recurring-smoke.mjs","cwd":"/private/tmp/byok-196-isolated","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"durable restart leg green against local docker compose Postgres+MinIO","inputs":{"env":["BYOK_TEST_POSTGRES_URL","BYOK_TEST_S3_ENDPOINT"]}},
    {"id":"mutation-check-red","kind":"command","command":"tasks/runs/20260919-0418-issue-196-mutation-check.red.log","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"patched read-back (undefined for non-empty) turns the installed smoke RED","inputs":{"env":[]}},
    {"id":"full-test-delta","kind":"command","command":"bun run test","cwd":".","phase":"verification","cost":"heavy","evidence_policy":"baseline_with_delta","necessity":"full suite; known darwin hasDisplay baseline pi-s2-bundle-resolution:327 red (fixed by PR #202, not this branch) — prove delta only","inputs":{"env":[]}},
    {"id":"ci-yaml-valid","kind":"command","command":"python3 -c \"import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))\"","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"YAML validity of ci.yml change","inputs":{"env":[]}},
    {"id":"task-workflow","kind":"command","command":"repo-harness run check-task-workflow --strict","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"workflow gate","inputs":{"env":[]}}
  ]
}
```

## Acceptance Notes (Human Review)

- 行为变化：release smoke 覆盖增强，零产品源码改动；`npm-release-pack` 3 OS legs 仍只跑 in-memory leg（substrate env 结构性缺席）。
- Durable leg 的 CI 证明面 = dataplane job 新 step（ubuntu + compose Postgres/MinIO + REQUIRE=1 fail-closed）；本地已用 docker compose 复现则双证，否则标注 CI-verified-only。
- 合成 consumer/fixture 通过不构成真实 provider 验收（issue 原话）。
- 行为 gate = push 后分支 CI 全绿。

## Rollback Point

- Commit / checkpoint: a6c5a297（origin/main；reset --hard 恢复）
- Revert strategy: revert 分支 commits；无数据/契约面
