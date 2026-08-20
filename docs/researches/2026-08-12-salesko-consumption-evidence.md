# Salesko 消费证据包 → byok-sdk（TaskResult cap / testkit / presence dogfood / 凭证桥）

- Date: 2026-08-12
- 来源：salesko-new main @ 4d78874 实测（脚本只读主仓；deterministic builder + schema 实构造 + safeParse 全通过）
- 对应 byok-sdk 侧：`docs/researches/2026-08-12-salesko-integration-handoff.md` 各条目的下游消费证据；dogfood freeze-order 的「salesko 侧」缺口即本文件

---

## 1. GraphVisualizationFrame 尺寸包络（TaskResult byte-cap 的实测输入）

**外推公式：`bytes ≈ 4 KiB + 1.65 KiB × nodes`（edges = 2×nodes 摊销，线性度极好）**

| 档位 | nodes/edges | 实测 JSON bytes |
|---|---|---:|
| 空 frame 地板（envelope：ui/camera/facets/commands 恒定携带） | 0 | ~3–4 KiB |
| 最小真实消息（deterministic builder，1 条混合中英文 note） | 6/3 | 8,555 B |
| 典型研究产出 | 25/50 | 48,670 B |
| 较大研究产出 | 50/100 | 95,883 B |
| 大型研究产出 | 200/400 | 343,144 B |
| 上限压力档 | 500/1000 | 833,168 B |
| 上限压力档 | 1000/2000 | 1,651,994 B |

**AgentResearchResult wrapper 开销**：最小合法 wrapper +1,004 B（+2.1%，其中 ~950 B 是 `proposedChangeSet` refine 要求的至少一条完整 command）；wrapper 非 frame 部分有硬上界 ~423 KiB（evidence.max(100)、warnings.max(100)、changeSet commands.max(200) 卡死）。**`previewFrame` 是唯一无上界变量**。

**Schema 事实**（salesko packages/contracts/src/index.ts）：
- `graph.nodes`(:637)/`graph.edges`(:638)/`timeline`(:640)/`commands`(:643) 四个数组**均无 `.max()`**——与相邻契约对照（change-set commands.max(200)、evidence.max(100)）可见这是有意开放，写入侧靠 change-set 卡。
- `node.data`/`edge.data` 是 `z.record(z.string(), z.unknown())` 无界 record——**1,650 B/node 是现实中位数不是上界，cap 必须按 byte 实施，不能按 node count**。

**下游消费方的 cap 需求声明**：
- **< 8 KiB 不可用**（连单条真实消息都放不下）。
- **≥ 256 KiB 可用**（~150 nodes，覆盖典型研究产出有余量）。
- **512 KiB 舒适**（~310 nodes）；1 MiB 保守上限（~630 nodes）。
- salesko 侧无论 cap 定多少都会保留自己的 Zod fail-closed 校验与产品级尺寸检查；byok-sdk 的 cap 语义应为 reject-at-boundary（超限即 Failed 带原因），不做截断。

## 2. result-document 的第一个下游消费形态（Phase B，实现中）

salesko Phase B（Pi 竖切，contract `20260812-0156`）当前的 inline 约定——即 result-document capability 要替代的 glue：
- daemon 从最终 assistant output 提取**单一 JSON document**（全文恰为一个 JSON 对象，或唯一一个 ```json fence；其余一律 fail）。
- 本机 `AgentResearchResultSchema` 校验（7 个必填：schemaVersion/jobId/baseFrameRecordId/baseFrameVersion/previewFrame/proposedChangeSet/stopReason）→ 写 signed terminal truth（唯一结果 authority）→ salesko 云端再次 Zod 校验 → pending change-set。
- malformed/多余 prose/双 JSON/超限全部 fail-closed，负向测试成套。
- **result-document capability 落地后**：提取器保留（LLM 输出仍要提取），但「结构化 payload 如何过 wire」从 salesko 约定换成协议槽位，salesko 删对应胶水。这就是 dogfood freeze 需要的消费证据来源——Phase B 完成后可提供：payload 实样、尺寸分布、失败模式清单。

## 3. testkit（createDeviceSimulator）的 API 面规格——来自 salesko 被迫重实现的清单

salesko `scripts/byok-pairing-smoke.ts` 现在在下游手写的协议细节（simulator 落地后这些整段删除）：
- **身份**：`crypto.subtle.generateKey({name:'Ed25519'})` + jwk `x` 导出（base64url，43 字符）。
- **签名**：`byok-nonce-v1\n` + nonce 域分隔字节序列（与 client device-keys.ts 同构）。
- **流程原语**：`pair(pairingCode, deviceName, devicePublicKey) → {deviceId, accessToken}`；`challenge → {nonce}`；`token(deviceId, nonce, signature)`；`PUT /byok/presence {level, detail}`（device bearer）；host 侧读 presence；revoke。
- **随附负向断言**（simulator 应内置为可选断言集）：未认证 admin 401、配对码单次使用（二次 401）、未域分隔签名被拒、撤销后 challenge 401。
- salesko 实跑规模：11 个 HTTP 请求 / 15 条断言，全绿（2026-08-12，colima compose 栈）。simulator 只需覆盖以上面即满足 salesko 的替换条件。

## 4. presence（1a）dogfood 承诺

1a 出 tarball 后 salesko 侧的消费与回证路径**已就绪**（不需要等 C 阶段）：
- 消费方：`apps/local-agent`（Phase B 正在建的 daemon composition）+ Phase A 已 live 验证的 byok-control colima 栈。
- 回证内容（按 1a plan 要求的格式）：tarball sha256 + salesko 消费 commit + 走通面（pair → heartbeat 周期发布 → host 读回 `level=online` → 停机后 TTL 过期 absent）。
- 周转：栈是热的，tarball 到手当天可回证。

## 4A. 0.5.0 registry consumption evidence status（2026-08-21）

- Salesko source of truth: `main@18771502724ca9383d55c097723e112979102bac` (`chore(byok): consume published 0.5.0 train (#144)`). The ref is also `origin/main` at verification time.
- Exact registry pins: `apps/byok-control` consumes `@byok-sdk/cloud`, `cloud-dataplane`, `core`, and `protocol` at `0.5.0`; `apps/local-agent` consumes `client`, `core`, `protocol` at `0.5.0` and independently versioned `keys@0.2.0`. There is no candidate tarball/file reference in those manifests.
- Executed downstream coverage: `apps/byok-control/src/device-assertion-auth.test.ts` proves first-use acceptance, same-assertion replay rejection, and revoked-device rejection against the published SDK APIs; `apps/local-agent/src/daemon.ts` configures the explicit `salesko-api` assertion audience.
- Subject-bound acceptance: at unchanged `main@18771502724ca9383d55c097723e112979102bac` (`origin/main` matched), a fresh `bun run check` completed with exit 0: 1,643/1,643 root tests and 6,089 assertions, all workspace typechecks/builds, byok-control 17/17, and local-agent 23/23. The earlier retained run `run-20260821T004816-86952-bun-run-check.log` was an exit-1 loader failure claiming that `InMemoryDeviceAssertionReplayAuthority` was absent; current public core 0.5.0 runtime/type exports and isolated/combined/full-suite runs all contain and exercise that export. The old failure was not reproducible on the same locked subject, so no unproved source-code root cause is asserted. Live production deployment and migration remain unverified.
- Upstream public readback performed for this projection: GitHub `v0.5.0` is a published, non-draft release (2026-08-20T16:30:06Z); npm exposes public `@byok-sdk/core@0.5.0` and `@byok-sdk/client@0.5.0` tarballs with integrity metadata. The upstream publish driver landed in `be5b16f87808add4b71e7b25ac51e858c741d658`, which is contained by local `v0.5.0`.

## 5. 凭证桥（P2 条目 10）的消费方需求声明——供 byok 侧设计轮输入

- 消费方：`@salesko/cli`（`salesko` bin，随 daemon 安装包 bundle，Node/Bun 独立可执行）。
- 需求语义：CLI 经 daemon local control socket（同 UID + control token）取「以本 device 身份签发的短期 assertion」→ salesko apps/api 用它换产品 session。
- 边界期望：audience 显式（`salesko-api` 级白名单）；TTL ≤ 5 min；jti 防重放；**pairing revoke 必须同步使 assertion 换发失效**（撤销一次、daemon+CLI 同死）；审计事件不含 assertion 本文。
- salesko 侧对应工作（Phase C）：apps/api 新增 assertion→session 路由；在 byok 侧 API 定稿前不动。

## 6. 顺带：frame 构造的 shape 约束（byok 侧写 fixture/测试会用到）

- `GraphNodeSchema` 必填 `id/type/label/confidence/visual`，`visual` 必须完整 `{position:{x,y,z}, color, size>0, emphasis}`。
- `GraphEdgeSchema.type` 仅 7 个 relation enum；`source/target` 在 schema 层不做引用完整性校验。
- `camera.mode` 仅 `flat|focused|timeline|sphere`，新产出用 `flat`。
- `ui` 是重型必填块（productName/activeView/searchPlaceholder/filters/relationshipStrength/detailPanel/stats）。
- `source` 仅 `deterministic-rule|model-generated|mastra-tool`。
