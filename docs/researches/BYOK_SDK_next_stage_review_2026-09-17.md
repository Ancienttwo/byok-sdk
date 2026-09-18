# BYOK SDK 当前状态复核与下一阶段开发方案

日期：2026-09-17。性质：只读审查与建议方案，不是产品修改、合并、发布、部署或付费推理授权。

## 1. 审查边界与基线

- 当前 main 读回：`601a1991da6c0c0353d4d059cdc851f457e79d93`。
- 本次重点审查的 PR #193：`codex/c07-pi-runtime-launch`，head `d4dcf96105d9115a253c9f9ca419d922014f605c`，open、Draft、未合并。
- PR 正文仍记录旧 `7ae976ad` 的 alpha 验收，不能当作新 head 的完整验收凭据。
- 精确候选 CI：run `35177371443`，23 jobs，21 success、2 failure；两项失败均为 Windows。job 通过只证明该 job 覆盖的场景。
- 本轮通过 GitHub connector 读取代码、契约、计划、review、CI job 和两份失败 job 原始日志。未在本地重新执行模型、递归运行、S2 或安装验收；未核验未推送的本地 gate 记录；未独立读取最新 Salesko/native 仓库。因此有关这些仓库的进展只按 SDK 已提交记录表述。
- 没有修改仓库、issues、PR 或 CI。

## 2. 核心结论

“已完成部分切片，但 SDK 整体未完成”成立；“所有已授权且无阻塞切片均已验收”不能由当前远端记录全部证明。

最新 record-aware detection 的产品候选已经实现，执行者矩阵和 fixture 修复有记录，但 `tasks/reviews/20260917-c07-record-aware-detection.review.md` 的结尾仍为 independent gate PENDING。需补齐正式验收回执，而不是把设计批准、代码完成、执行者测试和独立验收混成一个状态。

SDK 剩余的主路径是：native/装载闭包 → custody 五项执行约束 → print/runner 五边真实接线 → S2 containment → 正式 SDK/Host/native 构建组合。完整持续对话产品还需要 accounting/S0/Host CAS/ContextPack/Summary 等既有工作，不能因递归切片通过而一起关闭。

### 2.1 逐项核对

| 用户提供的说法 | 本次复核 |
|---|---|
| recursive runner/print 尚未启用 | 确认。`sdk-reserved-helper-host.ts` 对两个 helper 名直接抛出 not-enabled 错误。不是仅缺文档。 |
| custody 五项未全部闭合 | 确认。已有严格 parser、plan、模板和物理校验，但文档明确这些不证明跨进程 fanout、同 session 排他、实际 parent transition、permit 和 root custody。 |
| S2 仍有 jiti+clipboard 24 红项 | 仓库最新局部验收记录仍如此。24 是 registry tripwire 访问尝试数，不是 24 个独立漏洞，也不是完整 scanner 只剩这两类。未在本轮重新运行。 |
| 全是 synthetic，真实验证完全没有 | 需要限定。已有真实进程、原始 CI 和包构建证据；但 S2 的 owner uid seam、synthetic record 和 startup-only get_state 不能证明正式安装权限、真实递归和正式 Host 组合。 |
| 两项 Windows CI 失败未修 | 对精确 head 的当前 run 成立，且两项失败已有不同的明确日志表现。 |
| 所有当前切片均已独立验收 | 最新 detection 的远端 review 仍 pending，不能直接确认这一总括说法。 |

### 2.2 已经决定，不应重新开启的选择题

1. sealed structured-output 采用 alpha：明确拒绝有效 structured-output 请求，不把未验证正文当成功结果；普通文本 subagents 保留。
2. scripted workflow 必须保留在首个 sealed release，待其执行/装载闭包完成并验证后启用；不能为了 scanner 通过而删除功能。
3. Salesko P4 本地实施已有记录中的批准，基线 `375b5316`（含 `95aa478d`），不等于推送、合并、部署或组合验收已经完成。
4. Host 仍是产品 Conversation、Turn、Summary、队列、正文与业务动作事务的所有者。SDK 不新增平行 transcript store，不自动改 fresh/resume。
5. 递归使用四个 kind、五条允许边，prepared 无后继边；不以 in-process print 替换已选 subprocess 架构。

## 3. Windows 失败的具体诊断

### W1：built adapter lifecycle，job 105061927551

实际日志：Claude/Codex 正向完成；Pi 的缺 launcher 负向用例也通过。Pi 正向用例失败：

```text
runtime launch admission failed: Pi process cwd unavailable: platform_default_is_writable
```

失败位置是 `packages/client/scripts/adapter-task-smoke.mjs` 的 Complete 断言。该 job 在管理员 runner 上运行，安全检查拒绝可写的默认启动目录。当前证据首先指向正向测试环境与准入前提不匹配，不应通过放松目录检查来使它变绿。

修复方向：将支持的正向 lifecycle 放在真实非管理员 token、经过独立负控验证的受保护启动目录下；管理员/可写目录保留单独拒绝用例。不要把 Pi Failed 改成也算正向通过。

### W2：Windows 非管理员 release-pack，job 105061928133

实际日志确认非管理员 token、Medium integrity，以及 C:\\Windows/C:\\ 不可写。`trusted-launch-cwd.test.ts` 为 24 PASS/3 SKIP。随后 keys suite 尚未运行断言，就因以下 import 错误退出：

```text
Failed to resolve entry for package "@byok-sdk/implementation-identity"
```

`implementation-identity/package.json` 的公开入口指向 `dist/index.js`。CI 在 keys 前置测试之后才进入 `pack-and-smoke.mjs`，而前置依赖构建没有出现在这条已读路径中。优先排查、补齐干净 checkout 的构建拓扑和产物可读性，不用测试 alias 指向 src 来掩盖公开入口缺失。此轮根本未到实际 pack/install，不能把错误描述成包安装后 Pi 已失败。

同份日志还显示清理阶段访问了临时 `root-link` 下的系统目标路径。这里只能确认清理发生了越出临时树的路径遍历迹象，不能推断已经修改系统 ACL。修复时须让符号链接/junction/reparse point 的清理不跟随目标；用受控树外 canary 验证 ACL 和内容未变化，不拿系统文件作试验。`icacls /L` 对符号链接本身操作，但各种 reparse 类型仍需实际验证，不能只加一个参数就宣称全闭合。

## 4. 阶段目标与依赖

本阶段主目标建议命名为：**SDK Recursive Runtime & S2 Completion**。

```text
G0 最新 evidence 回执 / 精确基线
 ├─ W1/W2 Windows CI 环境、构建与清理修复 ───────────────────────┐
 ├─ N native1006 所需接口、静态装载与资源闭包 ────────┐        │
 └─ C custody 所有权、跨进程原子准入与崩溃语义 ───────┤        │
                                                   ▼        │
                                  R print → runner → 五边集成 │
                                                   ▼        │
                                      S S2 强制门槛与全闭包   │
                                                   ▼        ▼
                                  I 正式 SDK/Host/native 组合验收
                                                   ▼
                                  SDK 本阶段完成（不是自动发布）
                                                   ▼
                     既有 #194/#195：预算 / Host CAS / ContextPack / Summary
```

Windows、native、custody 可以分支并行。真实 Host 组合需要已冻结的 SDK/native artifact；Host 的记录生成和测试准备可先推进。不能因为一个外部发布门槛，停止所有不依赖它的测试/实现。

## 5. 详细工作包

### G0：关闭最新 detection 的验收账本，而非重做设计

**输入**：产品 `9f697036`，discovery `d5949148`，fixture 修复 `c5c5e081`，当前 docs head `d4dcf961`；以真正测试的 SHA 为准，不直接合并成一个“全 PASS”。

**现有记录**：最终 client 2801 PASS/1 inherited S2 FAIL/11 SKIP；combined 5172 PASS/1 inherited FAIL/141 SKIP。全部是仓库记录，本次没有重跑。

**实施**：回收独立 gate 结果并绑定源码、artifact、命令和原始日志摘要；补齐 build/typecheck、routing/strict-result、physical parity、host binding、goldens、strict 和真实 release-pack 的已约定独立检查。执行者已做全矩阵且未变的部分按字节复用，不让 reviewer 无理由再跑一遍全仓。

**路径**：既有 record-aware detection plan/review/notes、`runtime-detection.ts`、`adapters/pi/installation-observation.ts`、相关 routing/observation tests；产品只在真正发现缺陷时修改。

**关闭标准**：独立 PASS 或明确列出尚未关闭项，PR 正文与最新 head 一致；安装观察不能转型成 spawn authority，read-only cwd observation 不能宣称 ACL 不可写。

### W：先让两项 Windows 信号可信

**路径**：`.github/workflows/ci.yml`、`packages/client/scripts/adapter-task-smoke.mjs`、现有 launch-cwd/keys Windows tests；最小必要的构建脚本。

**步骤**：
- 用新账户验证 token、integrity、用户目录和受保护 launch cwd；保留可写目录拒绝负控。
- 在前置 keys suite 之前完成需要的 workspace dependency build，并验证公开 dist entry 在非管理员 token 下可读。
- 在干净 checkout 运行真正的 pack/install、公开 import 和 MCP tools/call，不用旧 dist 或缓存碰巧通过。
- 隔离账户、目录、测试进程及清理所有权；先移除本轮链接本身，再对本轮拥有的真实目录回收权限，避免递归跟随目标。

**关闭标准**：同一冻结 SHA 的两个 job 均达到预定断言并通过，negative controls 仍红转拒绝，cleanup 无越界。不得提高权限、改成 continue-on-error、减少正向断言或把缺失测试文件当通过。

**额外平台门槛**：Windows 正式 attestation 不能由 POSIX uid/mode 推断成立。当前 `measureOwnership` 可见 uid=0/writebits 检查；需追踪完整 Windows 调用路径并提供真实 DACL/owner/reparse 等效证明，或明确拒绝不支持路径，不能用 synthetic uid 接受正式安装。

### N：收口 native1006 所需接口和静态装载闭包

“1006”是依赖目标标识，不是完成证据；实际验收以精确 native 源码和可取回 artifact 为准。

**最小功能组**：
- 公开、稳定、可静态导入的 export-html 接口；五份已有 export 资源保留 provenance/hash/layout。输出绝对路径与授权目录规则由一个原生权威实施，不在 SDK 复制另一套路径解析器。
- sealed 构建关闭 jiti、computed loader、非授权包发现/自动安装；clipboard 的隐式依赖访问消失但用户已承诺功能不能无批准删除。
- 固定 RPC schema 的运行时代码生成单独收口；可优先评估构建时生成固定 validator 的方式，保持协议验证语义，不与用户 structured-output alpha 混为同一问题。
- print startup 单独测 theme、locales、skills、实际文件读取和信号/退出行为；RPC get_state 不作替代。
- native 源图、SDK bundle 图和 Host 最终图共同说明 code、data、WASM、worker、可选 provider 分支的来源；不可把可执行资源改名为 data 逃过 scanner。

**scripted workflow 专项**：先用真实可达调用链固定现有语义，包括前台调用、子任务派发、取消、timeout、错误和可用全局。支持保留已决定，待解决的是在现有 sealed 规则内如何执行。推荐先评估静态绑定解释执行或等价的预构建机制，并做契约覆盖与差异测试；语料通过不等于任意 JavaScript 语义已证明。若现有功能与禁止动态执行的规则发生具体冲突，提交最小反例和窄机制选择，不能自行把 VM/Worker 加白、搬到免扫描新进程，或删除 workflow。

**关闭标准**：所需公共接口、资源策略、许可/原始源码及变更 manifest、source/bundle scanner 和非模型真实进程测试均绑定同一 artifact；本地 artifact 可用于隔离集成，但 registry publication 的授权与验证单独处理。

### C：custody 五项落到真正的进程准入点

**原则**：复用一个 daemon-issued plan、一个共享 descendant validator、一份 root budget 身份。不要创建新的产品级 scheduler、并行 Conversation authority 或仅靠子进程 env 的预算。

**主要路径**：
- `packages/implementation-identity/src/descendant-launch.ts`、`identity.ts`；
- `packages/client/src/adapters/pi/runtime-descendant-plan.ts`；
- 现有 vendor 中 `runs/shared/run-fanout-budget.ts`、`spawn-budget.ts`、`parallel-utils.ts`、`shared/workflow-child-permit.ts`、`runs/background/async-execution.ts`、`runs/foreground/subagent-executor.ts`；
- 新 runner/print 入口需先登记精确路径、依赖闭包与 vendor delta，不能由旧 inventory 推导全目录写权限。

| 约束 | 必须实现 | 必须通过的真实执行反例 |
|---|---|---|
| C1 fanout | 原子 claim/cap/rollback，记录具体父实例和逻辑委派；跨进程共享同一 root 预算 | 用显式小上限同时竞争 N+1 个请求；不能多启动一个。失败前/失败后分界确定，重复 rollback 无双退额度 |
| C2 session 与并行槽 | 同一规范 sessionFile 独占；并行槽是另一个可释放资源；真实存活 writer 未清理不能释放 | 两个进程竞争同 session 只有一个 writer；另一个 session 可在额度内运行；close 失败不假释放 |
| C3 charge-once | 逻辑委派扣一次；runner→print 零额外深度 charge；实际 parent transition 不能由 config 自报重置 | rpc→runner→print 与 rpc→print 等价扣费；depth 伪造、root 重置、重试换 namespace 在 spawn 前拒绝 |
| C4 consumable permit | available→claimed→consumed 的授权和 reusable semaphore 分离；显式生产 issuer/claim/consume 调用点 | claim/consume/spawn/cancel 边界故障；相同 permit 不可第二次使用；取消不自动退还已消耗授权；并行槽按 quiescence 释放 |
| C5 root/parent custody | 已验证父状态生成 parentInstance、depthRemaining、policy 与 root identity；config hash 只作一致性绑定 | sibling config 互换、伪造 parent、提高 policy、建立新 root 绕预算均拒绝；合法后继仍可执行 |

**崩溃规则**：先冻结 state ownership 与 phase：请求未准入、准入但未 spawn、已 spawn、终止待确认。对明确未发生的动作才按契约 rollback；对 ambiguous spawn 保留权属并对账/隔离，不能因 timeout 或 PID 查无就自动启动替身。重启恢复保留原 root/permit/claim 身份，不能把新进程当新预算。

**实现选择**：先验证已有 file-lock/lease/permit 机制能否覆盖跨进程原子性与崩溃；只有出现明确无法覆盖的反例，才追加最小协调实现。不要一开始就引入第二数据库或独立常驻 scheduler。

**关闭标准**：五项都有真实调用点、独立父状态、正确同步资源与真正多进程测试。parser/vector PASS 只能作为底层单元证据。

### R：print → runner → 五条边，一次切换启用

**顺序**：
1. 先实现 print helper 的独立子进程入口，但生产 dispatcher 仍拒绝新 kind；验证 sealed cwd 下的资源、stdout、信号和退出。
2. 再实现 same-bundle runner；替换旧 Node+jiti/动态发现，使用冻结 interpreter/artifact/prefix/cwd/assetRoot；runner→print 经过真实 descendant assertion。
3. 接齐 rpc→runner、rpc→print、runner→print、print→runner、print→print。prepared 无新增边。
4. 所有边完成与 custody/N 前提满足后，在唯一 M2b-3 cutover 中启用 dispatcher，不发布 runner 可用、print 不可用的中间产品，不自动将 maxDepth 降为 0。

**不变项**：Host record codec 与原 SDK template JSON codec 不混用；config 写一次、hash 同一字节；candidate 不能以自己提供的 policy 证明自己合法；凭证值不得进入 config/hash/log，MCP 后代仍只得明确剥离凭证后的环境。

**取消/模型候选**：重试同一逻辑 job 不重复收费，但每个模型候选及最终 spawn 重新验证精确绑定。不得为候选切换新增隐式 secret lookup 或 provider fallback。取消应停止受控后代并取得真实清理事实；不让父流程退出留下 writer。

**关闭标准**：S1 installed Node 与 S2 sealed 均运行真实递归/取消案例；五边无静默发现或旧执行路径。真实进程＋本地合成 provider 响应可证明生命周期，但不称为真实付费模型验收。

### S：把 S2 变成不可跳过的正式验收

当前 `pi-s2-bundle-resolution.test.ts` 通过指定 env/几处固定路径找 Bun，找不到则 `skipIf`；其 fixture 还对 release 树使用 uid-only seam。这些必须在正式 gate 中显式排除“看似绿但没运行/没证明安装”的可能。

**实施**：
- 正式 job 使用经过验证的绝对 Bun 路径，记录版本/hash；缺工具、零匹配、skip 均让正式 gate 非成功，不改开发者可选测试的便捷性要求。
- 原 registry tripwire 零尝试断言保持；jiti/clipboard 分别归因，不改成只要求“没有成功安装”。
- 空 HOME/cache、无安装依赖、受控 registry、出口审计；验证 ordinary/prepared/runner/print 及已批准 scripted workflow 可达面。
- 主动负控证明监视器有效：人为引入已知违规访问应被捕获；不能因为所有功能路径没执行而得到零访问。
- S2 与原 scanner 两个门同时通过：零 registry 请求不能替代源码装载/代码生成闭包证明。
- 正式安装权限另用真实 OS owner/ACL/read-only record 构造，无 uid mock；原 synthetic fixture 继续保留但分级标注。

**关闭标准**：jiti=0、clipboard=0、无未授权 cache/escape/auto-install、原 scanner 没有未闭合违规；功能与拒绝负控均运行。已知 24 次归零是必要条件，不是所有条件。

### I：真实 SDK / Host / native 构建组合

**输入必须成组冻结**：SDK SHA、native SHA/version/integrity、SDK tarball hashes、Host source/build recipe/hash、installed release-record revision、目标 OS/arch/Node/Bun、显式 descendant policy。测试数值不变成生产默认。

**实际链路**：Host 正式构建选择 sealed 私有工厂 → 安装记录/权限 → SDK observation（只读）→ launch admission（完整权限与物理重验）→ ordinary/prepared → recursive helpers → 状态/结果/取消 → 重启后的公开恢复。

**必要反例**：缺 reachable kind、错误 SDK/native/version tuple、被替换 artifact/asset/interpreter、profile/policy/source 漂移、错误 Host build redirect、错误 cwd、提前删引用对象、父进程终止与子进程仍存活。

**三种证据分别出结论**：
- E1 synthetic shape/validator：类型、codec、refusal、状态转移。
- E2 actual processes + controlled provider：启动/递归/权限/取消/传输，不需要调用真实模型。
- E3 actual installed Host/native/artifact + 经批准的真实 provider：真正组合、计数与目标运行时。

E2 能提前推进，不必全部等待模型费用授权；但不能冒充 E3。正式部署、升级/回滚与 registry release 另有授权边界。

**关闭标准**：同一组合 tuple 下，detector 的事实来源、launch 的权限证明、实际执行、独立恢复都能对账；不使用 synthetic 安装身份顶替。

## 6. 最小真实进程验收矩阵

这些是建议的语义族，不是固定测试总数，不做不必要的全排列。

| 族 | 场景 | 断言 |
|---|---|---|
| F1 | 五条合法边与 prepared 无边 | 合法链运行；非法边在 spawn 前拒绝 |
| F2 | 深度 0、到上限、超过上限、runner→print 零 charge | 仅逻辑委派收费，不重置父深度 |
| F3 | fanout cap、并行竞争、grant 上限 | 原子性、无超额、无溢出、重复回滚安全 |
| F4 | 同 sessionFile / 不同 sessionFile | 单 writer 与并行额度互不混淆 |
| F5 | permit 已 claim/consume 时取消、重复提交、重启 | 不重复消费，不自动退款授权，不多运行 |
| F6 | claim 前后、spawn 前后、结果前后杀父/子进程 | 保留或对账不确定事实；无 orphan writer/错放 lease |
| F7 | policy、parent、root、模板、artifact 漂移 | 拒绝发生在实际 spawn 前，真实校验未被 fixture 代替 |
| F8 | 凭证继承与 MCP 环境 | 仅授权模型后代继承；MCP 无 provider 凭证；日志/config 无 secret |
| F9 | print resources/export/locales/workflow/alpha拒绝 | 功能不被静默删除；负控仍生效 |
| F10 | S2 监视与 scanner | 零违规尝试、零未闭合 loader；缺工具或 skip 不算通过 |
| F11 | Windows 两类 token、干净构建、cleanup | 正向和拒绝各自证明；树外 canary 不变 |
| F12 | 正式 Host 构建/安装/重启 | 真实 tuple 一致，公开接口恢复，不新建替身模型任务 |

并发竞争优先用 barrier/handshake 固定交错，再做有限调度压力测试；不要用更长 sleep 或无限重试掩盖竞态。Mutation 只选 load-bearing 不变量：跳过 parent assertion、移除原子claim、提前 release、重置 root 等必须令对应测试失败。

## 7. 合并与验收执行方式

每个产品切片遵循：最小失败反例 → 有界实现 → 定向回归 → 冻结源码 → 指定一次完整检查与 packed 消费 → 独立 gate 核对原日志并重跑关键边界 → 按实际权限更新 PR。文档或未改变产品字节的修正复用原证据，但明确原 tested subject。

避免重复进行全文设计审议。当前最值钱的工作是把已通过的 parser/计划接到真实执行和正式构建，不是增加更多纯 synthetic vectors。

建议并行责任：
- SDK runtime owner：custody、print/runner、唯一 dispatcher cutover；共享 source 单写者。
- native owner：1006 公共接口、静态图与原生资源/输出策略；不与 SDK 双写 serializer/path 规则。
- Windows/verification owner：CI token/build/cleanup、正式 S2 gate 和 artifact 验证；不能修改产品断言使缺陷消失。
- Host owner：P4 build/record/installation，后续 Host CAS/ContextPack/Summary；不将业务存储下沉 SDK。

## 8. 剩余真正需要明确的输入

| 输入 | 可先推进 | 仍不能跨越 |
|---|---|---|
| native1006 精确可用 artifact/发布授权 | 本地 artifact 的授权隔离测试，接口与回归实现 | 不能猜 npm 已发布或替换成浮动 latest |
| 显式有限 descendant policy | 参数化实现、合成边界测试 | 生产不能采用 fixture 的 3/7/2/11 或 upstream unlimited |
| scripted workflow 的具体等价执行机制 | 真实调用追踪、最小机制原型、差异测试 | 不能重开“是否保留”替代落实，也不能擅自加白 eval/VM |
| Windows attestation 平台证明 | 原子接口/错误路径/真实 ACL fixtures | uid/mode 合成验证不等于 Windows 正式安装可信 |
| 正式 Host build / 测试环境 / 真实模型调用授权 | 无模型进程测试和 artifact 校验 | 不以本方案自动获得真实安装、发布或付费请求授权 |

## 9. 完成定义

**SDK 本阶段完成**需同时满足：最新独立切片回执闭合；五边真实递归启用；五项 custody 执行约束；scripted workflow 按已批准范围实现；S2 与 scanner 全闭合；正式安装/构建组合验证；受支持平台必需 CI 无未解释红项或跳过。

**完整持续对话产品完成**还需既有 #194/#195 中的输入 accounting、Main/Summary 双预算、Host CAS、连续历史覆盖、Summary 质量/来源更新、接受/取消/恢复及目标运行时证据。SDK 阶段完成不自动关闭这些产品验收，也不自动发布。

建议立即顺序：G0 补回执 + W 修 CI + C custody 真实并发反例并行；N 精确 native 闭包同步推进；随后 R→S→I。不是把全部开发停在“等1006”，也不是先去扩大新的聊天模式功能。

## 10. 可核对来源

所有 SDK 源码链接固定在本次候选 SHA；PR/CI 链接是观测入口而非永久产品状态。

- [PR #193](https://github.com/Ancienttwo/byok-sdk/pull/193)
- [候选 CI run 35177371443](https://github.com/Ancienttwo/byok-sdk/actions/runs/35177371443)
- [Windows lifecycle 原始 job](https://github.com/Ancienttwo/byok-sdk/actions/runs/35177371443/job/105061927551)
- [Windows pack 前置测试原始 job](https://github.com/Ancienttwo/byok-sdk/actions/runs/35177371443/job/105061928133)
- [detection review](https://github.com/Ancienttwo/byok-sdk/blob/d4dcf96105d9115a253c9f9ca419d922014f605c/tasks/reviews/20260917-c07-record-aware-detection.review.md)
- [detection notes](https://github.com/Ancienttwo/byok-sdk/blob/d4dcf96105d9115a253c9f9ca419d922014f605c/tasks/notes/20260917-c07-record-aware-detection.notes.md)
- [runner/i18n implementation entry](https://github.com/Ancienttwo/byok-sdk/blob/d4dcf96105d9115a253c9f9ca419d922014f605c/docs/researches/20260916-c07-runner-i18n-implementation-entry.md)
- [runner/i18n plan](https://github.com/Ancienttwo/byok-sdk/blob/d4dcf96105d9115a253c9f9ca419d922014f605c/plans/plan-20260916-c07-runner-i18n.md)
- [helper dispatcher](https://github.com/Ancienttwo/byok-sdk/blob/d4dcf96105d9115a253c9f9ca419d922014f605c/packages/client/src/sdk-reserved-helper-host.ts)
- [S2 test](https://github.com/Ancienttwo/byok-sdk/blob/d4dcf96105d9115a253c9f9ca419d922014f605c/packages/client/src/__tests__/pi-s2-bundle-resolution.test.ts)
- [CI workflow](https://github.com/Ancienttwo/byok-sdk/blob/d4dcf96105d9115a253c9f9ca419d922014f605c/.github/workflows/ci.yml)
- [identity implementation](https://github.com/Ancienttwo/byok-sdk/blob/d4dcf96105d9115a253c9f9ca419d922014f605c/packages/implementation-identity/src/identity.ts)
- [identity package manifest](https://github.com/Ancienttwo/byok-sdk/blob/d4dcf96105d9115a253c9f9ca419d922014f605c/packages/implementation-identity/package.json)
- [Microsoft icacls：/T、/C、/L 语义](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls)
- [Node.js vm：不构成安全机制](https://nodejs.org/api/vm.html)
