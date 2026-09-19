# Notes: winsw-unlink-retry (20260919-0532)

## 根因（上游独立诊断确认，不重推）

CI job "Windows service install smoke" ~10s 处间歇性 `EPERM: unlink ...logs\byok-winsw-smoke-<pid>.exe`：

- `packages/client/src/lifecycle/winsw.ts:185` 在 `winsw uninstall` 返回后立即 `await fs.rm(exePath, { force: true })`，零等待/重试。
- Windows 在 SCM STOPPED/deregistration 之后异步释放 service 进程的 image section；unlink 抢在释放前 → `ERROR_ACCESS_DENIED` → libuv `EPERM` → 异常穿出 `uninstall()` 进 `templates/service/winsw/smoke-test.mjs:192` 的 try，作废一次本已 PASS 的 run。
- `force: true` 只压 ENOENT；node `fs.rm` 的 `maxRetries` 在无 `recursive: true` 时被忽略——不能依赖。

## 修复形态（最小、fail-closed）

- 模块本地 `rmWithImageLockRetry(fs, p)`： tolerated errnos = `{EPERM, EBUSY, ENOTEMPTY}`；上限 10 次尝试；每次重试间 flat 250ms（线性、非指数，总延迟 ≈2.25s 量级）；耗尽预算或不属于 tolerated 集合 → 原样 rethrow 最后一个错误。无 masking、无静默成功。
- `uninstall()` 两处 rm（exe + xml）都走该 helper；`{ force: true }` 形态不变（既有 :135-136 期望因此不需改动，仍钉住调用形态）。
- 不给 `WinswDeps` 加 `delay` 之类的注入点：`WinswDeps` 在 public golden（`api-surface/client.d.ts`）闭包内，加可选属性会牵动 api-surface gate；代价是 fail-closed 测试真实 sleep ≈2.25s，接受。
- 注释引用 CI 失败模式（windows-service-smoke + `byok-winsw-smoke-<pid>.exe` unlink EPERM），对齐该文件既有长注释 idiom。

## 测试面（host-agnostic，走既有 `deps.fs` mock seam）

1. RED：exe 路径前 K 次 rm 抛 `{code:'EPERM'}` 后成功 → `uninstall()` resolve，exe rm 恰 K+1 次（xml 1 次）。
2. fail-closed：exe 持久 EPERM → 预算耗尽（恰 10 次尝试）后仍 reject，`code:'EPERM'` 透传。
3. 非 image-lock 错误（`EACCES`）→ 首次即 rethrow，零重试（钉住 tolerated 集合，防过度宽容）。

RED-first 协议：先落测试（winsw.ts 不动）→ 跑 RED → 存 `tasks/runs/20260919-0532-winsw-unlink-red.log`（含 `PRE_FIX_EXIT=`）→ 再落修复 → 绿。

## 验证结论

- RED artifact（pre-fix，winsw.ts 未动）：`tasks/runs/20260919-0532-winsw-unlink-red.log` —— `Tests 2 failed | 22 passed (24)`，`PRE_FIX_EXIT=1`；两条新用例分别以 `Error: EPERM ... unlink`（trace 指到 `winsw.ts:185:14`，即根因行）与 `expected "vi.fn()" to be called 10 times, but got 1 times` 失败，与根因逐字吻合。EACCES 零重试伴生用例 pre-fix 即绿（预期内，方向不依赖修复）。
- 修复后同命令：`bun run --filter @byok-sdk/client test -- src/__tests__/lifecycle-winsw.test.ts` → `Tests 24 passed (24)`，Duration 2.94s（含 fail-closed 用例真实 ~2.3s backoff；未加 delay 注入点，见上）。
- `bun run build` ✓（Build success, exit 0）；`bun run typecheck` ✓（全包 Done）
- `bun run check:api-surface` ✓（`10 package golden(s) match`——`WinswDeps` 未动，golden 零变化）
- `bun run check:version-authority` ✓（byok-sdk@0.18.0 / @byok-sdk/keys@0.5.0）
- `bun run test` 全量：`Tests 1 failed | 2875 passed | 11 skipped (2887)`——唯一失败 = 已记录 darwin 基线 `pi-s2-bundle-resolution.test.ts`（:327 local registry tripwire，PR #202 已在别处修复，本分支不碰）；2875 = 基线 2872 + 新增 3 绿，零新增失败。
- `repo-harness run check-task-workflow --strict` ✓（补齐 plan 的 Promotion Gate / Evidence Contract / Task Breakdown 三节并把 Artifact Level 升为 work-package 后 `[workflow] OK`）
- 备注：`tasks/runs/*.log` 命中 `.gitignore` 全局 `*.log` 规则，按仓内既有 pre-fix log 先例（tasks/evidence/ 下 13 个 tracked log）`git add -f` 落盘。
