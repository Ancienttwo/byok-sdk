# C07 §82 subprocess / source closure boundary review

2026-09-16，Codex 有界只读复核。未修改 scanner、SDK 或 native 产品代码；复用 scanner-semantics 证据，不重跑构建。此报告是建议，不是 Owner 批准或完成验收。

## 结论

**支持修订边界，不支持按当前说明直接删除 subprocess 拒绝并宣称等强替代。**

§27 原文确实要求拒绝非字面 spawn/exec；那条由 Codex 提出的建议把“代码加载闭包”与“执行授权任务”混到一起，需要明确修订，不能把责任全部归为 Fable 误读。iv-b 再把每个 options/callback 都要求静态值，属于实现层进一步扩大。

提案只有在生产调用点按下述三类归属、替代 gate 已接线并通过负控之后，才能称为完整验收边界。不能用新增两条其他拒绝规则，抵销删除规则留下的缺口。

## P1：权威地图

- 安装时 source scanner：最终确定 bundle 的进程内代码加载/生成入口；配合 artifact/build provenance 与依赖闭包证据。
- SDK launch/provenance：受信任 runtime、MCP、helper 的实际最终 spawn，验证所选 interpreter/entry/argv/cwd/env，不能仅验证父进程或配置描述。
- task/tool policy：bash 等已授权任务执行的输入、工具选择与能力限制。此处允许运行时命令不等于证明任意后代程序拥有 installed-record attestation。
- subprocess 若作为受信任实现的代码 loader/codegen（例如从可写路径起解释器加载插件，或把子进程结果作为代码执行）：依然跨越 implementation closure，不能靠改 API 家族变成普通工具调用。

## P2：原文、实现和真实调用链

### §27 的确如此写，不应改写历史

`/Users/kito/.codex/handoffs/handoff-260915-c07-g3b-design-decision.md:381`：

> 须覆盖并拒绝 … 可变子进程（spawn/exec 非字面量），每类给越界负控测试。

因此 Fable 把 non-literal spawn 加入拒绝集并非无中生有。原文没有明确要求 callback、整个 cwd/env object、全部 options 必须语法静态。

### iv-b 实际规则更宽

主体 `/Users/kito/Projects/salesko-new-wt-c07-e` HEAD `375b5316bdb07ae800e6c3615956c21293665462`：

- `apps/local-agent/src/source-install.ts:143–149`：staticValue 对 identifier、spread、callback 都返回 false。
- `:190–198`：Node subprocess 要求首参数 literal 且 args.every(staticValue)；Bun.spawn 也作同类检查。
- `:170`：Bun.$ 无条件拒绝。
- `:171–172`：任意 recognized process.* 动态成员调用都拒，包含 `process.env?.[k]` 这一类不代表代码加载的目标。
- `:188–189`：WebAssembly 只覆盖 instantiate/compile；Module/Instance 构造没有对应分支。

复用 `/private/tmp/claude-501/-Users-kito-Projects-byok-sdk/be028169-eaee-4f98-8263-7bdcca465dd6/scratchpad/scanner-semantics/out-A.txt`：a3 非静态 spawn 拒绝；a4 合成静态对照通过；a17 `new WebAssembly.Instance(new WebAssembly.Module(bytes), imports)` 零命中。未重跑或把合成样本推论为完整闭包证明。

### P1 尚不能证明替代门已经工作

使用固定 commit **7118c8f1** 检查，避免把 rebase 中工作树当冻结交付。`git grep -n decideRuntimeLaunch 7118c8f1 -- packages/client/src packages/keys/src` 仅返回函数定义与测试调用。

`packages/client/src/daemon/tool-implementation-identity.ts:1720–1741` 明确是 pure decision，不读取/量测；`:1427–1442` 的通用 reverify helper 对 undefined/unavailable 不阻止 spawn。P1 是必要的契约能力，但 P2/P3 生产消费与 fail-closed 接线还不能算已完成。

真实反例路径：native `packages/coding-agent/src/core/tools/bash.ts:342–346` 将 task command/cwd/env 交给 ops.exec；`:80–101` 直接 spawn(shellConfig.shell, args+command, {cwd,env})。它不是 PiAdapter 的 runtime spawn，也不会因为 runtime subject 类型新增而自动受其 reverify。git/rg/fd、版本探测、memory helper、keys child、subagent 同理，必须分别定位消费者，不泛化。

## P3：建议修订为三个可验证的集合

| 集合 | 权威与规则 | 验证要求 |
|---|---|---|
| 基础设施进程：runtime/MCP/helper/credential launcher/预检 | 对该角色适用的 trusted executable/OS-base 规则；实际最终 spawn 接 SDK measurement/reverify，绑定 interpreter 后的 entry 与固定前缀，不只 hash shell | 每个可达 spawn 映射到 gate；替换 artifact/interpreter/entry 或 env/cwd 漂移，必须在执行前拒绝；未配置路径不可假称 attested |
| 显式 task/tool 执行：bash 等 | command/args 可以运行时生成，由已批准 task/tool policy 授权；不宣称执行的任意文件或所有后代属于 release code closure | 各 mode/policy 的拒绝和正向任务测试；不得以该类身份运行未验证的基础设施组件 |
| 为可信实现载入/生成代码的子进程 | 仍是 code closure 边；需 sealed code 来源及对应 gate，不能凭“spawn 被移出扫描器”豁免 | 未声明脚本、可写路径插件、解释器 -e/entry 作为实现加载通道等负控，不可借任务工具通道绕过 |

扫描器可以取消“全部 subprocess 参数语法静态”的统一拒绝，但须保留可达 subprocess inventory，并由同一验收包给出上述分类/调用点映射。静态扫描不应伪称能从任意 JS 自动推导这种语义；未分类调用点阻塞验收，由 implementation review + 实际 guard tests 证明。完成标准不是 grep 计数归零。

这不是“完整 daemon+Pi 与安全必须二选一”：与正常功能冲突的是当前字面性规则。若坚持旧规则原样，全功能确实不能过；仍有明确权限/身份分层的第三条路。修改的是安全承诺的精确定义，不能只叫命名整理或无损迁移。

## 两项 scanner 修正的边界

1. `process.env?.[k]` 不应仅因 computed property 被视为 loader。收窄时保留 `process[k](...)`、别名及解构后的未知 loader 选择拒绝；仅匹配字面 `process.dlopen/binding` 会漏掉 computed 调用。也不能借该修正删掉 vm、module、Bun 等其他 namespace 的未知成员守卫。`process.binding` 本身若列入拒绝规则，也要有直调与别名测试。
2. `new WebAssembly.Module/Instance` 属于已有 WebAssembly 代码执行边界的漏检，补拒合理；至少覆盖全局/别名/嵌套构造与真正初始化字节的负控。拒绝字面字符串构造形态并不自动证明所有反射调用已覆盖，保留现有局限说明。

静态 literal import/require/resolve 也不自动等于 sealed：扫描器不跟随依赖图。最终 emitted bundle + 所有允许的依赖边仍须由构建闭包证据约束，不能用 barrel 入口零命中冒充完整图通过。

## Photon：独立产品边界，不随 scanner 修改自动批准

将 Photon/WASM/Worker 从 sealed entry 的构建图删除，是功能路径变化；必须说明影响的是图像输入读取、resize、返回图像还是单一实现，不能仅称“图像工具排除”而宣称完整 Pi 支持不变。Owner 尚未批准该缩减。

WASM 是可执行代码组件，不能沿用“非可执行 assets”命名绕过闭包。既有 Worker 规则也不自动授权移除依赖它的产品能力。建议本次决定不包含图像能力删除；先列清能力损失与保留能力的有界方案，再单独交 Owner。如采用组件模型，要显式改相应规则/身份/验证，不能恢复 cwd fallback。

## 给 Owner 的具体建议

批准修订 §27 的 subprocess 边界：静态门检查进程内代码来源；基础设施启动由最终 spawn 身份门；任务命令由既有 task/tool policy；实现代码加载子进程仍受闭包约束。取消全参数静态字面要求的实现只能与调用点分类、生产 gate 接线及负控一起验收；P1 单独不足。同步修复 env 误报和 WebAssembly 构造漏检；不包含删除图像能力，不含 push/merge/publish。

需要这次裁定的原因是 §27 明确要求旧拒绝规则，且提案涉及 attestation 的承诺范围；不是例行内部重构。当前仅呈建议，未改变现行 gate。
