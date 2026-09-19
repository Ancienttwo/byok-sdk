# ADR-036：Pi 运行来源改为官方发行包，fork 仅作为被枚举的增量

> **来源**：owner 于 2026-09-19 交付并接管 `official-pi-migration-v1` 执行方案；事实基线为 `origin/main@79f6a0d`，官方候选为 `@earendil-works/pi-coding-agent@0.85.1`。
> **关联**：`plans/plan-20260919-1603-official-pi-migration.md`（OP0–OP8）、`docs/researches/2026-09-19-official-pi-fork-delta-map.md`、`docs/researches/2026-09-19-official-pi-baseline.json`、`docs/researches/2026-09-19-official-pi-op1-probe-report.md`、`docs/researches/2026-09-19-official-pi-op1-probe-results.json`。
> **范围**：本 ADR 只裁定 runtime 来源与身份边界，以及迁移的 gate 结构。它不授权切换 `bun.lock`/根 manifest/`packages/client/package.json`，不授权发布、安装、下游迁移或上游提交，也不解除任何已冻结的产品语义。

## Context

活动运行依赖当前是自维护 Pi 发行线：`packages/client/package.json` 把 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-ai` 指向 `npm:@byok-sdk/pi-*` 别名。OP0 的取证给出了两侧事实：

- 官方链条完整：tarball integrity 可本机复算、`gitHead` 可绑定、SLSA v1 provenance 的 subject digest 与实际 tarball 逐字节一致、无生命周期脚本、发行包自带完整依赖闭包清单。
- fork 链条不完整：已发布的三个 `@byok-sdk/pi-*` 包没有可绑定的构建提交，也没有 provenance attestation；能建立的联系只有 fork 自述的 upstream base/commit 与文件级比对。

同时，fork 的增量是可完整枚举、有界的：coding-agent 侧是 4 个新模块（纯输入准备、prepared-session-input、provider timeout、system prompt renderer）加若干既有模块的判别位改动；pi-ai 侧是「无 provenance 的 host canonical assistant 文本」这一新事实类别，加 provider 请求的 P(D) 结构投影。共同路径中绝大多数文件与官方逐字节相同。

这意味着迁移的真实成本不在「替换依赖」，而在于：这些增量能否用官方公开入口表达。OP1 已就此裁定 G1（第二档）：

- 可行：显式 session 组装、工具往返、生命周期、装载闭合，以及**调用方拥有 transport 而仍由官方 serializer 产出请求体**（gate 观察到的字节与线上收到的字节逐字节相同）。
- 缺口：没有任何公开的 task-free 编译入口；没有承载 host 断言 assistant 文本的途径（当前表现为**静默不发请求**）；拒发虽然让端点保持 0 请求，但失败被吞掉并触发隐式重试，**不可传播**。
- 反例：`before_provider_request` 钩子即使抛错也拦不住发送。

## Decision

1. **目标运行来源是官方未修改的正式发行包**，由 BYOK 管理自己的安装并在受控子进程中经公开 SDK 接口运行。自维护 fork 发行线不再是目标形态；fork 只作为一份被完整枚举的增量清单存在。
2. **身份以发行事实绑定**，不再以 fork 标记绑定：官方包名 + exact version + tarball integrity + 实际 exports/契约兼容 + 自有 bridge digest + 实际依赖闭包。保留「预期身份 != 实际身份就拒绝」的 fail-closed 行为。不使用 GitHub main 的 manifest 作为已发布包证明。
3. **不得用替代手段补齐缺失 seam**：禁止 private deep import、安装后 patch、复制官方 serializer/provider/session 核心、全局网络 monkey patch，也禁止把预算/S2 关掉换绿。缺接口时只走最小上游改进包（OP2-U）。
4. **gate 结构固定为 G1–G4**：G1 官方替代能力（已裁定：第二档）；G2 OP2–OP4 语义等价且关键负控有效；G3 干净安装/持久恢复/平台/Host 固定组合；G4 经批准的真实目标与迁移演练。四门未过之前不启用生产能力。
5. **上游未进入可验证发行包前，依赖这些 seam 的生产路径保持禁用**，其余不依赖它们的工作继续。不引入 `pi-official` 与 `pi-fork` 两条长期可选产品线，不做双 runtime 路由。
6. **迁移不得取消既有冻结语义**：task-free preparation、required message 的精确 accepted 正文、unknown 先对账、custody/递归约束、完整历史与授权边界都继续成立。已承诺的 scripted workflow、递归与发行形态不因换依赖被静默删除。
7. **不虚构 provenance**：官方包 integrity/签名与 BYOK 自有产物信任分别报告；fork 包缺失的 attestation 不得被描述为存在。第三方的 vendored 扩展继续如实披露——退出 Pi fork 不等于仓库不再包含其他第三方代码。

## Rationale

选择「官方发行包 + 小型适配层」而不是「继续维护 fork」，理由是身份可解释性与维护成本的分母不同：fork 把上游全部代码变成 BYOK 需要自行解释的字节，而增量清单把 BYOK 需要解释的范围压缩到可枚举的少数模块。

但把「换来源」等同于「重写 Pi」会立刻破坏既有不变量。OP1 的 P04 结果说明这个边界恰好落在正确的位置：让 BYOK 拥有 transport、让官方拥有 serializer，是唯一既保持语义权威单一、又能拿到发送前字节的形态。反过来说，任何以复制 serializer 达成的等价实现都会重新引入第二份语义权威，正是本项目明令禁止的形状。

10x 压力点先出现在哪里：迁移把「一个巨大的自有发行物」换成「一个官方闭包 + 一份审计过的增量」，失败面因此从「无处可查的整包差异」移到「上游接口是否可传播拒绝与是否承认 host 自有历史」。后者是可以用最小复现证伪的具体接口问题，而不是不可控的范围问题。

## Consequences

- 迁移期间仓库同时存在既有 fork 依赖与官方候选证据；**在 OP3/OP5 落地前，`bun.lock`、根 manifest 与 client manifest 保持现状**，本 ADR 不把目标状态冒充为已实现状态。
- OP3/OP5 的实现必须同时更新：依赖与 lock、身份 gate（`scripts/release/pi-runtime-identity.mjs`）、release graph/API surface golden、安装与回退路径、以及用户可见的 runtime 来源披露。
- 模型目录数据在官方与 fork 间是**双向**差异，切换会改变模型可用性。这是功能面的事实，必须验证与披露，不得当作实现细节。
- OP2-U 是当前关键路径：它需要上游接受「可传播拒绝」与「host 自有历史导入」等通用能力；在此之前 prepared 生产路径保持禁用，`official_supported` 不得被声明。
- 退役 fork 需要排空而非宣告：在途 task、pending message、prepared artifact、home lease 与恢复身份都要按原 runtime 处理完，再切换新准入；旧产物按 retention 与 live reference 清理，不设拍脑袋的 TTL。

## Status

**Accepted（owner-approved 2026-09-19 direction；implementation gated，未落地）。** 已闭合：OP0 基线冻结与增量分类、OP1 五项 probe 与 G1 裁定。未闭合：OP2-U 上游接口、OP3–OP8。
