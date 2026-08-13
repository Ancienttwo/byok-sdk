> **Archived**: 2026-08-13 19:42
> **Related Plan**: plans/archive/plan-20260813-1925-control-socket-fallback.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260813-1942

# Implementation Notes: control-socket-fallback

> **Status**: Active
> **Plan**: plans/plan-20260813-1925-control-socket-fallback.md
> **Contract**: tasks/contracts/20260813-1925-control-socket-fallback.contract.md
> **Review**: tasks/reviews/20260813-1925-control-socket-fallback.review.md
> **Last Updated**: 2026-08-13 19:35
> **Lifecycle**: notes

## Design Decisions

- 缺陷（O-1 已实证，与 PR #64 修掉的 store-mutex 同一机制）：`controlSocketPath`
  的长路径 fallback 走 `os.tmpdir()`，产生两条独立故障。(a) 可达性——`os.tmpdir()`
  读 `TMPDIR`，调用方可能把 `TMPDIR` 指进正是让 `<storeDir>/control.sock` 超长的那棵
  树里（`scripts/adapter-task-smoke.mjs` 在深 TMPDIR 下就是这个拓扑），fallback 比被逃逸
  的地址更长，`bind()` 返回 `EINVAL`，daemon 走 degrade 分支继续跑，CLI 控制面静默死掉。
  本次在未修代码上直接复现到那一行：
  `[byok/client] control socket failed to start (continuing without it): listen EINVAL: invalid argument /tmp/byok-smoke-deep-tmpdir-topology/aaaaaaaaaa/bbbbbbbbbb/cccccccccccccccccc/byok-adapter-task-smoke-mlVxxY/tmp/byok-90d4455af034f560/sock`
  （139 字节，远超 100 的 `sun_path` 预算）。(b) 正确性——环境派生的地址不是一个地址：
  service manager 下的 daemon 与 operator shell 里的 CLI 看到不同 `TMPDIR`，对同一个
  store 派生出不同 socket，CLI 根本连不上活着的 daemon。
- 修复：fallback 根改成固定字面量 `CONTROL_SOCKET_FALLBACK_ROOT = '/tmp'`
  （`packages/client/src/daemon/control-protocol.ts:56`），派生只由 `storeDir` 决定。
  POSIX 保证存在、与环境无关、短到这条候选永远落在预算内。正常路径
  `<storeDir>/control.sock` 逐字节不变；win32 named pipe 分支零改动；
  `control-server.ts` 的 degrade 语义零改动。`os` import 随之成为死引用，已删。
- 不与 `daemon-owner.ts` 抽公共 helper：两处派生并不逐字节同构——命名不同
  （`byok-<sha256(storeDir)[0:16]>` vs `byok-store-mutex-<identity[0:16]>`）、
  identity 的来源不同（control 侧现算 hash，mutex 侧由调用方传入并复用为握手身份）、
  目录保护的实现路径也不同（见下）。为一次巧合的形状相同造抽象会把两个不同契约焊在一起。
  两边各自留常量与文档，互相点名引用。
- 守卫测试 `packages/client/src/__tests__/control-socket-fallback.test.ts` 用
  `daemon-owner-mutex-collision.test.ts` 的 E/F 同型：E 在深 TMPDIR + 超长 storeDir 下
  既断言字节预算，又真的把 control server 起起来并让 `connectControlClient` 完成握手 +
  `ping` 往返（只断言"可 bind"证明不了 CLI 可达）；F 断言同一 storeDir 的地址在两个不同
  `TMPDIR` 下逐字节相同；第三条钉死短 storeDir 路径的字节不变性。win32 与既有两个测试
  一样直接 early-return。
- `control-protocol.test.ts` 里那条 fallback 用例的标题原文写着 "tmpdir path"，断言本身
  仍然成立（确定性、≤104 字节、`byok-<16hex>/sock` 一级私有目录），只把标题里已经变假的
  措辞改成 "fixed-root"。

## Deviations From Plan Or Spec

- `control-server.ts` 未改动：派生变更不需要它配合，stale-socket 清理、0700 目录创建、
  `assertOwnedPrivateDir`、bind 失败 degrade 全部原样保留。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| 固定 `/tmp` 根 | 采用 | 环境无关 + 永远在 `sun_path` 预算内，与 PR #64 已验证的 mutex 修复同形 |
| 与 `daemon-owner.ts` 共用一个 fallback helper | 否决 | 两处派生在命名、identity 来源、目录保护实现上都不同；共享会把两个契约焊死（契约 taste constraint 也明确禁止非逐字节同构时共享） |
| 保留 `os.tmpdir()` 并加长度检查后二次回退 | 否决 | 多地址探测正是纪律禁止的兼容回退，且不解决 (b) 环境漂移 |
| 把 degrade 改成 fail-closed | 否决 | 超出本刀范围；contract 明确 out of scope，control socket 不该 brick 掉 daemon |

## Open Questions

- 属主校验的不对称（记录，不在本刀处理）：`control-server.ts` 的
  `assertOwnedPrivateDir` 只做 `lstat` 的 symlink + uid 判断，目录创建走
  `fs.mkdir(mode 0o700)` + 尽力 `chmod`；`daemon-owner.ts` 走的是
  `ensureSecureDir`（在 win32 上还会打 DACL）再叠同名校验。两边的安全断言等价，
  但目录创建路径不同一。fallback 根从 `os.tmpdir()` 变成 world-writable 的 `/tmp` 之后
  这条路径的重要性没有下降，只是没有变化——本次未扩大语义。
- `control-server.ts:132` 的文档注释仍写 `os.tmpdir()` 指代 fallback 根（现在是 `/tmp`）。
  措辞已过期但结论未变（仍是共享的、world-writable 的根），未改以守住写入范围。

## Evidence Links

- Pre-fix RED artifact（含 regression_guard 路径串与 `PRE_FIX_EXIT=1`）:
  `/private/tmp/claude-501/-Users-kito-Projects-byok-sdk/1e383a1a-c63e-4756-be40-ce6e415edc85/scratchpad/control-fallback-red.txt`
  — E 断言 `expected 143 to be less than or equal to 100`，F 断言派生地址随 `TMPDIR` 漂移。
- 深 TMPDIR smoke（77 字节 TMPDIR，`TMPDIR=/tmp/byok-smoke-deep-tmpdir-topology/aaaaaaaaaa/bbbbbbbbbb/cccccccccccccccccc node scripts/adapter-task-smoke.mjs`，cwd `packages/client`）：
  - before（stash 掉修复后重建 dist）：`scratchpad/smoke-before.txt`，退出 0 但第 2 行是
    `control socket failed to start (continuing without it): listen EINVAL`。
  - after：`scratchpad/smoke-after.txt`，退出 0，全文无 `control socket` 行，三个 adapter 全 PASS。
- `pnpm --filter @byok-sdk/client run test` → 111 files / 1167 tests passed。
- `pnpm -r run typecheck` → 全包通过。
- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- 候选（第二次出现即可提升到 `tasks/lessons.md`）："任何进程间约定的地址不得从
  `os.tmpdir()` 等环境变量派生" —— 同一机制已在 store mutex（PR #64）与 control socket
  两处独立咬人，第三处若再出现应提升为 lesson 并做一次全仓 `os.tmpdir()` 扫描。
