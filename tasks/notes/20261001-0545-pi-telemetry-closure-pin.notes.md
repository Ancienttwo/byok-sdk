# Pi closure pin investigation / blocked state

> **Plan**: plans/plan-20261001-0545-pi-telemetry-closure-pin.md
> **Contract**: tasks/contracts/20261001-0545-pi-telemetry-closure-pin.contract.md
> **Status**: Blocked pending release-graph policy decision

## P1 / P2 / P3

P1：published client manifest vs root Bun overrides/lock；closure JSON是精确Pi identity权威。八包为chord/agent-core/ai/codemode/coding-agent/mcp/telemetry/tui，均0.99.1。registry npm view八latest均0.99.2。
P2：现有client三direct exact→bun pack→isolated npm install（consumer无root overrides）→pi-launcher-smoke→official-pi-installation identity mismatch。telemetry经ai/agent-core的^0.99.1漂移；coding-agent的chord/codemode/mcp/tui同样是caret。
P3：监工已OK五direct exact pins，但release-graph已有更严格边界：chord必须保持transitive，tui不能作为带native addon的硬依赖。因此方案在本仓门禁下不充分；不改变guard来变绿。

## Exact scope and conflict

main708ed45b，独立codex/pin-pi-telemetry。PR243 OPEN且不改client/package.json或bun.lock，无这两文件冲突；旧worktree不写。
client manifest only +5 exact0.99.1；bun.lock only client workspace +5，resolved Pi版本/其他workspace/closure/byok.piRuntimePin/rootpackage/API/wire无修改。未commit/push/PR。

## Commands / actual outcomes

| command | exit | evidence |
|---|---|---|
| git pull --ff-only origin main | 0 | main already current708ed45b，clean before pull |
| bun install --frozen-lockfile (baseline) | 0 | /tmp/pi-telemetry-baseline-install.log |
| bun run build (baseline) | 0 | /tmp/pi-telemetry-baseline-build.log |
| node scripts/release/pack-and-smoke.mjs --out-dir /tmp/pi-telemetry-baseline-tarballs | 1 | /tmp/pi-telemetry-baseline-pack.log：official Pi identity mismatch telemetry，原脚本未修改 |
| bun install (approved pins) | 0 | /tmp/pi-telemetry-pin-install.log：lock only five workspace entries |
| bun install --frozen-lockfile (after pins) | 0 | /tmp/pi-telemetry-pin-frozen.log |
| bun run check:release-graph | 1 | /tmp/pi-telemetry-pin-graph.log：two policy failures below |

Baseline tarballs retained /tmp/pi-telemetry-baseline-archive；original client tgz sha256=4b49c56a55b855f68aae9a44f63ade5caa7233fda932892954bd39aa898f4218，packed Pi direct deps只有coding-agent/ai/agent-core三包。后续红绿应使用同一原pack命令；当前after pack未跑，绝不写已变绿。

## Blocking failures

1. `@earendil-works/chord is not a direct client dependency; it must reach the install only through @earendil-works/pi-coding-agent, got a direct 0.99.1`。
2. `direct dependency @earendil-works/pi-tui ships a native addon (native/win32/prebuilds/win32-x64/win32-platform.node)`。

Direct purity audit入口 scripts/release/check-package-graph.mjs:413-420；optional也不是绕过native约束（:48-64）。按监工要求，只要需要改脚本/测试就停报：没有改script/test、没有擅自撤销五pins或扩大shrinkwrap/bundling。

## Not run / next decision

修后build/typecheck/root test/API/version/workflow、closure tests、修后pack、architecture/receipt都未跑，未报PASS。等待监工/用户裁定直接依赖约束与完整published closure的冲突，不继续更改实现。

npm overrides root-only依据：https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides 。依赖自身overrides不起效，因此加client overrides不能修消费者隔离安装。
