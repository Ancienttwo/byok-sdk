# Implementation Notes: wp3-charge-once-wiring

> **Status**: Implemented
> **Plan**: plans/plan-20260917-1628-wp3-charge-once-wiring.md
> **Contract**: tasks/contracts/20260917-1628-wp3-charge-once-wiring.contract.md
> **Review**: tasks/reviews/20260917-1628-wp3-charge-once-wiring.review.md
> **Last Updated**: 2026-09-17 17:40
> **Lifecycle**: notes

## 三个实施确认点（开工第一步，现场核实）

- **① assertDescendantSpawn 复验字段**（`packages/implementation-identity/src/identity.ts:1730-1747` → `descendant-launch.ts` `validateDescendantSpawn`）：以函数体为准，fixedArgv **既作 launch record 键也作 exec payload 逐位比对**——`actual.command/entry/cwd/fixedArgv` 必须与 record template 全等（`descendant-launch.ts` 末段 `descendant_invocation_mismatch`），且 `parseImplementationSpawnBinding` 要求 attested identity 的 `launchArgv === binding.fixedArgv`、`launchCwd === binding.cwd`、`command === installPath`（compiled-executable 形态无 entry）。另有：exactNames digest == actual.env 键集（lifecycle/credential 名投影后）、envValues 逐名 == actual.env 值、`PI_SUBAGENT_DEPTH/PI_SUBAGENT_MAX_DEPTH` 投影必须等于 `perLaunch.depth`/`effectiveLimits.maxDepth`、bootstrap（runner→print）边 depth=parent+0 且 instancePath 不变、session.root 必须等于 `envCommitments.PI_CODING_AGENT_SESSION_DIR`（⇒ envCommitments 不能为空）、物理复验走真实 fs probe（canonical path + stat tuple + closure digest）。据此 expectation 建模：exec argv = template.fixedArgv（parent 铸造、以 templateKind 结尾），exec env = exactNames 精确投影。
- **② getPiSpawnCommand 消费形态**（vendored `pi-subagents/0.60.0/src/runs/shared/pi-spawn.ts:139-163`）：`PI_SUBAGENT_PI_BINARY` 非空 trim 后**作为单命令串直接 spawn**（`return { command: piBinary, args }`，无 node/bun 前缀、无 shell）⇒ 入口必须是可直接执行文件（shebang + exec bit，POSIX）。win32 无法通过 `child_process.spawn` 直接跑脚本文件 ⇒ 本切片三条 spawn 驱动用例显式 `it.skip`（win32）+ 原因注明，Windows 覆盖登记 todos（不弱化：dispatcher 与 entry 模块单测仍跨平台跑）。
- **③ vendor 前台 spawn env 穿透**（vendored `pi-subagents/0.60.0/src/runs/foreground/execution.ts:558`）：`const spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(...) }`——**全量展开 process.env，只覆写 `PI_SUBAGENT_DEPTH`/`PI_SUBAGENT_MAX_DEPTH` 两个键**（`getSubagentDepthEnv`，vendor `src/shared/types.ts:2712-2719`）；`sharedEnv` 是 buildPiArgs 的增量 env 非白名单重建 ⇒ `BYOK_SDK_CUSTODY_PARENT_DEPTH` 与 launch record 路径可穿透。**未触发 BLOCKED 条件**。RED 转绿即运行时证明。

## Design Decisions

- 深度权威唯一 = SDK 冻结表。入口只读 `BYOK_SDK_CUSTODY_PARENT_DEPTH`（runner 契约深度），re-stamp `print = parent + 0`（bootstrap 边），vendor 自算深度整体丢弃（连 `PI_SUBAGENT_MAX_DEPTH` 也以 record 声明的契约值 3 覆盖 vendor 的 8，测试有断言钉住）。
- 每刀 launch record（`byok.descendant-launch` 全量 JSON，含 attested identity + policy + perLaunch）由 parent（本切片 = 测试侧的 runner env 构造点）写入文件，经新承诺键 `BYOK_SDK_CUSTODY_LAUNCH_RECORD`（绝对路径）传给入口。**该键是机制必要传输**（validateDescendantSpawn 需要 launch+expected 两输入，dispatch 文本未点名传输方式），与父深度键同属"SDK 自铸进 gated child env"语义；两键的枚举注册被 allowed_paths 挡住，见 Deviations #3 与 todos 第二行。
- `launchAttestedPiSubagentPrint` = 唯一 attested exec 点（validate → assert 真实 fs 复验 → spawn exactNames 精确 env + template fixedArgv/cwd，stdio inherit，退出码透传）。env-seam 预置入口与 helper host dispatcher print 分支都汇入它；无第二 scheduler。
- CLI 自执行守卫必须用 `import.meta.main`：argv[1]/import.meta.url realpath 比对在模块被打进宿主 bundle 后失效（bundler 把 `import.meta.url` 改写成 bundle 自身路径，`pi-s2-bundle-resolution.test.ts` 首轮实测抓到：守卫在 S2 release bundle 内误触发）。bun 对 shebang 直执行置 `main=true`，对静态导入、bundle 内非入口模块、vitest 导入均 `false`。
- probe 输出路径走 exec argv（`-p` 后一参）：exactNames ⊆ policy.envNameAllowlist ⊆ M0 词表，测试自定义 env 名进不了词表；fixedArgv 末位是 record 冻结惯例 `templateKind`（`parseDescendantLaunch` 的 `fixedArgv.at(-1) === templateKind`）。

## Deviations From Plan Or Spec

1. `launchAttestedPiSubagentPrint` 落在 `packages/client/src/custody/pi-subagent-print-entry.ts`（dispatch 文本写"helper host 增"）。原因：sdk-reserved-helper-host 是公共 API 面成员（`api-surface/client.d.ts:9622/11887-11913`），任何新导出都会改 golden，而 `api-surface/client.d.ts` 与 `tool-implementation-identity.test.ts` 均不在 allowed_paths；custody/ 新模块不可从 exports 闭包到达，golden 字节不变（`bun run check:api-surface` 绿为证）。host 通过值导入路由 print 分支（不产生 .d.ts 类型泄漏）。"单一 exec 点"机制不变。
2. 新增第二个承诺键 `BYOK_SDK_CUSTODY_LAUNCH_RECORD`（dispatch 文本只点名父深度键）：launch record 传输的必要通道，fail-closed 解析（缺失/非绝对路径/坏 JSON 即拒），与父深度键同等待遇。
3. **Step 4 的 BYOK_* 枚举注册未执行（PARTIAL 的唯一缺口）**：`packages/implementation-identity/src/identity.ts:663` `TOOL_IMPLEMENTATION_LIFECYCLE_NAMES` 定位无误，但注册任何新键都会打红 `packages/client/src/__tests__/tool-implementation-identity.test.ts:810-814` 的行为 pin（精确枚举数组全部成员），该测试文件不在 allowed_paths（硬边界）。运行时本切片无 attested spawn 边界消费这两键（exec env 由入口精确构造、零 BYOK_*，测试断言钉住）。已登记 todos 第二行，WP4 首刀同枚举+同 pin 更新一并做。
4. 既有 pin 更新按裁定 4 执行：`sdk-reserved-helper-host.test.ts` 原 it.each 两 kind 断 pending → runner 保持 pending 原文，print 改钉"路由到 attested exec 点且无承诺即拒"（行为 pin 更新，非弱化）。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| exec 点放 host 文件导出 vs custody 模块 | custody 模块 | api-surface golden 字节冻结 + allowed_paths 硬边界；机制不受影响 |
| launch record 走 env JSON 内联 vs 文件路径 | 文件路径键 | record 含 identity/digest 约 10KB；路径键 fail-closed 校验更简 |
| argv 模板门全量逐位 vs 前缀逐位 | 前缀 ['--mode','json','-p'] 逐位 + 全参良构校验 | vendor argv 尾部含每机不同的 mkdtemp/session/prompt 绝对路径，全量钉住会在每台机器误拒 |
| exec env 转发 vendor env vs exactNames 精确投影 | 精确投影 | exactNames digest 全等检查本来就要求精确；同时天然剥离 BYOK_*/PI_SUBAGENT_PI_BINARY，叶子不可递归走 seam |

## Open Questions

- None.

## Evidence Links

- RED（修前）: `tasks/notes/20260917-1545-wp3-charge-once-red.red-run.txt`（exit 1, :200 Expected "1" Received "2"）
- GREEN（修后, 2026-09-17）: `bun test packages/client/src/__tests__/custody-charge-once-double-charge.test.ts` → `4 pass / 0 fail / 17 expect()`（主链 10 断言含链健康 + MAX_DEPTH=3 投影 + BYOK_*/seam 零泄漏 + :200 depth==='1'；负路径：父深度缺失拒、argv mismatch 拒、runner 分支 pending）
- `bun run --filter @byok-sdk/implementation-identity test` → 110 passed（包零改动）
- `bun run --filter @byok-sdk/client test` → 2805 passed / 1 failed = 既有 S2 tripwire 红（`pi-s2-bundle-resolution.test.ts:327` clipboard12+jiti12，与基线 7357ebb4 逐字节同签名，契约豁免口径 7ae976ad）；首轮全量曾出现**新红**（bundle 内守卫误触发），已修（import.meta.main 守卫）并复跑确认回到豁免签名
- `bun run typecheck` → exit 0（16 包）；`bun run check:api-surface` → 10 goldens match；`bun run check:version-authority` → pass
- `git diff --stat daf46c47..HEAD -- packages/client/vendor/ packages/client/node_modules/` → 空
- `assertDescendantSpawn(` 产品调用者 grep → 1（`packages/client/src/custody/pi-subagent-print-entry.ts:236`）
- `repo-harness run check-task-workflow --strict` → `[workflow] OK`（2026-09-17）
- Checks: `.ai/harness/checks/latest.json`; Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- 「模块被打进宿主 bundle 后 `import.meta.url` 折叠为 bundle 自身路径，CLI 守卫必须用 `import.meta.main`」：满足难逆（产品守卫写法）、意外性高（首轮全量才暴露）、真实权衡（argv 比对 vs main 标志），建议下次触碰 CLI 模块时晋升 lessons。
