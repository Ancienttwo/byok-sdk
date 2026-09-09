# Conversation-turn Fresh MVP — SDK-first Sprint

日期：2026-09-10。状态：IN_PROGRESS；交付顺序纠偏已记录，SDK 能力验收未完成。

## Authority and scope

Owner 最新指令：先做 SDK，供 Salesko 与 aiphabee 接入；Salesko 是真实集成测试先行入口。目标保持“完成整 Sprint，按阶段验收并提交 PR”。原 Salesko-first Sprint 的 SDK 只读限制不能继续作为不实现 SDK 的理由。

产品权威仍为 `docs/spec.md`。本计划不把既有 fresh 原语等同于完整产品模式；也不预设新增 Conversation store、executionMode 或 wire 字段。保留 B1-A、B2、B3、D05。连续会话模式是可选接入方式，原 session 路径保持明确契约，禁止运行失败后改变语义。

Salesko `codex/conversation-turn-fresh-mvp` 候选停在本轮回读的 `90fab70c54895ee0bcf08f45a164bb823f9ada34`，工作树干净。保留候选，不继续扩大产品实现，不重置或删除。历史 PR 信息需远端回读后再作为当前事实。aiphabee 已由 Owner 指认为 `/Users/kito/Projects/aip-main-open`；现有入口是 Node-only byok-host/coordinator 与 SQLite research-pass host，不代表已有 recurring chat。

生产迁移、发布、部署和真实付费 runtime 执行不因本计划自动获授权。当前主仓存在其他任务 WIP；不得接管 downstream-issue-intake 的 harness 状态或修改其文件。

## P1 — Map

- SDK protocol/core/cloud/server/client：执行身份、fresh/resume 契约、准入、可靠消息与持久回读能力。
- Host：Conversation/Turn/产品正文、输入队列、取消接受仲裁、Summary 和业务重试授权。
- Salesko：真实集成测试入口；暴露通用 SDK 缺口，不成为其他下游必须复制的 SDK 内部实现。
- aiphabee：第二个 SDK 使用者；先核实具体调用边界，再关闭复用性验收。

## P2 — Current evidence

本轮 BYOK subject `bb3e1b19ec28d99755e77231dcf39174c2fbe3f8`。CodeGraph 已查询，随后按精确路径回读：

- `packages/server/src/index.ts:596` fresh dispatch 调用 Cloud；`:757` facade tasks.offer 调用 readTaskOffer。
- `packages/cloud/src/cloud.ts:581` offer readback；`:593` canonical terminal receipt；`:606` 明确产品 cancellation projection 可覆盖 result，而原始 device terminal 独立可读。
- `docs/spec.md:114` 起说明调用方预存 execution identity、offer/delivered 恢复边界。

当前核验只证明这些入口存在。消息精确 disposition 的公共组合、facade 与 kernel 的观察一致性、实际 fresh runtime 故障恢复及 packed 消费仍需逐项验收；不能由上述源码定位直接宣称完成。

## P3 — Decision

先从真实 Salesko 场景提取 SDK 验收，再在 SDK 内完成通用公开能力，最后推进下游接入。保持 Host 产品数据权威。不得复制 Salesko 的产品状态机到 SDK，也不得要求每个下游解析 SDK 私有存储格式。10 倍负载下的具体瓶颈尚无测量证据；同 home 串行和有界恢复必须保留，不能提高 cap 回避。

## Task Breakdown

| ID | 工作包 | 关闭证据 | 状态 |
|---|---|---|---|
| K0 | 纠正 SDK-first 交付权威与保存下游候选 | 本计划、原 Sprint 指针、当前 subject/WIP 回读 | DONE |
| K1 | SDK 公开能力与缺口核验 | fresh/resume、同身份 admission、exact message disposition、cancel/terminal/resource 分轴的来源表；真实 Salesko 调用 trace；aiphabee 入口核实 | IN_PROGRESS |
| K2 | 测试先行 | 用 Salesko 场景形成 SDK 边界故障测试；区分现有 PASS、缺能力、Host 责任；不靠私有格式构造虚假成功 | IN_PROGRESS |
| K3 | SDK 实现与契约 | 根据 K1/K2 的已证缺口冻结精确 allowed_paths，补公开 API/实现/spec；不默认扩 wire | IN_PROGRESS |
| K4 | SDK 源码与 packed 验收、提交 PR | required checks、公共导入及打包消费、旧 session 回归、fresh 故障证据；阶段 PR 当前 subject | IN_PROGRESS |
| K5 | Salesko 真实接入验证 | 消费 K4 精确 artifact；复用已有候选证据但移除本应由 SDK 承担的重复实现；A01–A29 逐项归属 | TODO |
| K6 | aiphabee 接入边界验证 | 核实第二使用者需求与公共 API 可消费性，不要求复制 Salesko 产品模型 | TODO |
| K7 | 完整 Host MVP 与总验收 | 原 PRD、原 Salesko S0–S10/A01–A29 保留并逐项关闭；参数、Summary、恢复 UI、真实环境证据不得省略 | TODO |

K0 不是 SDK 交付；K4 不是发布；K5 不是生产部署。跨阶段有可复用证据时先核对 subject，不重复生成昂贵矩阵。

## Current checkpoint

- Owner 最新裁决：recurring chat 按 breaking 产品/API 设计；0.17.0 是既有稳定版本，不以维持其接口形状为新设计前提。版本号在契约收敛后处理。
- SDK Draft PR #181，已推送 head `a21db6c0`。消息 typed 回读是已验证的基础切片，不等于完整 recurring chat SDK。该接口可以随新契约调整，不要求保留刚引入的候选别名。
- 当前执行 worktree：`/Users/kito/Projects/byok-sdk-wt-conversation-turn-sdk-first`。这里的计划是本分支唯一执行账本；主仓副本仅为启动指针。
- 已有证据：全仓 build/typecheck、9 包 API golden、strict workflow PASS；完整测试 3952 PASS / 135 SKIP。SQLite finalize 故障/重开套件 13 PASS；具体命令与 subject 见 notes。跳过项不算通过，不将 fake daemon 当真实 native runtime。
- 未完成：完整 recurring chat 公共契约、严格执行输入、typed execution observation、打包消费、真实 Salesko 接入验证、aiphabee 接入边界以及原 PRD 全部 Host 产品验收。
- Salesko Draft 候选保持不动；只读提取 SDK 测试需求。没有发布、部署或生产迁移。

## Next action

按实施契约的“Recurring chat lifecycle”完成 SDK 接入闭环。先将输入必填不变量和独立执行观察做成类型/运行时故障测试，再决定最终公开入口；不能用新名字包装旧 optional 参数组合就宣布模式完成。aiphabee 入口已回读：byok-host/coordinator → SQLite ByokServer → research-pass dispatch/offer/get。新契约须同时服务 embedded 与 hosted，具体 recurring 产品行为仍不可从 research pass 推导。

Typed device terminal 已实现并完成定向验证：Cloud 9 PASS；server HTTP/SQLite 22 PASS / 2 SKIP；两包 build/typecheck/API golden PASS。完整 recurring 输入与接入契约仍未完成；旧全套测试不能证明本次新增代码。

严格 recurring 输入及两种提交入口已实现，Cloud 19 PASS，server 10 PASS / 2 SKIP；不允许派发时补 taskId 或缺失 required message/context。仍需 consumer 注册门禁、持久输入恢复闭环、完整/packed 验收与下游验证。

consumer 注册门禁和 recurring 同身份投递恢复已验证；当前 Cloud 全套 377 PASS、server 全套 372 PASS / 19 SKIP，API/workflow PASS。下一闭环为实际 tarball 公共入口消费，不再重复同一源码矩阵。

实际 packed 公共消费 PASS：source e78ab5a7，十包 tarball/隔离 npm 依赖闭合及 recurring smoke 通过。临时包已按既有 gate 清理，未发布；不是 stable 0.17.0 的新能力声明。K4 保持 IN_PROGRESS，原始整 Sprint 验收未收窄。
