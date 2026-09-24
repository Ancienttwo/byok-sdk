# Recommendation

**不能现在停 fork。建议 P0 先留在现有 fork，官方迁移停在接口缺口处；不阻塞整个 P0 等上游，也不建设长期双运行线。** 本结论来自 0.87.1 实际 npm 包和离线行为，未读取另一轨意见。不是依赖切换、上游提案、发布或生产启用授权。

七项裁定为 **C / B / B / B / A / A / B**。A 仅表示该项公开能力成立，不代表整条 BYOK prepared 链通过。

# Why

P1：Host 仍拥有历史、预算和准入；BYOK 拥有设备执行、消息恢复、custody 与安装身份；官方 Pi 拥有 Session、模型循环和 provider serializer。迁移方案 §3、§7–8 禁止降低 task-free preparation、完整历史和冻结请求的保证。

P2：实跑链为 `createAgentSession → ModelRuntime.registerProvider(streamSimple wrapper) → 官方 pi-ai/api/openai-completions → scoped fetch`。只从公开 exports 导入；未复制 serializer。另由 `SessionManager.inMemory().appendMessage()` 导入历史。

P3：(inferred) 停 fork 的充分条件是全部必需语义能通过公开面闭合，而不是包能安装或一次 Session 能完成。当前纯编译与无模型出处的 assistant 历史仍有实质缺口；P0 是既有用户 Turn 契约的执行接线，留在有界 fork 上是最小变化。

## 七项判断

下文 `P` 为 `/private/tmp/h5-salesko-prep-20260923/op0-codex/node_modules/@earendil-works`。`CA` = `P/pi-coding-agent`，`AI` = `P/pi-ai`；均为实际安装的 **0.87.1**。

| 项目 | 裁定 | 当前证据与缺口 |
|---|---|---|
| task-free 离线编译 provider 请求体 D | **C** | 没有找到满足现行纯阶段契约的公开编译入口。公开 `stream` 内部先解析认证、创建 client，再调用未导出的 `buildParams`，随后调用 `onPayload` 和 transport（`AI/dist/api/openai-completions.js:151,181–201`）。`onPayload` 捕获是运行 stream 的观察点，不是纯 compile API；Session 还会追加 cwd framing。fork 的两个 prepared 子路径在官方实际包均报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。公开 createProvider/createModels/createAgentHarness 能做配置或 task-free 构造，但没有产出完整 D 的纯入口。单纯缺同名 export 不是全部论据，调用链和纯阶段要求共同构成缺口。 |
| 授权历史注入 | **B** | 用户历史、Summary 标记、中文和 CRLF 经公开 `appendMessage` 保持进入请求；普通 Pi assistant 消息也有导入类型。但 Host 只有 accepted 文本时，没有可表达“无模型 usage/provenance”的 assistant 类型。`AssistantMessage` 要求 api/provider/model/usage/stopReason 等（`AI/dist/types.d.ts:349–374`）。最小 assistant 负控不造这些字段，结果为零 fetch、`totalTokens` 缺失错误；补零 usage/虚构来源不是合法替代。 |
| 实际发送字节等于 D | **B** | scoped fetch 可从公开 Session 通过 provider wrapper 接入，捕获最终字符串 body；每次 body 与当次官方 payload 序列化一致。拒发 fixture 只触发一次拦截，无网络，返回 error event。**这证明最后发送边界可控，不证明预先独立产出的 D 已被消费**，因为第一项尚缺。拒发异常被包装成 `Connection error.` 且 `prompt()` 正常 resolve，BYOK 必须根据事件/自身 gate 决定处理，不能只 catch Promise。 |
| usage 观测 | **B** | 合成返回 17 input + 3 output，公开 `message_end` 看到 20 total；两次工具循环可逐次观测。但无 usage 的响应仍成功结束并带全零 usage。源码先填零，再在存在 chunk usage 时覆盖（`AI/dist/api/openai-completions.js:161–167,353–371`）。仅看 terminal Usage 无法严格证明“provider 确实报告过”，不能把零当真实观测或把零一概当缺失。 |
| 工具策略与注册 | **A** | 公开 `tools/excludeTools/noTools/customTools` 足以让 BYOK 投影允许集合（`CA/dist/core/sdk.d.ts:27–47`）。实跑仅注册并启用 `echo_fixture`，一次合成工具执行、两次模型 transport 调用；无内建 shell 工具。A 不代表 OS sandbox、D2 或冻结工具身份自动成立；这些仍由 BYOK 做，且 prepared 工具等价依赖第一/三项。 |
| opaque BYOK provider、compat、thinkingLevelMap | **A** | `ModelRuntime.registerProvider` 和公开 provider 配置保留这些字段（`CA/dist/core/provider-composer.d.ts:16–40`）。使用 `opaque_profile_7e9c`，显式 API/baseUrl，无厂商推断；实测 compat 禁止 store/developer、选择 max_tokens，`high→low` 映射使最终 `reasoning_effort=low`。API 凭证仅合成 fixture，未读取真实凭证；实际 custody 仍须 BYOK 单独接线验证。 |
| 打包与身份 attest | **B** | 三个官方 tarball 的 SHA-512 均与 npm pack 及 lock integrity 相同，root exports 可加载；官方包有来源/依赖闭包证据。但这不等于现有 S2/sealed bundle、装载与多平台 gate 已通过，也未验证 provenance 签名链。SDK 仍硬查 byokFork 和 prepared entry（SDK `scripts/release/pi-runtime-identity.mjs:26,135`；`packages/client/src/adapters/pi/input-preparation.ts:269,325`）。需合法修订为官方 exact artifact＋闭包＋BYOK adapter 身份，不能伪造 fork/nativeProvenance。官方 `./client` 在默认 Node 条件下也不可导入，不能因 package.json 列出就假定可用。 |

# 最小上游缺口与绕过边界

1. **纯准备及首请求契约**：公开无 I/O、无 Session/业务执行的完整首请求编译；必须包含 Session framing、历史、工具、model/options，并绑定 serializer 版本/身份。支持既有循环消费冻结首请求，或允许 BYOK 通过已证明的 scoped fetch 严格比较并拒发。(inferred) 不应要求上游理解 tenant/Turn/receipt；也无需为已经可用的 scoped fetch 另造通用 transport 框架。
2. **Host-owned assistant 历史**：公开类型/导入路径允许 accepted 文本没有模型出处和 usage，且所有上下文计量、重放、serializer 都理解该类型；不能仅令 TypeScript 强转通过。
3. **usage 是否确实出现的公开事实**：给逐请求 usage-present/source marker 或独立事件，以区分初始化零与 provider 的真实零；这对应现行 `usage_unavailable` 契约。不能在 BYOK 再写 SSE 语义解析器来制造第二个 usage 权威。

前两项足以阻止现在退 fork；第三项也必须在 E4 等价验收前闭合。上游缺口清单是咨询结果，**没有提交任何请求或补丁**。

- private deep import `buildParams`、修改安装包/patch-package、复制 provider serializer：违反迁移方案，拒绝。
- 给 Host 文本补假 api/provider/model/usage，或改成 user/custom 角色绕开：伪造元数据或改变历史语义，拒绝。
- 运行临时 Session、截获请求后 abort，宣称 pure preparation：违反纯阶段/无副作用要求；本次 mock SSE 只作测试。
- 从公开 provider wrapper 注入 scoped fetch，限制目标、body、次数、取消并拒发：**不违反禁令**，本次已验证接入；但单独不能补齐独立 D 编译和历史类型。
- 合法修改 BYOK 安装/身份 gate 以记录真实官方来源：不属于伪造；删掉能力校验、给官方包补 byokFork/nativeProvenance 则属于伪造。
- 用户工具集合通过公开 API 投影、关闭默认资源发现：合法。不能因此宣称现有 sealed 装载/递归/workflow 已验收。

# Failure mode at 10x

(inferred) 首先放大的是重复构造 Session 的准备成本、隐藏 framing/资源变化带来的计量漂移、缺 usage 被当作真实零，以及拒发被普通重试错误包裹后的重复执行风险。继续扩建 wrapper 以补 serializer/历史语义会重新形成隐性 fork。P0 应只补现有 prepared＋message egress 的最小契约，不顺带扩张 fork 功能。

# Required verification 与本次实际证据

- 安装、tarball、脚本、输出全在 `op0-codex/`。Node `v24.18.0`；三个目标包固定 `0.87.1`；官方 tag 为 `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`。npm metadata、完整 lock 与 `artifact-evidence.json` 可复查。来源证明不等于 tag/npm 可复现构建证明；tag 的 provider 数据需构建生成，不能借 fork 工作目录已有文件补成官方证据。
- 行为探针在 macOS `sandbox-exec -p '(version 1)(allow default)(deny network*)'` 中执行；6 个场景、6 次 injected-fetch 调用、1 次 synthetic 工具执行。**零真实 provider 调用**；正常及工具请求边界字节相符，历史/usage 的负向结果如表。`verification.json` 固定探针及结果 hash。
- `probe.mjs` / `probe-result.json` / `probe.stdout` 是最终结果；`probe-v1-result.json` 是初次探索：直接改 agent state 会被 Session 历史恢复覆盖，**不能用该文件宣称历史通过**。最终探针使用公开 SessionManager 注入。
- 本次未修改仓库、未 commit、未跑全仓/native/S2/真实 credentials/真实 provider 验收。合成 usage 与 mock fetch 不是 provider 行为证明。
- 后续替代 gate：公开纯 prepare→同一首请求字节、无出处 assistant 全链、真实 usage 缺失负控、D2/required-message 故障恢复、完整包闭包/S2/递归/workflow/平台矩阵。仅当这些能力闭合，才重新提议依赖切换。

# Confidence

**HIGH：现在不能退 fork、P0 先留 fork。** 对公开工具/provider 接入的结论有实际 npm 离线证据；未验证面的判断保持 B，未将其当作不可实现。官方消息类型亦可交叉核对[固定 tag 的公开定义](https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/types.ts#L515)。
