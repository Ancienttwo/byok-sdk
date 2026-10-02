# Clarification prepared offline capture notes

> **Plan**: plans/plan-20261001-0251-clarification-prepared-capture.md
> **Contract**: tasks/contracts/20261001-0251-clarification-prepared-capture.contract.md

## P1/P2/P3

真实service/native compiler/durable artifacts/receipts→两个source/message→真实Pi prepared adapter/host/native session→loopback首请求capture。采用直接native boundary probe隔离D，不伪造counter production authority/ready。counter=test_fixture，两receipt.ready=false；production admission/provider计数未证。

## Authorization / scope

base708ed45b，codex/clarification-prepared-capture，仅两个获准新增packages测试资产与五文档。无现有test/fixture、生产源、API/wire/Pi/package/lock/examples改动；无真实provider/plugin。clientvitest已有credential flag；真实Pi支持mcpToolsets，无新stub daemon。

## Commands / actual exit codes

本机root/focused env：BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun BYOK_REQUIRE_BUN=1。

| command | exit | evidence |
|---|---|---|
| bun run build | 0 | /tmp/prepared-capture-final-build.log (12.1s) |
| bun run typecheck | 0 | /tmp/prepared-capture-final-typecheck.log (5.5s) |
| bun run test | 0 | /tmp/prepared-capture-final-root-test.log (206.6s) |
| bun run check:api-surface | 0 | /tmp/prepared-capture-final-api.log (0.2s) |
| bun run check:version-authority | 0 | /tmp/prepared-capture-final-version.log (0.1s) |
| repo-harness run check-task-workflow --strict | 0 | /tmp/prepared-capture-final-workflow.log (2.4s) |
| bun run --cwd packages/client test src/__tests__/clarification-prepared-capture.test.ts | 0 | /tmp/prepared-capture-focused.log；2/2，6.23s |
| bun install --frozen-lockfile | 0 | /tmp/prepared-capture-install.log；lock unchanged |
| python3 /tmp/run-prepared-capture-linux.py | 0 | /tmp/prepared-capture-linux-test.log；57.2s，UID1000 Node24.21 Bun1.4.2，2/2 |

Linux原始argv：

```sh
docker run --rm -i --name codex-prepared-capture-linux --user 1000:1000   -e BYOK_TEST_DEVICE_CREDENTIAL_STORE=1 codex-clarification-linux sh -c '
set -eu
tar -xf -
id
node --version
bun --version
bun install --frozen-lockfile
bun run build
bun run --cwd packages/client typecheck
BYOK_TEST_BUN_BIN=/usr/local/bin/bun BYOK_REQUIRE_BUN=1 bun run --cwd packages/client test src/__tests__/clarification-prepared-capture.test.ts
' < /tmp/prepared-capture-linux-source.tar
```

快照仅tracked+本任务新文件，无node_modules/dist/.git/CodeGraph/_ops。容器自己frozen install/build；全部set-e，整体exit0。source locator脚本exit0。commit前whitespace与workflow按真实结果回报。

## Negative control attribution

最初负控只toThrow，通过后收紧为预设prepared_expectation_mismatch时exit1：真实拒绝更早发生在artifact record归属校验（pi-adapter.ts735）。改为匹配真实精确原因后2/2通过；生产代码零改。

## Risks / acceptance

只证明新source/receipt/D关联、direct native首请求一致性和混合record拒绝。未证明生产ready/pin/claim、真实provider计数/计费、真实Host answer endpoint、same Agent home全链/retention/restart。fixture source authority不提供生产认证。外部Claude /tmp独立验收pending；不自签receipt，不push/PR。若architecture/daemon gate，按brief停报，不处理。

## Architecture authorization

预存 architecture gate，用户授权本切片处理；缺本地 CodeGraph 索引导致 verified-flow-proof-changed / proof 退化，恢复索引后 flowProofDigest=c105ee1286780504c1041f4587ff6c06a1d292ff18d33aa3359e656950ce1214。架构元数据变更与 prepared-capture 测试无关，可独立 revert。manifest provenance 是本地索引证据：branch codex/clarification-prepared-capture，base commit c146d18a；plan/apply 时尚未提交本轮元数据，不代表已提交完整状态。仅更新 manifest，不改 sdk-root/model/flow/P3。
监工只读审过预览并明确 OK apply，仅该 manifest。
