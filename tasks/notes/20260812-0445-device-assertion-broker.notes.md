# Implementation Notes: device-assertion-broker

> **Status**: Active
> **Plan**: plans/plan-20260812-0445-device-assertion-broker.md
> **Contract**: tasks/contracts/20260812-0445-device-assertion-broker.contract.md
> **Review**: tasks/reviews/20260812-0445-device-assertion-broker.review.md
> **Last Updated**: 2026-08-12 04:46
> **Lifecycle**: notes

## Design Decisions

- 六道闸顺序固定并在 handler 注释里写死：disabled → bad_request → audience_denied → shutting_down → revoked → not_paired。前两道的相对顺序有实义：功能关闭时任何输入都只回 `assertion_disabled`（不泄露「我会校验 params」），params 不合法时先回 `bad_request`（畸形请求不能拿来探白名单）。测试用「feature off + 五种输入全回 assertion_disabled」和「允许的 audience + 多余 key 回 bad_request」把顺序钉住。
- `shuttingDown` 旗标只在 `performControlShutdown` 里同步置位，且永不复位（同一实例的下一次 `start()` 也不复位）。fail-closed：被要求关停过的进程不再铸币，重启才恢复。
- 签名单独放 `daemon/device-assertion-signer.ts`：这是唯一碰私钥的地方，「无模块级私钥缓存」因此是一个短文件的可扫描属性，而不是对 2000 行 `create-daemon.ts` 的断言。constraint test 直接扫这个文件（无顶层 `let`/`var`、`importPrivateKeyPem` 恰好一次），并断言 `create-daemon.ts` 完全不出现 `importPrivateKeyPem`/`devicePrivateKeyPem`。
- issuer 走既有的 `url.ts` `toHttpBase` 再取 `origin`：ws:/wss: 与 http:/https: 两种配置写法归一到同一个 issuer，复用唯一的 URL 归一化点而不是新写一个。
- 审计隔离是结构性的：`device-assertion` 事件类型本身没有签名/信封字段，`bin/audit-log.ts` 无从泄露；issued 路径 audience 来自 operator 白名单故逐字落盘，denied 路径 audience 是调用方自由文本故只落 `audienceSize`（沿用该文件既有惯例）。

## Deviations From Plan Or Spec

- **`verifyDeviceAssertion` 的 deps 多两个必填项，非设计改动而是 core 既有铁律所迫。**
  - `verifier: DeviceAssertionVerifier`：core 不含 crypto（`constraints.test.ts` 禁止 shipped source 出现 `node:` import；`attestation.ts` 同样把 Ed25519 校验做成注入端口 `DeviceProofVerifier`）。计划写的 `verifyDeviceAssertion(envelope, {publicKeyJwkX, revoked, now?})` 在 core 里无法完成签名校验，故按被克隆的 device-proof 机制注入验签端口。
  - `now: Date` 必填（计划写的是 `now?`）：`constraints.test.ts` 的 "reads time only through the injected clock" 禁止 core 读墙钟，可选参数没有合法默认值。收紧为必填而不是发明一个默认值。
  - 两处都只是收紧；`revoked` 仍是必填，「忘记复查」仍然编译不过，设计意图未变。
- `verifyDeviceAssertion` 接受 `input: unknown` 并在内部 fail-closed 解析（计划写的是接受 envelope），与被克隆的 `authenticateDeviceProof(input: unknown, ...)` 一致，是更严格的超集。
- 未加 clock skew 容忍窗口：设计没提，短窗口本身就是全部安全边际，加容忍度等于偷偷放宽窗口。已写进 docs/security.md。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| 复用 `DeviceProofVerifier` 端口 | 拒绝，另立 `DeviceAssertionVerifier` | 形状虽同，但本 slice 的全部意义就是两个域不可互换；共享类型是走向共享代码路径的第一步。同一个 composition 对象可同时满足两者，零实现成本 |
| `shuttingDown` 在 `start()` 复位 | 拒绝，永久锁存 | 复位点就是关掉这道闸的地方；fail-closed 优先，代价只是进程内 revoke→re-pair→start() 恢复流要重启进程 |
| 六道闸内联在 `create-daemon.ts` | 采纳（闸内联，签名外置） | 闸需要闭包读 `auth`/`store`/`shuttingDown`/config；签名不需要，且外置才能让密钥卫生可扫描 |
| `audiences` 重复项静默去重 | 拒绝，构造期抛 | 重复通常是复制粘贴时漏改的第二条，去重等于把这个错误永久藏起来 |

## Open Questions

- `pnpm --filter @byok-sdk/client audit:credentials` 在 darwin 上返回 `UNSUPPORTED: credential audit requires Linux strace`（平台门，非本改动导致）。可移植的那半 `credential-audit-core.test.mjs` 随 client 套件通过；完整审计需要 Linux runner。
- 本 slice 不触碰 runtime CLI 凭证面，不新增任何 `~/.claude`/`~/.codex`/`~/.pi` 访问路径。

## Codex Adversarial Review — Findings and Dispositions

Codex 二审在 gatekeeper 通过后又抓到 2×P1 + 2×P2 + 2×P3，全部为真，全部已修（同一 worktree，未提交）。

- **F1 [P1] shutdown latch 是延迟置位而非同步。** `shutdown` RPC 经 `setImmediate` 延后 `performControlShutdown`，`shuttingDown=true` 在 handler 返回后才置位；pipeline 的 `shutdown`+`assertion.issue` 批在 latch 仍为 false 时铸币。且 `daemon.stop()`/`unpair()` 走 `runShutdownSequence` 从不置 latch。**修复:** latch 在每个入口同步置位——`shutdown` handler 第一条语句（在 `setImmediate` defer 之前)`shuttingDown = true`，`runShutdownSequence` 顶部同步置位（覆盖 stop()/unpair()），`performControlShutdown` 保留一处兜底。一个 latch，每个入口都武装。新增 pipeline 测试（`codex F1`）：并发写 `shutdown`+`assertion.issue`，断言第二个回 `shutting_down` 且 signer count=0。
- **F2 [P1] TOCTOU:六道闸在 `await store.load()` 之前查、签名前不复查。** load 的 await 期间 revocation/shutdown 可变，恢复的 handler 仍签。**修复:** `store.load()` 之后、`mintAssertion` 之前，紧贴签名点复查 `shuttingDown` 与 `auth.isRevoked()`（record 仍在即 not-paired 复查）。与 result-document capability 复查同型。
- **F3 [P2] verifier 出处未强制,"编译不过"是假的。** `revoked: boolean` 让 host 传字面 `false` 而永不查行。**修复:** 忠实克隆 device-proof 端口形状——deps 改为 `lookupDevice(deviceId) => { publicKeyJwkX; revoked } | undefined`（sync/async 皆可）。verifier 内部:parse → 从 claims 读 deviceId → `row = await lookupDevice(deviceId)` → 无则拒 → revoked 则拒 → 用 `row.publicKeyJwkX`（绝不用信封内的 key）验签 → 过期检查 → 返回 claims。「忘记查当前行」与「查了 revocation 却用信封 key 验签」都无法表达。core 导出新增 `DeviceAssertionDeviceRow` 类型；三个测试文件全部改传 lookup 端口;docs §5 改写描述端口并删去「pre-fetched boolean 让遗忘不可能」的措辞。
- **F4 [P2] 威胁表夸大 same-UID 控制。** 旧表「Cannot: mint for non-allowlisted audience」与同一行「Can: 读 device.json 直签」自相矛盾。**修复:** 表格如实分层——audience 白名单/TTL 约束的是「不具备直接密钥访问的 control-socket 客户端」，不是 same-UID 边界;same-UID 进程可读 0600 device.json 伪造任意 claims,属 OS 信任边界内(与读任意 runtime 凭证同级),broker 的职责是「不拓宽」该边界而非「关闭」它。新增独立行区分「经 broker」与「不经 broker」。
- **F5 [P3] 过期边界。** 有效期是 `[issuedAt, expiresAt)`,应在 `now >= expiresAt` 拒(旧为 `now > expiresAt`)。**修复:** 改比较符;翻转「exact instant 接受」测试为「拒」,并补 issuedAt 左闭测试。
- **F6 [P3] 测试诚实性。** (a) 新增 F1 pipeline 测试断言不铸币;(b) 注入计数 signer(`DaemonOverrides.deviceAssertion.mint` 测试 seam),每个拒发测试断言 signer 从未被调用(count=0),而非仅断言回了错误;(c) 域分隔测试原本 copy 了 nonce 域字面量——权威三向(含 nonce)falsifier 移到 client 套件,import 真实的 `NONCE_SIGNING_DOMAIN`(core 因 `@byok/*` import 禁令无法 import 它),production 漂移即变红。core 侧保留 proof↔assertion 两向(两个都是 core 导出常量)。

签名端口注入 seam(F6b)是 test-only,production 走真实 `mintDeviceAssertion`;这是 fail-closed 闸「拒发即零签名」这一契约唯一可证的方式(观察 signer 未被调用,而非仅观察回了错)。**注:round-2 F3 推翻了 round-1 的 mint-replacement seam 形状,详见下。**

## Codex Adversarial Review — Round 2 Findings and Dispositions

Round-1 修复后 codex 二轮:F1/F3 未完全闭合,且 round-1 的 F6/F4 修复各引入一个新真洞。五项全真,全部已修(同一 worktree,未提交)。

- **R2-1 [P1] F1 在 stop()/unpair() 仍开。** `runLifecycleMutation` 在到达 `runShutdownSequence`(latch 所在)前先 await 前驱,所以排在 in-progress start()/pair() 后面的 stop()/unpair() 在整个前驱期间 latch 仍为 false,socket 照签。**修复:** 在 public `stop()` 和 `unpair()` 方法体第一条语句同步置 `shuttingDown = true`——被调用的瞬间,进入 lifecycle 队列之前、任何 await 之前。(shutdown RPC / performControlShutdown / 直接 runShutdownSequence 三条已正确。)新增测试:TestServer.blockNextPair() 挂住 in-progress pair() 占住 lifecycle 队列,再 stop(),断言并发 assertion.issue 回 shutting_down 且 signer count=0。
- **R2-2 [P2] F3 遇畸形 row 仍 fail-open。** verifyDeviceAssertion 只查 `row === undefined || row.revoked`,故 `{publicKeyJwkX}` 缺 `revoked` 字段(undefined 为 falsey)通过——已撤销设备被接受。**修复:** lookup row 严格运行期校验(`isUsableDeviceRow`):`row.revoked === false`(精确布尔 false)且 `publicKeyJwkX` 为 43 字符 Ed25519 JWK x 正则匹配;任何其它形状(revoked undefined/truthy/非布尔、key 缺失/畸形/非串、row null/非对象)在 crypto 之前拒。新增测试:10 种畸形 row 全拒且 verifier 从未被调,加一条正形 sanity。
- **R2-3 [P2] 新洞:F6b 的 mint seam 是公开生产面。** `DaemonOverrides` 从 index.ts 导出、`createDaemonWithAdapters` 公开接受,round-1 的 `deviceAssertion.mint` 收到完整 `DeviceRecord`(含 `devicePrivateKeyPem`)——生产接入方可注入回调窃私钥或伪造 claims。**修复:** 删除 `DaemonOverrides.deviceAssertion.mint`;改为 **post-sign OBSERVER** hook `AssertionIssueProbe.onIssued({jti, audience})`,只在真实成功签名之后被调、只收非密元数据,且经内部非导出 seam `buildDaemonWithAdapters`(从模块导出,**不**从 index.ts 再导出)路由——测试直接 import 模块。它看不到私钥、改不了签名/claims/审计、任何公开类型都够不到。新增 constraint 测试:断言 index.ts 不暴露 `buildDaemonWithAdapters`/`AssertionIssueProbe`/`onIssued`/`devicePrivateKeyPem`;`DaemonOverrides` 接口体无 `mint`/`deviceAssertion`/`DeviceRecord`/`devicePrivateKeyPem`;`AssertionIssueProbe.onIssued` 签名只含 jti/audience,不含 record/key/envelope/signature。
- **R2-4 [P2] 新洞:F4 漏了 denied audience 原文进 observer/stdout。** audit.jsonl 存的是 audienceSize,但活的 DaemonEvent 仍带原始 caller-controlled audience → format.ts 逐字打印 → start.ts 送 foreground/systemd/launchd/WinSW stdout。调用方把私钥 PEM/签名当作非白名单 audience 提交即成为持久服务日志内容。**修复:** DaemonEvent 的 `device-assertion` 变体按 result 拆分:denied 变体**根本没有** raw audience 字段,只有 `audienceSize`,在 **事件构造时**(`noteDeviceAssertion`)由 raw 转字节数并丢弃原文;issued(来自白名单,安全)保留原文。结构性隔离,非事后 redact。format.ts/audit redact+reconstruct 三处同步更新。新增测试:secret 形 audience 触发 audience_denied → 断言 observer 事件与 formatDaemonEventLine 输出只含 size 数字、绝无原文。
- **R2-5 [P3] 文档过度宣称。** §5 表格「leaked assertion cannot be used against another audience/issuer/product」不成立——verifyDeviceAssertion **不**比较这三者,只把 claims 交给 exchange 比。**修复:** 该行限定为「仅对执行 downstream-MUST 列表(比 audience/issuer/productId 且烧 jti)的 conforming exchange 成立」,并明写 helper 只 surface claims 供比对、自身不 enforce;对不比较的 non-conforming exchange 这些「Cannot」都不成立。

Round-2 净结果:signer 计数改由 post-sign observer(非密)提供,mint-replacement seam 彻底移除;私钥仍只在 `device-assertion-signer.ts` 一处被 import,且不经任何公开面可注入。

## Codex Round 3 — Test-Isolation Lease Leak (CI flake)

**症状**:加了 Row 5 后,client 全量套件约每 3 次有 1 次在**别的**文件(real-server-redelivery、journal-crash-matrix 等)间歇性报 `DaemonOwnerActiveError: store mutation lease is already held by an active unknown process`;base 分支(无本 slice)全量 green。

**根因**:daemon 的 owner lease 是一个**跨进程端口互斥量**(`daemon-owner.ts`),端口由 storeDir 规范路径哈希确定(10000–30000)。vitest 把测试文件分到并行 worker 进程跑;一个未被完全 stop() 的 daemon 会把它的 mutex 端口一直占住,与后续文件里哈希到同端口的 daemon 相撞。撞端口时 contender 会 probe 持有者身份,持有者 1s 内不应答即 `uncertain` → fail-closed 抛 `DaemonOwnerActiveError('unknown')`。本 slice 的泄漏源有二:
1. 三个「交接」测试(shutting_down / pipeline / queued-stop)之前把 `daemon = undefined` 后把 teardown 交给未被 await 的异步 RPC shutdown——afterEach 的 `await daemon?.stop()` 因此变成 no-op,lease 端口留到 worker 生命周期结束。
2. `blockClose` 测试用 `shutdownGraceMs: 5_000` 挡住 active task 的 teardown;并行负载下若 release() 迟于 5s grace,`mutationBarrierComplete` 变 false → **lease 被保留、stop() 抛错**,而 afterEach 的 `.catch(()=>undefined)` 把这个抛错连同泄漏一起吞了。

**修复**(仅测试与 fixture,未碰产品逻辑,未弱化任何安全断言):
- 两个测试文件都改为**数组追踪每一个创建的 daemon**,afterEach 保证逐个 `stop()`(幂等,覆盖 RPC-shutdown/unpair 路径);broker 文件在 pair()/start() 之前就 push,连启动失败也会被拆掉。
- 三个交接测试删掉 `daemon = undefined`;`blockClose` 的 `release()` 放进 finally(测试体抛错也解锁会话)。
- shutting_down 测试 grace 提到 `60_000`(挡住的 teardown 永远等 release 而非撞 deadline),并在测试内 `release(); await daemon.stop()` 让 lease 确定性释放、错误可见。
- pipeline 测试**去掉 blockClose/active-task**:两帧同 tick 背靠背写入,server 在 shutdown 的 `setImmediate` teardown 宏任务之前就把两个 RPC 当微任务派发完,故无需挡 socket;daemon 干净快速拆除、快速释放 lease。
- config-validation 那组只构造不启动(无 lease),仍给每次 build 唯一 storeDir,杜绝任何共享 store 路径。
- TestServer 加一次性 `blockNextPair()` 钩子供 round-2 F1 排队测试用(默认关,不影响既有测试)。

**验证**:全量 client 套件**连续 8 次 green**(1110/1110 ×8,前次约 1/3 失败率);两文件隔离运行 37/37;core 150/150;strict workflow OK。

### Round-3 续:teardown 纪律不够,加 test-injectable 唯一端口

只靠 teardown 纪律把 flake 从 ~1/3 降到 ~1/4,没根除:owner-lease 端口由 storeDir 哈希落进 20000 宽的定长带(`daemon-owner.ts`,10000–30000),并行 worker 里众多 daemon 撞端口是**生日悖论**问题,与 teardown 无关——撞上且持有者正在拆除、1s 内不应答 probe 就 fail-closed 抛 `DaemonOwnerActiveError('unknown')`(生产正确,测试并行下是 flake)。真正的修法是给每个测试 daemon 一个**保证唯一的端口**。

- **产品 seam(加法、生产零变化)**:`acquireDaemonOwner(storeDir, role, clock?, options?)` 新增 `options.mutexPort?`;`storeMutexPort(identity, attempt, override?)` 有 override 时 attempt0 用该端口(EADDRINUSE 仍 +attempt 步进,candidate 协商不变),无 override 时哈希推导原样。两个生产调用方(create-daemon 传 undefined、diagnostics 不传)都走默认 `{}` → 哈希,byte-identical。
- **create-daemon 内部 seam(不导出 index、不在 DaemonConfig/DaemonOverrides)**:模块级 provider + 非公开 setter `__setStoreMutexPortProviderForTests`;每个 daemon 构造时 `resolveStoreMutexPort()` 解析一次并复用于该 daemon 全生命周期的三处 acquire。默认 provider 缺省时,`defaultVitestStoreMutexPort()` **仅在 `VITEST_WORKER_ID`/`VITEST_POOL_ID` 存在时**(只有 test runner 会设)返回 per-worker 唯一端口——band = `(workerId-1)%42 * 64`,offset = `seq++ % 64`,落在 **30000–32687**(高于哈希带、低于 Linux ephemeral 32768,Linux/macOS 皆空闲);生产该 env 不存在 → 返回 undefined → 哈希不变。这样**每个经 createDaemon/createDaemonWithAdapters/buildDaemonWithAdapters 构造的测试 daemon 自动拿到唯一端口**,无需改 39 个测试文件、无需动 vitest.config(在 allowed_paths 之外)。
- 为什么 env 检测落在(生产惰性的)产品分支而非 vitest setupFile:本任务 allowed_paths 只含 `packages/{core,client}/src` 等,`packages/client/vitest.config.ts` 不在内,无法加全局 setupFiles;逐个改 39 个 daemon 构造文件 blast radius 过大。env-gated 默认是唯一既覆盖全部又生产 byte-identical 的机制。显式 DI seam(`__setStoreMutexPortProviderForTests`)同时提供,供测试点名注入。
- 直接调 `acquireDaemonOwner` 的测试(daemon-auth/diagnostics/…)是**lease 原语测试**,不构造 daemon,按设计仍走哈希(那正是被测行为),绑哈希带(现竞争更小)。
- 测试:constraint 断言公开面(index/DaemonConfig/DaemonOverrides)无任何 mutex-port override;DI-seam 证明测试注入 provider → daemon 在注入端口上 EADDRINUSE(绑定成功)、每 daemon 恰调用一次。

**验证**:全量 client 套件**连续 10 次 green**(1112/1112 ×10);core 150/150;client typecheck clean;对基点零 diff;strict workflow OK;`daemon-owner.ts` 纯加法(两个生产调用方行为不变)。

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
