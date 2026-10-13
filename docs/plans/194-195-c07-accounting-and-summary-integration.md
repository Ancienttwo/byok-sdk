# #194 + #195 计划：C07 首批请求预算与启用门槛、ContextPack → Summary → fresh 回复的集成验收

> 状态：计划草案，只含设计，不含实现代码。不授权读取或修改 aiphabee，不授权生产迁移、部署、发布或付费模型调用。
> 依据：byok-sdk `main@bfa7de5c`；issue [#194]、[#195] 及 owner 2026-10-08 的评论；[docs/spec.md](../spec.md)「Prepared operations」「Bounded admission (2026-09-23)」「Explicit internal result projection under Agent egress」「Recurring Host composition requirements」「0.22.0 Host calibration and upgrade boundary」；[Conversation-turn Fresh MVP PRD](../researches/2026-09-09_conversation-turn-fresh-mvp-prd.md) §9；[Bot 平台 PRD](../researches/2026-10-13_bot-platform-prd.md) §8.1（K5）、§8.3（K7）；[ADR-038](../architecture/adr-2026-10-13-bot-platform.md) 决策 10、12。
> 为什么合成一份：#195 的真实启用依赖 #194 的预算证据，两者的剩余缺口都落在 Summary 这一个执行上，验收也共用同一条链路。

## 0. 结论

- 两个 issue 的大部分 SDK 侧条件已经由后来的 spec 裁定和合并闭合，或者改了形式。真正还开着的 SDK 侧工作只有三项：一张验收追溯表、一个跨 Summary 边界的合成 conformance fixture、以及当前 runtime 身份下 C 的重新标定（需要另行授权的付费调用）。其余缺口属于 Host（Salesko #250、#252）。
- #194 的第一条验收（counted projection、counter revision、遗漏上界 U）已被 2026-09-23 的 bounded admission 裁定改写：P(D) 就是 D，residual 为空，尺寸证据是 `requestBytes`，Host 用 `requestBytes + C + max_tokens <= window` 判断；counter 是可选的收紧项。owner 在 2026-10-08 的评论里确认这仍是现行边界。本计划按这个边界写，不重新引入 counter 门槛。
- Bot 平台 PRD 的 K5、K7 会改动 Summary 的执行形状：K5 把 `recurring.submit` 换成 `executions.submit`；K7 删除 extractor，Summary 从零工具记录变为只含 `submit_result` 的一个工具记录，并随 wire v3 一起切换。所以 `toolManifestDigest` 会变，绑定在它上面的 C 裁定也要重做。**建议：SDK 侧的 fixture 和 C 重标定排在 K7 之后做**，避免同一份证据做两遍；追溯表现在就可以做。

## 1. P1：权威边界

| 事实 | 权威 | 现行依据 |
|---|---|---|
| 准备了哪个确切的 D、它有多大 | SDK daemon：编译器捕获的 D，`requestBytes` 是 D 的 UTF-8 字节数 | spec「Prepared operations」「Bounded admission」 |
| 实际首个请求就是 D | SDK runtime：injected fetch 发送前比较 URL 和 body，漂移即 `prepared_context_drift` | spec「Prepared operations」 |
| 是否装得下窗口 | Host：`requestBytes + C + max_tokens <= window`，超出记 `preparation_context_too_large`（Host 自己的码） | spec「Bounded admission」 |
| C 的取值和适用范围 | Host 的 accounting 裁定，绑定 receipt 的 `toolManifestDigest`；SDK 只检查适用性（`accountingPolicyRef`） | spec「The Host's accounting ruling」 |
| token 计数语义 | provider；counter 可选，只收紧，不作尺寸证据 | spec「The optional count」 |
| Summary 的预算、CAS、调度、质量 | Host | spec「Explicit internal result projection」「Recurring Host composition requirements」 |
| Summary 的执行原语 | SDK：strict fresh、result-document、prepared lane 上零工具 | 同上；`bb999e7b`（tool-less prepared record） |

不在范围内：新的 Conversation store、第二个 scheduler、另一套 serializer、新的 wire 字段（#194、#195 都明确排除）。

## 2. P2：一条真实路径（prepared lane 上的 Summary）

1. Host 判断需要更新 Summary，在自己的库里写一条 durable SummaryJob，冻结源 Summary 版本、目标覆盖前缀 `coveredThroughTurnSeq`、sourceTranscriptRevision 和输入字节（会话 PRD §9.4）。
2. Host 发起 input preparation：`requiredToolsets: []`、`agentMemory: 'none'`，带 Host 的完整 `systemPrompt` 和 `accountingPolicyRef`。
3. daemon 编译 D，记录 `requestBytes`、`toolManifestDigest`、`requestContentTextOnly`，检查 `accountingPolicyRef` 的适用性。缺裁定是 `accounting_policy_missing`，记录不会 ready。
4. Host 读 ready receipt，用绑定这个 `toolManifestDigest` 的 C 和 Summary 自己的 `max_tokens`、窗口做一次预算检查。超出则 blocked，不提交。
5. Host 提交 strict fresh prepared offer：省略 `requiredToolsets`，`terminalProjection: { mode: 'result-document', contract }`，没有 `messageEgress`。
6. daemon 准入时核对 runtime 身份（`preparation_runtime_identity_mismatch`）、工具集（`preparation_tool_set_mismatch`、`preparation_tool_binding_digest_mismatch`），首个请求发送前比较 D。
7. 执行结束，extractor 产出结果文档（K7 之后改为 `submit_result`），`task.complete` 带 `document`。
8. Host 读回设备 terminal，校验来源和内容，按 coverage/version 做 CAS 提交新 Summary。
9. Host 用新 Summary + 覆盖边界之后的连续历史 + 当前输入冻结 ContextPack，再走第 2–8 步的用户 Execution（带 `messageEgress`）。

压力点：第 4 步的 C 是经验标定值（`tasks/runs/20260925-official-pi-c-reprobe.json`，不在仓库中跟踪），只对记录时的 runtime 身份成立；第 6 步之后的 tool-result 续请求不冻结，沿用 Errata 1 E4.4 的已接受风险。

## 3. #194：逐条映射

| # | 验收条件（#194） | 现状 | 剩余工作 | 所有者 |
|---|---|---|---|---|
| 1 | 给出 counted projection、counter revision、coverage 与遗漏上界；不以 body hash 相同当 token 等价 | **形式已改**。P(D)=D，residual=[]，尺寸证据是 `requestBytes`，上界是 Host 裁定的 C；counter 可选（spec「Bounded admission」，owner 2026-10-08 确认） | C 只对 0.87.1 闭包标定过。当前 pin 是 Pi 1.2.0（closureDigest `99b01e3c…`），runtime 身份已变，Host 必须重新裁定并在单独批准的 M5 后重测 C（spec「Prepared operations」） | Host 裁定；重测需要付费调用授权 |
| 2 | Main 与 Summary 各自检查 input、请求字节、输出/推理和窗口；首批证明不推广到 tool-result 续请求或多模态 | SDK 已只接受 text-only D（`request_content_not_text`）；续请求不冻结，风险已记录 | Summary 的独立预算由 Host 实现（#250/#252）。K7 之后 Summary 的 `toolManifestDigest` 改变，需要单独的 C 裁定 | Host |
| 3 | 缺配置、coverage unknown、预算不足、artifact 缺失、target/profile/tool/context 漂移都在准入边界停止 | 已有带类型的拒绝：`accounting_policy_missing`、`accounting_policy_inapplicable`、`residual_not_ruled`、`request_content_not_text`、`projection_digest_mismatch`、`preparation_not_ready`、`preparation_runtime_identity_mismatch`、`preparation_tool_set_mismatch`、`preparation_tool_binding_digest_mismatch`、`prepared_context_drift`；counter 存在时还有 `counter_unavailable`、`counter_coverage_incomplete`。预算不足是 Host 的 `preparation_context_too_large` | **SDK 任务 S1**：追溯表，见 §5 | SDK |
| 4 | preparation 的网络/计数/持久化不持有 Host 行锁；CAS 失败不产生可执行 task；消费端验证首个请求与冻结 artifact 一致 | 首个请求比较已实现（`prepared_context_drift`）。行锁和 CAS 在 Host | 无 SDK 代码工作；Host 证据随 #250/#252 | Host |
| 5 | 同身份 preparation 复用幂等边界；记录计数调用数、准备耗时和 artifact 字节 | 幂等由 preparation record log 提供 | 开销数据在 §6 的 native 验收里记录，不预设目标值 | SDK + Host |
| 6 | 自动故障测试：计数超时、响应丢失、CAS 竞争、artifact 回收/损坏、计数后 serializer 漂移；真实验收另行授权 | 漂移和 artifact 损坏有 SDK 测试；counter 已可选 | S1 里逐项标出已覆盖、缺失或属于 Host | SDK + Host |

## 4. #195：逐条映射

| # | 验收条件（#195） | SDK 侧 | Host 侧 |
|---|---|---|---|
| 1 | 固定 SDK artifact + 固定 Host source，跨越至少一次摘要更新的多轮场景，逐轮保存实际输入快照和可取回的字节 | **SDK 任务 S2**：合成 fixture（§5），只证明状态转换，明确标为合成 | 真实 Host 运行，记录精确 revision |
| 2 | Summary 覆盖已结算 Turn 的连续前缀；recent history 无洞接续；已接受回复在 fail/cancel 后保留；无回复输入带结构化结果元数据 | fixture 断言 Host 侧状态，SDK 只提供执行和读回 | ContextPack reader（Salesko main 已有）+ #252 |
| 3 | 缺历史、缺 blob、授权失败或预算不足时显式 blocked，不截断、不补猜、不改原 taskId 输入、不换模型 | SDK 的不变量：同一 taskId 的 offer 不可改写（spec「Embedded SQLite device and receipt authority」） | Host |
| 4 | Summary 与用户执行同 home 串行；内部结果不调用用户 message consumer，不占 assistant 槽，不从 Live Activity 或 `task.complete.summary` 取正文 | 已有：零工具 result-document offer 不带 `messageEgress`（`prepared-offer-lane.test.ts:530`）；同 home 单 writer | 调度顺序 |
| 5 | 故障注入：Summary 结果响应丢失、Host COMMIT 失败、旧 job 晚到、重复结果、来源/授权失效；exact replay 不重复应用 | SDK 提供 `tasks.deviceTerminal` 和 offer 读回；S2 注入响应丢失和重复 terminal | CAS 和晚到处理 |
| 6 | 验证实际内部任务的 policy/tool 配置，不只靠提示词；覆盖正确性和语义质量分开报告 | 已有：零工具记录以零工具启动，D 不含 tools 键（`pi-prepared-launcher.test.ts:443`）。K7 之后改为只有 `submit_result` 一个工具，测试随 K7 迁移 | 质量评估 |
| 7 | 快照、摘要、SDK transport 副本的存储与回收有明确所有者；被引用的内容不能按年龄回收 | SDK transport 副本的保留随 #411/#412（K1） | Host 存储 |
| 8 | 关闭记录写明 Host 验收项、精确版本、source/packed/native 证据级别和未覆盖项 | §6 的证据格式 | Host 账本 |

## 5. SDK 任务

### S1：#194 追溯表（现在可做，不改代码）

- 产出：`docs/notes/` 下一份追溯表。每个拒绝码一行：触发条件、所在源文件、覆盖它的测试文件和用例名、属于 #194 的哪一条验收。
- 起点（`main@bfa7de5c`）：拒绝码在 `packages/client/src/daemon/input-preparation-service.ts`、`packages/client/src/daemon/prepared-offer-admission.ts`、`packages/client/src/adapters/pi/input-preparation.ts`；每个码至少有一个测试文件引用。
- 判定规则：只引用断言了该码的测试，不把"文件里出现了这个字符串"算作覆盖。缺测试的码列为缺口，另开 issue，不在本计划里补。
- 验证：表里每个测试用 `bun run --cwd packages/client test -- <file>` 跑一遍并记录结果。

### S2：跨 Summary 边界的合成 conformance fixture（K7 之后）

- 位置：扩展现有的 Host 集成入口 `scripts/integration/`（`salesko-recurring.test.ts` 和 `fixtures/salesko-recurring-daemon.ts`），不新建生产 store。
- 形状：一个最小的合成 Host，用 embedded server（SQLite）+ 真实 daemon + 假 provider。至少四轮用户输入，中间触发一次 Summary 更新。每轮保存实际冻结的 D 字节和 receipt。
- 必须断言：
  - Summary 执行用 strict fresh、result-document、没有 `messageEgress`；K7 之后只有 `submit_result` 一个工具。
  - 用户执行的 ContextPack = 新 Summary + 覆盖边界之后的连续历史 + 当前输入，覆盖前缀无洞。
  - 注入 Summary 结果响应丢失：Host 用 `tasks.deviceTerminal` 读回同一个 terminal，不产生第二个 Summary 执行。
  - 重复 terminal 投递：只应用一次。
  - 旧 job 晚到：合成 Host 的 CAS 拒绝它。这一条只验证 fixture 的状态机，真实 CAS 仍是 Host 的证据。
- 标识：测试名和输出都标"synthetic Host"，不能当作 Host 验收。
- 为什么排在 K7 之后：K7 删除 extractor、改变 Summary 的工具面并升 wire v3（PRD §8.3），现在写的 fixture 在 K7 PR 里要整段重写。K5 只是改名，可以先做也可以后做。

### S3：当前 runtime 身份下的 C 重标定（需要另行授权）

- 前提：owner 单独批准 M5 的付费 provider 调用；Host 重新签发绑定新 runtime 身份的裁定，`ruledResidualKeys=[]`。
- 范围：主执行和 Summary 各自的 `toolManifestDigest` 都要有 C。K7 之后 Summary 的 digest 改变，所以和 S2 一样排在 K7 之后。
- 产出：仿照 0.22.0 的标定记录，写明精确的 SDK、Pi closureDigest、compilerVersion、wire 版本、端点和模型、样本数及每个样本的 `requestBytes` 与 `prompt_tokens`。结论只对这个身份成立。

## 6. 关闭两个 issue 需要的证据

两个 issue 都要等 Host 证据，SDK 侧的 S1–S3 只是前提。关闭记录按下面的格式写在 issue 评论里：

| 项 | 内容 |
|---|---|
| SDK | 精确版本或 commit，packed artifact 的 sha |
| Host | Salesko 精确 commit；#250、#252 的状态和 CI 结果 |
| Runtime | Pi closureDigest、compilerVersion、wire 版本、端点和模型 |
| 证据级别 | source / packed / native，分别列出 |
| 未覆盖 | 逐项列出，不并入 PASS |

合成 fixture（S2）通过只能写成 source 级证据。

## 7. 顺序

```text
现在：S1（追溯表）            ──┐
K5 合并（改名）                 │
K7 合并（submit_result、wire v3）├─▶ S2（fixture）─▶ S3（C 重标定，需授权）─▶ Host 证据 ─▶ 关闭 #194、#195
Host：#250、#252（并行）       ──┘
```

## 8. 风险

- C 是经验标定值，不是普遍的 token 上界（spec「0.22.0 Host calibration」）。#194 原文要求"不填经验比例或未经证明的 margin"，和 bounded admission 的取舍有张力；owner 已按 bounded admission 裁定，本计划不重开这个选择。
- 当前 pin（Pi 1.2.0）的 runtime 身份与标定时（0.87.1）不同。在 S3 完成之前，任何生产启用都缺少对应身份的 C。
- K7 的时间不确定。如果 K7 推迟很久，S2 可以先按零工具记录写，K7 PR 负责迁移，代价是 fixture 写两遍。
- Host #252 的 arm64/x64 acceptance checks 仍在失败（owner 2026-10-08 评论），Host 证据是关闭的关键路径。

## 9. 验证

S1 和 S2 的 PR 运行：

```sh
bun run build
bun run typecheck
bun run test
bun run check:api-surface
bun run check:version-authority
```

S2 涉及 release 打包的部分还要运行 `bun run check:release-pack`。S3 的付费调用不在 CI 中运行。

---

**Codex should review this plan before implementation.** 请重点看 §3 第 1 条对 bounded admission 的处理，以及 §5 把 S2、S3 排在 K7 之后的取舍。

[#194]: https://github.com/Ancienttwo/byok-sdk/issues/194
[#195]: https://github.com/Ancienttwo/byok-sdk/issues/195
