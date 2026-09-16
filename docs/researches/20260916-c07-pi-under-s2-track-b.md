# C07 Pi-under-S2 — independent track B

日期：2026-09-16。只读源码／既有实验取证；未读 A 轨结论，未修改产品代码，未运行新构建或测试矩阵。本报告不是 gate PASS。

## 结论

**推荐有条件采用 O1，confidence MEDIUM。** 将同一个 sealed S2 bundle 的普通 Pi 与 prepared Pi 做成明确的逻辑入口；SDK 统一描述、绑定和验证 interpreter／entry／固定 argv 前缀。Owner 的完整 daemon＋Pi 要求保持不变。O1 的优势是复用同一 immutable release、同一 artifact digest 与安装事务；不是“现有 API 已经能直接接线”。

**三个选项目前都不能原样交付。** O1 必须先补齐 SDK 启动与 provenance 契约，并完成完整 bundle 闭包。若完整功能无法在这个闭包中成立，应重新选择 O3 并显式扩为目录闭包，不得把 MCP-only、compiled Pi 或删减 provider/extension 能力当作已满足 Owner。

## 证据主体

以下为本次实读主体，不将旧构建证据冒充当前候选：

- SDK `S=/Users/kito/Projects/byok-sdk-wt-c07-candidate-2`，HEAD `4fe4ad6f5e7814e5c2fba1120c72ecfb3c09a62c`。
- Salesko `H=/Users/kito/Projects/salesko-new-wt-c07-e`，HEAD `375b5316`。
- Native `N=/Users/kito/Projects/pi-wt-c07-native-input`，HEAD `9f50423d087780139a4acb090ffce7c1ff4ef3df`；`packages/ai`、`packages/agent`、`packages/coding-agent` 相对已发布 1005 的 `49593de3` 无差异。
- pin-1005 worktree 仅辅助核对 projection v2 的 identity 函数，未将它与 S 的 compilerVersion 混写。
- 动态构造旧实验：`/private/tmp/salesko-s1-gap-hu079w68/embedded-eight.json`；bundle SHA256 `670255141e390dadf9c4311aecd48dfaa40baf08ff1773d3a1dde03170238e83`，compiled SHA256 `36baaf0430f92244e29bc92584b46b76d58b251d94c060c5a1f25005fdfb3627`。方法仅证明 8 个片段在 __BUN 中存在，不是全部动态入口枚举，也不是新 1005 artifact 的闭包证明。

## P1 — 权威和边界

1. **Host installer／installed record**：决定选定的 immutable release、artifact、interpreter 与安装来源。不得由 HOME 中可写 package.json 再声明执行身份。
2. **SDK**：消费记录，自测文件、interpreter、最终 launch env，在真正 spawn 前 reverify；把物理执行身份绑定进 preparation/admission。现有测量核心可以复用，MCP locator 本身不能冒充 Pi runtime locator。
3. **Native fork／构建链**：提供 package name/version/byokFork 与 prepared contract；这些语义身份必须通过构建溯源绑定到实际 bundle 字节。版本字符串不是文件身份。
4. **keys**：持有凭证读取与投影权威，而且实际再 spawn Pi。因此最终 spawn 仍属于验收路径，不能仅在外层 PiAdapter 提前检查一次。
5. **HOME、session、models、工作目录**：是运行数据与任务上下文。与 immutable executable、启动前安全 cwd、package provenance 分开，不把 HOME 改成 release directory。

当前边界事实：`S/packages/client/src/daemon/tool-implementation-identity.ts:190–211` 的 closureKind 只有 `artifact`，digest 只覆盖一个 executable/bundle；`:258–264` locator 要求 toolsetId/serverName。`:1093` 的通用 spawn helper 对 undefined/unavailable 直接返回。故 C07 Pi 必须先要求 attested，再复用 reverify，不能以调用该 helper 就声称强制准入。

## P2 — 三条真实启动路径及断点

### 1. 普通 Pi

`H/apps/local-agent/src/daemon.ts:194–206` 当前在 S2 **不创建 PiAdapter**；S1 使用 release hardlink、`source:'env'`。

`S/packages/client/src/adapters/pi/resolve-bin.ts:36–39` 只有 `{command, source}`。`S/packages/client/src/adapters/pi/pi-adapter.ts:53–56` 将 package 形状变成 `process.execPath + entry`，不是 record.interpreter.path，也没有固定子命令 argv。普通直接启动见同文件 `:511–519`。

因此 O1 所述 `command=interpreter.path, entry=installPath, args=[pi,…]` **需要显式 SDK 契约改动**。不可把三个 token 塞进 command 字符串，不可借 BYOK_PI_BIN 绕过 identity。

### 2. prepared Pi

`S/packages/client/src/adapters/pi/pi-adapter.ts:393–408` 分支不传普通 invocation；`:745–747` 固定 `process.execPath + client dist/bin/byok-pi-prepared.js --config …`。该 entry 在 `:837–838` 从 SDK package root 构造。

只改 Salesko `pi` 子命令不会修复 prepared。O1 必须让同一 sealed artifact 有 **SDK 所有的 prepared 入口**，保留 `createPreparedAgentSession → runRpcMode`，不能转发到普通 `pi --mode rpc`。prepared 子进程还会再次解析 native identity；它不是一个可以跳过 package/provenance 的壳。

### 3. keys launcher

`S/packages/keys/src/bin/pi-provider-launcher.ts:79–98` 生成 models 投影、读取 credential、构造最终 child env 后再 spawn。当前参数只有 piBin、piEntry 与经校验的 Pi flags。`pi-provider-projection.ts:57–100` 拒绝裸 `pi` 子命令，不能把固定前缀偷偷塞进 delegatedArgs。

固定入口前缀与任务 flags 必须分开绑定；最终 spawn 时 reverify 实际目标与最终 env。keys 不应导入整个 client 造成反向依赖或复制第二套 validator：应由既有 SDK 权威提供可复用的测量核心／受约束启动描述，保留 keys 的 secret 权威。凭证排除仅沿用精确、已批准的规则，不能新增 wildcard 豁免。

### npm alias / package.json：准确失效位置

- `S/packages/client/src/adapters/pi/resolve-bin.ts:70–83` 的 exact npm alias **规则应保留**；`:79` 是 dependency 字符串不匹配的错误，不能笼统称它为 bundle 缺 package.json 的错误。
- `S/packages/client/src/adapters/pi/client-manifest.ts:22–35` 首先需 `@byok-sdk/client/package.json`；它可先失败。
- 随后 `resolve-bin.ts:133–157` 需要可解析 native package、真实 enclosing package.json、name/version 与 bin.pi；单文件 bundle 没有该布局会在另一处失败。
- `resolveBin` env override 会绕过普通解析，但 `adapters/pi/input-preparation.ts:183–231` 又要求 SDK pin 和实际 fork manifest/byokFork；所以不是修法。
- `H/apps/local-agent/src/bundled-pi.ts:37–42` 另有 **bare semver** 规则，当前无法接受 SDK fork npm alias；`:72–76` 写入用户目录的 upstream-name package.json 只是旧 assets 投影，不能提升为可信 native manifest。

**建议**：SDK 在构建期从同一 exact alias、实际 fork manifest/byokFork 生成 strict provenance 投影，经 bundler inputs/metafile/包 integrity 与最终 artifact 建立可审计绑定；运行时消费该明确安装形态。不要“先找 manifest，找不到就信 embedded version”的 fallback，也不要让 Host 手填第二份 fork identity。npm 包与 bundle 是显式安装形态，不是两个并存的语义 authoring authority。

## Pi attestation：所需完整链

建议链是设计要求，现有源码尚未实现：

```
selected immutable install record
  → SDK runtime launch description（实际 interpreter + entry + 固定入口前缀）
  → SDK 自测 artifact/interpreter + 构建来源绑定的 native identity
  → preparation 保存同一 runtime identity/binding
  → admission 比对；pin 锁住选定 release
  → 最终 env/argv/cwd 确定
  → 最终 spawn 前 SDK reverify
  → trusted interpreter + sealed entry
  → SDK-owned ordinary/prepared entry 再核契约并开始 native
```

- 物理身份至少涵盖 record revision、bundle digest、interpreter digest/stat、逻辑 entry/mode、固定 argv、launch cwd 及已有 env 承诺；native 语义身份包括 package/fork/prepared contract。任务临时参数仍受各自任务契约约束，不引入任意 nonce wildcard。
- resolve/admission/pre-spawn 消费同一推导结果；不新增 Host 自称 attested 的快捷入口。
- 现有 `inputPreparationRuntimeIdentityString` 是 package/version/commit/build 字符串，不等于 interpreter+bundle 证明；现有 task-runner 的 implementation loop 只遍历 MCP servers。
- 正常升级必须永不覆盖旧 release，切指针后仍保留已 pin 版本直到任务/重试结束。预启动 hash 不能代替 retention；崩溃 pin/recovery 未闭环不能在本报告中算已解决。
- 任意 root 对 trusted bytes 的恶意替换属于信任基座边界；正常 updater 的竞态仍须由不可变安装和 pin/retention 消除。

## HOME、argv0 与 Bun bootstrap

- `H/apps/local-agent/src/bundled-pi.ts:21–22` 用 argv0 basename 分派；解释器启动 argv0 是 Bun，不能沿用 S1 hardlink 语义。O1 改为明确 argv 前缀并只消费一次；普通与 prepared 分派是不同语义入口。
- 不保留“argv0 不行再试子命令”的长期兼容路径。S1 若同列车切换，由一个确定的 release-derived launch 描述统一切换；不要产生第二份配置权威。
- `H/apps/local-agent/src/main.ts:14–16` 现仅 start/mcp 核 running release；新增 Pi 入口也要验证实际 interpreter+entry 对应选定记录。
- 当前 Pi 普通/ prepared 的 spawn cwd 是 manifestCwd；keys 最终 child 未传 cwd、继承父级。MCP launchCwd 修复 **没有覆盖 Pi 解释器初始化**。
- 既有 Bun preload 探针已证明可写 cwd 的 bunfig 风险。所有 O1/O2/O3 均要先在可信 cwd 启动 interpreter，env/execArgv 在此之前受控，再由受信任入口应用任务工作目录。JS entry 内检查发生在解释器初始化之后，不能倒推“preload 不可能发生”。
- Native 普通 main 读取 process.cwd（`N/packages/coding-agent/src/main.ts:580`）；prepared factory 显式收 cwd。必须验证工作目录切换前后 native tools、session、profile 行为一致。
- `N/packages/coding-agent/src/config.ts:391–417` 中 interpreted 与 compiled theme 布局不同；当前 `H/apps/local-agent/src/bundled-pi.ts:77–81` 的 root/theme 投影不自动满足 interpreted 所需 dist/modes/interactive/theme。HTML export 等 assets 也须盘点。
- HOME 不保证等于 agent canonicalHome；SDK 环境构造保留 ambient HOME。keys 另投影 PI_CODING_AGENT_DIR/session dir。保留这些数据权威，不把可写 models/auth/theme/package 投影当作代码 provenance。

## P3 — 选项取舍

| 方案 | 收益 | 首批硬缺口 | B 轨判断 |
|---|---|---|---|
| O1 同一 bundle、显式入口 | 一个 artifact、一个安装事务、同一 interpreter；不引入新可写 wrapper | SDK 三条 spawn 路径统一；manifest/extension/assets 去文件布局假设；完整 bundle 动态闭包 | **条件推荐**，先证明入口和闭包再放行 |
| O2 第二 sealed entry | daemon/Pi 可分开导入，独立裁剪；并非 mutable wrapper | 当前单 artifact record 不能只 hash daemon 就担保第二 entry；需 layout/组件清单/digest 原子绑定；SDK prepared/keys 问题仍在 | 不选首刀。只有实证图分离能消除 O1 承重问题，收益才抵得上新组件模型 |
| O3 独立 fork package 目录 | 保留真实 npm manifest/bin/assets；可能更贴近 native 文件布局 | artifact attestation 不能证明整个目录；所有 transitive code/package metadata/native/WASM/loader 要 sealed；SDK helpers/extensions 也不只 fork；Host prepared compiler 仍静态引用 native | 不选当前首刀；作为 O1 闭包失败后的显式目录闭包方案，不是假称“与 MCP 相同”即可复用 |

拒绝 O2/O3 是相对当前 record 和交付面，不是永远否决。O1 的推荐不授权缩减功能，也不提前接受闭包扫描未通过。

## 8 处动态构造的去向

下表“存在”绑定上述旧构建证据；新候选必须复核最终产物。O2 的精确分布、tree-shaking 删除、O3 externalization 是否成功均需 build graph 证明，不能从目录名字推断。

| # | 旧产物位置/用途 | O1 | O2 | O3 |
|---|---|---|---|---|
| 1 | 26824，SDK MCP client v2 AJV `new Function` | full daemon import graph 仍可能携带；改 MCP server 不等于删 client AJV | daemon 子图可能保留 | daemon 子图仍在，fork 外置不解决 |
| 2 | 78587，Salesko MCP SDK/AJV 编译 | server 替换且产物确实裁掉后才算移除 | 对应 server 子图处理 | 同 O1，与 fork 是否外置无关 |
| 3 | 93319，pi-ai/auth/context computed import | 需收敛已知 builtin 加载并验 final bytes | 随实际 pi-ai importer 分布，可能两边都有 | 搬到 fork 目录，不等于消失 |
| 4 | 124726，Bedrock lazy module computed import | 需明确包含完整 provider 实现，不能只把错误推迟到首次请求 | Pi/准备子图都要核 | 需 seal lazy target 及全部依赖，缺文件应负控拒绝 |
| 5 | 157241，env-api-keys 的 fs/os/path computed import | 候选可静态收敛，须保留行为 | 同 O1 | 仍是动态构造；builtin 有限性可作为明确证据，不是任意字符串许可 |
| 6 | 159122，OAuth lazy module computed import | 对完整启用 provider 集作封闭枚举 | 多 entry 不能假设只有一份 | loader/target 必须都入目录闭包 |
| 7 | 217195，photon WASM glue `new Function` | 需追完整 image/WASM 路径，单 JS hash 不说明实际代码生成范围 | Pi image 子图，不因拆入口自动删除 | JS glue/WASM 是目录成员，仍需解释动态生成的执行边界 |
| 8 | 270966，jiti `import(id)` | 扩展加载边界未因 bundle 自动封闭 | Pi/SDK extension 图仍要处理 | 最容易逃逸 package 目录；必须绑定获准的代码入口/依赖及缓存行为 |

### 源码补充（独立 explorer 交叉取证，未读 A）

- #3：`N/packages/ai/src/auth/context.ts:1–44`，已见 callsites 为 node:fs/promises、node:os；#5：`N/packages/ai/src/env-api-keys.ts:1–65`，fs/os/path 与 Vertex ADC。应明确收敛这些调用，不把变量 import 一概描述成已被外部输入控制。
- #4：`N/packages/ai/src/api/bedrock-converse-stream.lazy.ts:10–29`；#6：`N/packages/ai/src/auth/oauth/load.ts:9–67`。`N/packages/coding-agent/src/bun/runtime-setup.ts:1–9` 静态注册 Bedrock 与七个 OAuth loaders（后者在 `N/packages/ai/src/bun-oauth.ts:1–20`）。**这提供了可复用的静态入口，但 fallback 仍在代码中；Salesko 新入口是否执行相同 setup、最终产物是否仍可到达 fallback，尚未证明。**
- #7：`N/packages/coding-agent/src/utils/photon.ts:45–51` 的 WASM fallback 包含 **process.cwd()/photon_rs_bg.wasm**；`:63–79` 在原路径缺失时尝试它，`:125–138` 失败后返回 null。这里不只是“缺一个 assets 文件”：attested lane 必须封闭 WASM 来源，不能从任务可写 cwd 补代码，也不能将 null 降级当成功。若 WASM 不能嵌入同一 artifact，就必须显式扩大 sealed component 模型，这会削弱 O1 的单 artifact 优势并触发重新比较 O2/O3。
- #8：`N/packages/coding-agent/src/core/extensions/loader.ts:488–517` 的 `jiti.import(extensionPath)`，`:668–700` 读取 package.json 的 pi.extensions；package-manager.ts:557–595 也参与发现。封闭 jiti 自身不等于封闭 extension 文件及依赖。需要覆盖 SDK 自带普通 Pi extensions 和所有宣称支持的加载形态。

不能把这八处统称同一种漏洞：固定 builtin import、固定内部 provider module、schema codegen、WASM glue、扩展任意加载各需不同证据。扫描八个字面片段不是完整闭包扫描。配置型代码加载必须纳入 attested lane 的代码身份；普通工具按授权执行外部程序也不能未经分析就与“runtime implementation closure”混为一谈。

## 10x 先失效的地方

- **O1**：bundle/provider/extension 图扩大，静态闭包检查和构建 provenance 最先漏边；其次每次 resolve/reverify 对整个 artifact 与 Bun 的读/hash 成本。不可直接加未失效校验的缓存来掩盖。
- **O2**：entry/component 数量增长，记录与安装事务漏绑定、混版本风险先于 runtime 性能；只增加一个第二文件 hash 后长期手工同步不是可扩展权威。
- **O3**：文件数与依赖边增长使完整遍历、inode/hash/reverify、symlink/解析逃逸、缺文件安装成为主要压力；只 hash bin.js 会最先失去安全含义。
- **共同**：release retention 与崩溃遗留 pin 增长；磁盘容量策略与回收授权必须单独闭环，不自动删除旧版本。工作目录/环境生成消费者增加会暴露“检查的对象不是最终 spawn 的对象”。

## 验证清单（后续实施 gate，不在本只读任务重跑）

1. **冷安装正向**：无 checkout、无用户 node_modules、无 PATH interpreter；真实可信 Bun + sealed entry 跑完整 daemon、ordinary Pi、prepared Pi、keys lane 与 detection。日志/进程取证证明不是 compiled alias。
2. **identity 负控**：SDK alias、fork manifest/byokFork、bundle build provenance 任一不一致拒绝；伪造 HOME/package.json 不可改变身份；缺少 attested 不准 READY。
3. **三条最终 spawn**：外层检查后再替换 bundle/interpreter、改固定前缀/cwd/env；在最终 spawn 前拒绝，零 native/provider side effect。keys secret 注入只走原有固定集合规则。
4. **argv/cwd/data**：带空格及特殊字符逐字节传递，前缀不进入 Pi parser；普通/prepared/keys 的 session、models、HOME、工作目录与 native tools 行为一致。
5. **bootstrap**：可写 cwd 植入 bunfig preload 的负控实际会执行；正式路径在 Bun 初始化前使用可信 cwd，preload 不执行；之后工作目录正确。仅 entry 内 env 检查不能代替此项。
6. **闭包**：更新完整加载入口扫描，并按每类构造追 target；负控未声明 module、jiti 外部 extension/缓存、WASM 替换、缺 provider lazy chunk 均失败。含全部声明支持的 provider/extension/assets；不得用关闭功能换绿。
7. **更新**：prepare 后切 current、旧 release 仍 pin；launch 使用原实路径；旧 bytes 不覆盖；restart/retry/pin recovery 与拒绝行为有真实进程证据。
8. **O2/O3 若启用**：混组件/混包版本、遗漏文件、越界 symlink、解析到用户或系统 node_modules、目录内额外可加载代码均有负控；一个 entry hash 不算通过。
9. **发行证据**：冻结真实最终 bundle/interpreter/构建输入后才产生一次全链证据。SDK/native 正式 pins 与 pack/install 取证；symlink candidate 绿不等于正式发布或部署完成。

## 下一刀

建议先切 **SDK Pi runtime launch/provenance 契约与三个 spawn consumer 的有界设计**。入口是 resolve-bin、pi-adapter、byok-pi-prepared、keys pi-provider-launcher 和现有 implementation measurement 核心。交付明确 ordinary/prepared/keys 共用的 strict 描述、实际 spawn 时点与 native 来源绑定，再让 Salesko 实现 O1。原因是这组断点三个选项都绕不开；先在 Host 加 `pi` dispatch 会留下 prepared 与 keys 的第二条未验证启动链。本刀不需要重跑全部构建，也不授权新的发布/部署。
