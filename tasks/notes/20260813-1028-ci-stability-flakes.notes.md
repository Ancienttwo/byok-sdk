# Implementation Notes: ci-stability-flakes

> **Status**: Active
> **Plan**: plans/plan-20260813-1028-ci-stability-flakes.md
> **Contract**: tasks/contracts/20260813-1028-ci-stability-flakes.contract.md
> **Review**: tasks/reviews/20260813-1028-ci-stability-flakes.review.md
> **Last Updated**: 2026-08-13 10:31
> **Lifecycle**: notes

## Design Decisions

- mutex 机制由共享 TCP 端口命名空间改为 store-scoped lock（POSIX UDS in-storeDir + sun_path 超限 tmpdir fallback；win32 named pipe），复用 `control-server.ts` 先例；`uncertain` 分类整体不可达化，fail-closed 不变量以守卫 B 机检。详见下方两个 root-cause 小节。
- vitest 端口注入 seam 全套同刀删除（no-steady-state-compatibility）：它只为躲避已消除的碰撞而存在，且自身有缺陷（0-based worker id 映射、per-file seq 重置）。
- 非 `unbound` 的 probe 结果统一抛 `DaemonOwnerActiveError('unknown')`，不引入新错误类型——区分类型会把 CPU 饥饿下的 identity 写迟到重新变成按错误类型断言的 flake 类。

## Deviations From Plan Or Spec

- 原计划两个修复方向均被 evidence 推翻并经 contract amendment 改道：MinIO「teardown 有界重试」→ ci.yml setup-bun 版本 pin（根因在 CI 配置，escape hatch 触发）；mutex「端口随机化/重试」→ store-scoped lock（根因是第三方监听者占共享命名空间，非并发饥饿）。
- mutex 修复由 deep-worker 执行（原计划 fast-worker）：跨态并发 + 安全权威路径，需一次落对。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| uncertain→继续候选行走 | 拒绝 | 重开 stale-owner/reclaim TOCTOU，contract 明令禁止 |
| holder 端口发布到 store 记录（保留 TCP mutex） | 拒绝 | 机械更多且残留碰撞面；store-scoped lock 结构性消除 |
| link() 独占发布替代 unlink-then-bind | 拒绝（记为已知残余） | 改变已批准机制；残余窗口由 owner-file/reclaim 两层独占 link 兜住（gatekeeper O1） |
| 测试 support 层 503 重试 | 作废 | 根因不在 MinIO 路径上，重试是无效修补（上游 tool-cache 已 3 次重试且已败） |
| 拆 workflow job 隔离 bun 步骤 | 未做 | 超最小改动，记为候选（见 Promotion Candidates 下方） |

## Open Questions

- win32 named pipe 分支仅编译级+守卫早退验证，真实证据靠 CI 的 windows ipc-smoke job（gatekeeper O2）。
- PR #61 原始动机证据已滚出日志窗口，undici→MinIO 第二失败模式是否真实存在标记 unverified（#61 本身无害保留）。

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.

## MinIO-503 misattribution — actual root cause + fix

The "cloud-postgres dataplane MinIO teardown 503" flake was misattributed. The 503 never came
from MinIO: it came from the `Setup bun` steps downloading bun itself.

### Root Cause Evidence

- root_cause: `.github/workflows/ci.yml:159` and `:287` used `oven-sh/setup-bun@v2` with no
  `with: bun-version:`, so the action resolved "latest" on every run, missed the runner tool
  cache unconditionally, and re-fetched `bun-linux-x64.zip` from the GitHub release CDN;
  `@actions/tool-cache` (`tool-cache.ts:19`) retries the download 3 times, and three consecutive
  CDN 503/connection resets fail the job with `Unexpected HTTP response: 503` / `socket hang up`
  after the test steps have already gone green.
- repro: `oven-sh/setup-bun@v2` without `bun-version` on any GitHub-hosted runner — every run
  performs a fresh CDN download, so the failure reproduces whenever the release CDN degrades.
  Observed in jobs 94208317693, 94247380112 and 94236390428; job 94236390428 is the packageability
  leg, which starts no MinIO at all — the negative control that falsifies the teardown theory.
- regression_guard: `packages/cloud-postgres/src/__tests__/constraints.test.ts` — new case
  `the CI bun toolchain > pins bun-version on every setup-bun step`.
- pre_fix_failure_artifact:
  `/private/tmp/claude-501/-Users-kito-Projects-byok-sdk/1e383a1a-c63e-4756-be40-ce6e415edc85/scratchpad/rcp-minio/guard-red.txt`
  (`PRE_FIX_EXIT=1`); supporting capture in the same directory,
  `.../scratchpad/rcp-minio/pre-fix-failure-artifact.txt`.

### Fix

Pinned `bun-version: 1.3.14` on both `oven-sh/setup-bun@v2` steps in `.github/workflows/ci.yml`
(migration-ordering check, previously line 159; packaging `bun` recipe, previously line 287), each
with a one-line comment naming the CDN re-download as the flake source. No job restructuring. The
repo declares no bun version anywhere (`.bun-version` absent, `engines` covers node only,
`packageManager` is pnpm), so 1.3.14 — the version the failing logs were downloading — becomes the
declaration, asserted by the guard rather than duplicated.

### Residual exposure

A pinned version is served from the runner tool cache when present, but a cold runner with an empty
cache still performs one download. Exposure drops from every-run to cache-miss-only; it is not zero.

## daemon-owner mutex — root cause + store-scoped lock fix

### Root Cause Evidence

- root_cause: `packages/client/src/daemon/daemon-owner.ts:307-344` (`acquireStoreMutex`) keyed the
  cross-process store mutex on the SHARED loopback TCP port namespace — `storeMutexPort` hashed the
  canonical storeDir into the 10000..29999 band. Ordinary third-party software already listening on
  the derived port (accept-then-stay-silent servers) makes `probeStoreMutex` hit its 1s timeout →
  `kind:'uncertain'` → `DaemonOwnerActiveError` thrown at `:324` on candidate 0, with no walk. The
  band is not this SDK's namespace to reserve, and the derivation is deterministic, so the affected
  store stays locked out for as long as the squatter runs.
- repro: `scratchpad/rcp-mutex/run-collision.mjs` + `holder.mjs`/`contender.mjs` (two-process
  structural proof, `03-collision-proof.json`); live attribution of ten real listeners on this
  machine in `13-external-listener-classification.txt` (WeChat 14013/14016/14019/14022/14023,
  cloudflared 20241, VS Code helpers 17483/25702/29349, `ssh -L` 18790 — all ten classify as
  `uncertain`); suite-level occurrence in `04-client-suite-instrumented.log` and
  `12-port14019-timeline.txt`.
- regression_guard: `packages/client/src/__tests__/daemon-owner-mutex-collision.test.ts`
- pre_fix_failure_artifact:
  `/private/tmp/claude-501/-Users-kito-Projects-byok-sdk/1e383a1a-c63e-4756-be40-ce6e415edc85/scratchpad/rcp-mutex/pre-fix-failure-artifact-final.txt`
  (`PRE_FIX_EXIT=1`, failing at `src/daemon/daemon-owner.ts:324`).

### Fix

The mutex address moved from a shared namespace to a store-scoped one, reusing the split
`control-server.ts`/`control-protocol.ts` already establish for the control endpoint:

- POSIX: a Unix domain socket at `<canonicalStoreDir>/mutex.sock`, falling back — when that path
  would risk the 100-byte `sun_path` budget — to `os.tmpdir()/byok-store-mutex-<hash16>/sock`, a
  per-store private directory created 0700 before anything binds inside it and checked for
  symlink/foreign-uid ownership (`control-server.ts`'s `assertOwnedPrivateDir` rationale).
- win32: a named pipe `\\.\pipe\byok-store-mutex-<hash16>`, keyed by the storeDir hash alone —
  the store is the resource, so aliases and two products sharing one store must contend.
- The acquire/probe protocol shape is unchanged: the holder still writes
  `STORE_MUTEX_ID_PREFIX + sha256(canonicalStoreDir)` on accept, and a contender still probes.
- A stale socket FILE from a holder that crashed (`kill -9`) is proven stale by `ECONNREFUSED` and
  unlinked before binding — the `handleStaleUnixSocket` pattern. Every other probe outcome refuses.

`kind:'uncertain'` is unreachable because no foreign process shares the namespace: a listener can
only appear at this store's own 0700-gated lock path. Where that is still representable it stays
fail-closed (`DaemonOwnerActiveError`), and there is deliberately NO "advance to another candidate"
branch — advancing is what would let two processes run the stale-owner/reclaim sequence against the
same pathnames (`daemon-owner.ts:403-406`).

The fail-closed invariant is machine-checked by guard B: while a conforming holder for a storeDir
exists, a second acquire on that storeDir still rejects with `DaemonOwnerActiveError`. `OwnerRecord`
is unchanged, and the liveness listener (ephemeral port 0, `OwnerRecord.livenessPort`) is untouched.

### vitest port-supply seam removed in the same work-package

`create-daemon.ts`'s `__setStoreMutexPortProviderForTests` / `defaultVitestStoreMutexPort` /
`resolveStoreMutexPort` / `VITEST_MUTEX_*` and `daemon-owner.ts`'s `AcquireDaemonOwnerOptions.mutexPort`
(plus `STORE_MUTEX_PORT_BASE/COUNT/CANDIDATES` and `storeMutexPort`) existed only to dodge collisions
in the band this change eliminates. Keeping them would be a steady-state compatibility path for a
namespace with no remaining user, and the seam was itself defective (0-based worker id, per-file seq
reset — measured band-internal collisions). With a store-scoped lock, a test needs no port injection
at all: every test store already has a distinct address.

Two tests in `daemon-auth.test.ts` encoded the abandoned design and went with it: "routes unrelated
stores past a deterministic mutex-port collision" (now structural — guards A/C) and "fails closed on
a listener that accepts but never proves a different mutex identity" (that behaviour WAS the defect).
The second's surviving intent — an unidentified listener at THIS store's lock address keeps the lease
refused — is re-asserted at the new address in the same file.

### This was a product defect, not only a CI flake

The same code path is what `byok-agent start` and the doctor acquire. A user whose storeDir hashed
onto a port held by WeChat, a VS Code helper, cloudflared or an `ssh -L` tunnel was permanently
refused their own store's lease, with an error naming a daemon that does not exist and no workaround
short of moving the store directory or killing the unrelated program.
