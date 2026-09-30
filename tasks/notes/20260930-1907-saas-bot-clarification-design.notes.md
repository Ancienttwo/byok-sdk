# Host clarification implementation notes

> **Status**: Checks passed; external acceptance pending
> **Plan**: plans/plan-20260930-1907-saas-bot-clarification-design.md
> **Contract**: tasks/contracts/20260930-1907-saas-bot-clarification-design.contract.md

## P1 / P2 / P3

P1：Host owns tickets/context/destination/auth; SDK owns exact Execution delivery/evidence。P2：terminal→strict parser→ticket + notify outbox→answer CAS + next exact reservation→fresh dispatch；失败/取消不推进。P3：采用已验收 A，SQLite 多连接事务而非运行中 ask；notification at-least-once，接收方必须去重。

## Scope

同步 main 186e210c；trace 文档仍记录 d61eaff4 源码。仅 contract 的十一文件。packages/API/server.ts/bun.lock 无 diff；无 pi-ask/provider/global tool 修改。复用已有 vitest.config credential env 和 mcpToolsets:true stub，未修改这两文件。

## Verification commands and actual exit codes

本机 env：BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun、BYOK_REQUIRE_BUN=1；root test 完整执行，未跳过要求 Bun 的 suites。

| command | exit | evidence |
|---|---|---|
| bun run build | 0 | /tmp/clarification-final-build.log (12.0s) |
| bun run typecheck | 0 | /tmp/clarification-final-typecheck.log (5.5s) |
| bun run test | 0 | /tmp/clarification-final-root-test.log (220.6s) |
| bun run check:api-surface | 0 | /tmp/clarification-final-api.log (0.2s) |
| bun run check:version-authority | 0 | /tmp/clarification-final-version.log (0.1s) |
| repo-harness run check-task-workflow --strict | 0 | /tmp/clarification-final-workflow.log (3.0s) |
| BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun BYOK_REQUIRE_BUN=1 bun run --cwd examples/basic test | 0 | /tmp/clarification-final-example.log：85/85（goal/btw31 + clarification54） |
| bun install --frozen-lockfile | 0 | 本 worktree；441 packages installed；lock unchanged |
| python3 /tmp/run-clarification-linux.py | 0 | /tmp/clarification-linux-test.log；52.9s；Linux uid1000、Node24.21.0、Bun1.4.2 |

Linux 原始 docker argv：

```sh
docker run --rm -i --name codex-clarification-linux-check --user 1000:1000   -e BYOK_TEST_DEVICE_CREDENTIAL_STORE=1 codex-clarification-linux sh -c '
set -eu
tar -xf -
id
node --version
bun --version
bun install --frozen-lockfile
bun run build
bun run --cwd examples/basic typecheck
bun run --cwd examples/basic test
' < /tmp/clarification-linux-source.tar
```

快照仅 tracked 与本任务 untracked 文件，不包含 node_modules/dist/.git/.codegraph/_ops；容器自己的干净依赖+build。base node:24-bookworm-slim；Linux Bun 来自 npm @oven/bun-linux-aarch64@1.4.2 tarball，sha512 integrity 验证后 COPY。所有命令 set -eu，整体 exit0 说明 frozen install/build/typecheck/example 都 exit0，example85/85。

## Failure attribution

首次 typecheck 在公开包 dist 尚未构建时 exit1，build 后通过。新增负控曾误判 missing extractor 在提交阶段拒绝；实际 offer 后、adapter start 前 decline，真实回读后修正断言。缺 Agent home/egress capability 在提交门拒绝。首次 Docker npm bun wrapper 安装 ARM64 包失败 ENOENT；直接下载同版 Linux binary 并 integrity 核验后成功，没有改仓库依赖或共享容器。

## Coverage and limits

54 clarification tests：single_choice/text；完整 binding 旧 generation/回放；多 SQLite connection CAS；notify retry/restart/concurrent answer；initial/continuation reserve restart；synchronous dispatch rejection/ACK loss；sending cancellation两窗口；late terminal/open ticket cancel；fake-clock TTL/cap/keyset；targeted deadline；failed/cancelled/declined/home busy；预算；strict parser/extractor、capability与egress拒绝。

§9.6 prepared capture 未做，native/provider 未证。complete 仅结构化模型 verdict；Host 必须验证业务完成/权限。Notification sink durable dedup 是集成条件，不保证任意远端渠道 exactly once。SQLite仅单机，execution ID retention 未实现，所有 expiry/cancel恢复依赖 Host tick/recovery。

## Acceptance

Claude 已验收设计；实施独立 /tmp 复跑及正式 receipt 尚待。不要手写 projection，不 push/PR。若 architecture gate / contract_not_committed，按用户指示停报。

## Architecture gate remediation authorization

预存 architecture gate，用户授权处理；缺本地 CodeGraph 索引导致 verified-flow-proof-changed/proof 退化，恢复索引后 flowProofDigest=c105ee1286780504c1041f4587ff6c06a1d292ff18d33aa3359e656950ce1214。与 clarification 代码无关，可独立 revert。manifest provenance 是本地索引证据：branch codex/clarification-design，base commit 402a5f5a；本次元数据在 plan/apply 时尚未提交，不代表一个已提交的完整状态。仅更新 manifest，不改 sdk-root/model/flow/P3。
监工审过仅 manifest 的67行预览，明确 OK apply；无其他架构发现处理授权。
