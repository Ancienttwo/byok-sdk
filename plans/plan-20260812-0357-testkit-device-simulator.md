# Plan: Public Headless Testkit: Device Simulator

> **Status**: Executing
> **Created**: 20260812-0357
> **Slug**: testkit-device-simulator
> **Artifact Level**: work-package
> **Promotion Reason**: Sprint Row 4（salesko handoff 条目 9）：下游被迫在自己的 smoke 里手写协议级 device 身份（WebCrypto Ed25519 + jwk 导出、`byok-nonce-v1\n` 域分隔、pair/challenge/token/presence/revoke 全流程、15 条断言含四负向）——纯 core 知识落在下游即 drift 源。API 面规格已由消费证据 §3 封闭。conformance 保持 private、never-published 身份不翻转；simulator 落在新的可发布 testkit 包，conformance 作为其第一个消费方。
> **Verification Boundary**: `pnpm -r run build`、testkit typecheck/test、conformance 全套（含新 simulator 套件对 in-memory cloud composition 的 5 原语 + 4 负向）、`packages/protocol packages/cloud-postgres deploy` 零 diff、strict workflow。
> **Rollback Surface**: revert 本 slice；新包删除即回滚；三处 NONCE_SIGNING_DOMAIN 引用改回本地常量即恢复（保留原导出面不破坏 API）。
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-08-12-salesko-integration-handoff.md` 条目 9；`docs/researches/2026-08-12-salesko-consumption-evidence.md` §3（API 面规格与 15 条断言替换条件）
> **Task Contract**: `tasks/contracts/20260812-0357-testkit-device-simulator.contract.md`
> **Task Review**: `tasks/reviews/20260812-0357-testkit-device-simulator.review.md`
> **Implementation Notes**: `tasks/notes/20260812-0357-testkit-device-simulator.notes.md`

## Agentic Routing
- Selected route: 本 worktree 内 deep-worker 执行，gatekeeper 验收（非协议冻结面，单轨）；计划与裁决留主循环。
- Routing reason: 新包脚手架 + 跨 4 包单一权威重构 + 加密细节搬移，须一次落准。
- Due diligence:
  - P1 map: `NONCE_SIGNING_DOMAIN = 'byok-nonce-v1\n'` 当前三处重复定义——client/src/daemon/device-keys.ts:55、cloud/src/auth/verify.ts:22、server/src/auth.ts:34（drift 隐患实证）；core/src/attestation.ts:40 已有 `DEVICE_PROOF_DOMAIN_PREFIX` 先例（域常量住 core）。conformance（private, main 指 src）依赖 core+cloud，其 pairing 相关断言当前不含协议级 device 流程模拟。salesko smoke 实跑规模：11 HTTP 请求 / 15 断言（evidence §3）。cloud 有意不依赖 protocol（hosted 与 device wire 分层），所以共享常量的家只能是 core。
  - P2 trace（目标链路）: 下游 CI `devDependency @byok-sdk/testkit` → `createDeviceSimulator({ baseUrl, fetch?, hostAuth? })` → 身份（WebCrypto Ed25519 + jwk `x` base64url 导出）→ `pair(pairingCode, deviceName)` → `challenge()` → `signNonce`（core 的域分隔字节）→ `token()` → `publishPresence(level, detail?)`（device bearer）→ host 侧读回（hostAuth 注入）→ `revoke` → 内置负向断言集（未认证 admin 401、配对码单次使用、未域分隔签名被拒、撤销后 challenge 401）。conformance 新套件对 in-memory cloud composition 跑通全部面 = 下游删除手写协议段的替换条件。
  - P3 decision rationale: ① 单一权威：`NONCE_SIGNING_DOMAIN` + `nonceSigningBytes(nonce)` 上移 core（attestation 同居），client/cloud/server 三处改为从 core import 并保留原导出（re-export，公共 API 不破坏）——消除既有三重复而非添加第四份。② testkit 是新的可发布包 `@byok-sdk/testkit`（version 0.2.0 对齐 workspace；build 管线抄 cloud-postgres：tsup+tsc、files: dist/README/LICENSE、无 private），运行时依赖仅 core+protocol；不依赖任何测试框架（headless——负向断言是普通 async 函数，conformance 用 vitest 包它）。③ conformance 身份不动（private、src 直出），新增 simulator 消费套件。④ 本 slice 不把 testkit 加入 release 打包清单（scripts/release 零改动）——是否入 0.2.x release train 归 owner 晨间决定，记入 notes 跟进项。⑤ WebCrypto 用 globalThis.crypto（Node ≥22.19 workspace 底线自带）。
- 并发边界：Row 3 分支同期改 packages/protocol、server/hub、client/task-runner——本 slice 对这些文件零接触（server 只动 auth.ts、client 只动 device-keys.ts），core/index.ts 追加一行 export 是与 Row 8 唯一可能的琐碎合并点，晨间合并时由 orchestrator 解。

## Approach
### Strategy
1. core：新 `src/pairing.ts`（或并入 attestation.ts 旁）导出 `NONCE_SIGNING_DOMAIN` 与 `nonceSigningBytes(nonce: string): Uint8Array`；index 追加导出；域分隔测试（与 DEVICE_PROOF_DOMAIN_PREFIX 互不为前缀）。
2. client/cloud/server：三处本地常量改为 import + re-export；各包测试保持绿（行为零变化）。
3. 新包 packages/testkit：`createDeviceSimulator` + 身份/五原语/负向断言集 + 类型；README 写明「下游删除手写协议段的替换条件」对照表（evidence §3 的 15 条）。
4. conformance：新套件 `pairing-simulator.test.ts` 起 in-memory cloud composition，跑 5 原语 + 4 负向（含前缀/伪造签名用例）。
5. workspace 接线：pnpm-workspace 已 glob packages/*；根 tsconfig/引用如需则补。

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| simulator 塞进 conformance 并公开发布 | 少一个包 | 翻转 conformance「never published」身份宣称，且把内部 store 语义断言一并公开 | 拒绝 |
| testkit 依赖 client 复用 device-keys | 零搬移 | 拖进整个 daemon 依赖树，testkit 不再轻量 headless | 拒绝 |
| 域常量留三处、testkit 抄第四份 | 零重构 | 与「禁止重实现」正面冲突，drift 面扩大 | 拒绝 |
| 常量上移 protocol | wire 相关 | cloud 有意不依赖 protocol（hosted/device 分层）；core 是三包公共祖先且有 attestation 先例 | 拒绝，上移 core |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/core/src/pairing.ts` + index | Add | NONCE_SIGNING_DOMAIN + nonceSigningBytes + 域分隔测试 |
| `packages/client/src/daemon/device-keys.ts` | Modify | import + re-export，删本地定义 |
| `packages/cloud/src/auth/verify.ts` | Modify | 同上 |
| `packages/server/src/auth.ts` | Modify | 同上 |
| `packages/testkit/**`（新包） | Add | package.json/tsup/tsconfig/src/simulator + README |
| `packages/conformance/src/…pairing-simulator…` + package.json | Add/Modify | devDep testkit（workspace:*）+ 新套件 |

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 重构改变签名字节（域常量转录错） | Low | High | 三包既有测试全绿 + 域分隔断言逐字节对比旧常量 |
| simulator 自行实现签名细节偏离 client | Medium | High | 核心字节全部经 core 导出函数；conformance 套件对真实 cloud composition 端到端验证 |
| 新包构建/导出形态与发布纪律不符 | Medium | Medium | 逐项抄 cloud-postgres 的 package.json 形态；`npm pack --dry-run` 核对 files |
| conformance 套件与既有套件端口/夹具冲突 | Low | Low | 使用既有 in-memory composition 工厂模式 |

## Promotion Gate
- **Merge/PR unit**: 一个 PR：core 常量上移 + 三包引用 + 新包 + conformance 套件。
- **Rollback surface**: revert；新包删除即回滚。
- **Verification boundary**: 见 header。
- **Review/acceptance boundary**: gatekeeper 单轨（非冻结面）；testkit 对外「可发布」宣称等 salesko CI 真实以 devDep 消费一轮（dogfood）后再进 release train。
- **High-risk surface**: 签名字节等价性、负向断言真实性（须对真实 composition 红过）。
- **Why not checklist row**: 新公开包 + 跨包单一权威重构，独立回滚面。

## Evidence Contract
- **State/progress path**: 本 plan + contract + notes。
- **Verification evidence**: 各包测试输出、conformance 新套件明细、pack dry-run 文件清单。
- **Evaluator rubric**: 5 原语对 in-memory composition 全通；4 负向各自独立红过（关掉对应防线或伪造输入时失败）；三包重构后全套零行为变化；testkit 无 private 标记、运行时依赖仅 core+protocol、无测试框架依赖；`packages/protocol packages/cloud-postgres deploy scripts` 零 diff。
- **Stop condition**: simulator 内出现任何独立于 core 的签名/域实现；conformance 身份被翻转；negative 断言靠 mock 自证。
- **Rollback surface**: revert commits。

## Annotations

- 已解决：依据 owner 2026-08-12 /goal 指令（完成整个 sprint）授权推进；API 面规格逐条采用消费证据 §3；testkit 入 release train 与否留晨间决定。无遗留注释。

## Task Breakdown
- [ ] core：域常量/字节函数上移 + 域分隔测试
- [ ] client/cloud/server 三处引用重构（行为零变化）
- [ ] packages/testkit 新包：simulator 五原语 + 身份 + 负向断言集 + README 替换条件表
- [ ] conformance：pairing-simulator 套件（5 原语 + 4 负向对真实 composition）
- [ ] 全套验证 + gatekeeper
