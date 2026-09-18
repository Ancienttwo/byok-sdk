# WP2-N1 + WP3 证据图：SDK→native 消费面 与 custody 五项现状

> Subject: `d4dcf961`（PR #193 head，worktree `byok-sdk-wt-c07-pi-launch`，只读核查，工作树未触动）
> Produced: 2026-09-17，explorer 只读派工；服务于 `plans/plan-20260917-1459-byok-next-stage-recursive-s2.md` 的 WP2/WP3/WP4 实施刀
> 归属契约: `tasks/contracts/20260917-1459-byok-next-stage-recursive-s2.contract.md`
> 路径约定：B=packages，vendor=B/client/src/vendor/pi-subagents/0.60.0/src

## Map A — SDK→native 消费面（WP2-N1）

### A1 版本 authority（单一源头）
- B/client/package.json:5 — `byok.piRuntimePin = "npm:@byok-sdk/pi-coding-agent@0.85.1005"`；依赖别名 `:86`（pi-coding-agent）、`:102`（pi-ai）、jiti 2.7.0 `:97`、typebox 1.3.7 `:101`、devDep pi-subagents 0.60.0 `:107`
- B/client/src/adapters/pi/client-manifest.ts:14-16 — readClientPiRuntimePin = manifest 依赖的 build-checked projection
- B/client/src/adapters/pi/resolve-bin.ts:26,33-34,70-84 — PI_PACKAGE_NAME；精确 `npm:<name>@<x.y.z>` 别名正则 + fail-closed 身份校验
- B/client/src/adapters/pi/pi-export-assets.source.json:4-11 — export 资产钉住 native name/version/byokFork（upstreamBase 0.85.1, forkBuild 5）

### A2 native 模块消费点（全部站点）
- 静态值导入（唯一留在 dist/index.js 静态图的 pi 边）：B/client/src/daemon/input-preparation-service.ts:41-46 `/rpc-types`（fitsRpcFrame/rpcFrameByteLength/RPC_MAX_FRAME_BYTES，imported rather than restated）；dist-subpath-closure.test.ts:291-295 断言静态 pi import 恰为此、runtime graph 走 `import("#byok-pi-runtime-host")`
- SDK 自有 host 进程内运行时值导入：src/bin/pi-prepared-host.ts:7-17（AgentSessionRuntime, createPreparedAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, runRpcMode, SessionManager, SettingsManager）；src/bin/pi-session-runtime.ts:2-6,11-24（SessionManager.list/open 精确 id，拒绝模糊）；src/bin/pi-rpc-host.ts:6；pi-team-operator-host.ts:2（仅 VERSION）；extension 类型导入 type-only 擦除（adapters/pi/{subagents-policy-extension,mcp-extension,team-interaction-extension}.ts:1-2）
- 动态导入（一次性 memo）：src/adapters/pi/input-preparation.ts:74-81 `/prepared-session-input`（必须动态：native 图拖入 provider 层与 openai）；`:620-628` canonicalPreparedValue；`:5-9` `/input-preparation` 仅类型
- 数据式命名（非模块边）：resolve-bin.ts:133、input-preparation.ts:239 经 import.meta.resolve 定位；dist-subpath-closure.test.ts:324-343 钉死两行文本零 import
- 私有 imports map：package.json:110-121（#byok-pi-runtime-host / #byok-pi-todo-runtime / #byok-pi-runtime-host-sealed）；薄 bin src/bin/byok-pi-rpc.ts、byok-pi-prepared.ts 字面量懒载

### A3 资源文件定位（themes/locales/skills/export）
- locales（todo）：src/adapters/pi/todo-locale-layout.json（basePath extensions/rpiv-todo/2.8.0，9 locale）；todo-locale-assets.ts:9-14 路径表；verifyTodoLocaleAssets：attested 要求 identity.assetRoot 且 binding.envCommitments.PI_PACKAGE_DIR===assetRoot，逐文件 sha256 + JSON shape；unconfigured 回落 dist/assets/（`:16-21` 注释：单文件 S2 下不评估该相对根）
- export 资产：pi-export-asset-layout.json（export-html 5 文件：template.html/css/js + marked/highlight vendor）；pi-export-assets.ts:22-38 attested-only、`PI_EXPORT_SOURCE_LAYOUT_FORBIDDEN`；`:16-17` 明注 "Native 1005 still needs a public static export API (1006 prerequisite)"，现校验不授权递归、不限 export 输出路径
- themes：SDK 从不主动定位；prepared host 构造 DefaultResourceLoader 后永不 reload（pi-prepared-host.ts:48-57,308-315，零 extension/skill/prompt/theme/context 读取）；S2 attested 物理闭包含 native dist/modes/interactive/theme/{dark,light}.json（pi-s2-bundle-resolution.test.ts:277-281）
- skills：一律关闭——`--no-skills`（pi-adapter.ts:530）、rpc host noSkills:true（pi-rpc-host.ts:144）；skills.pack 是 host 自有投影，SDK 永不写 vendor skill 目录（src/index.ts:445-452、daemon/skill-pack-installer.ts:29-31）

### A4 print 入口与输出路径策略
- B/implementation-identity/src/identity.ts:407-410 — RUNTIME_ENTRIES 四类：pi-prepared|pi-rpc|pi-subagent-print|pi-subagent-runner；`:411-414` fixedArgv=['__byok_sdk_helper',kind]，attested launchArgv 逐位相等；`:486-493` 类型边 rpc→print/runner、print→print/runner、runner→print（inheritsCredential=true）
- B/client/src/daemon/tool-implementation-identity.ts:25-29 — RUNTIME_LAUNCH_KINDS 仅 ['pi-rpc','pi-prepared']；`:163-164` descendant kind 直接 install_record_mismatch
- vendor spawn 现状：vendor/runs/shared/pi-spawn.ts:139-163 getPiSpawnCommand（PI_SUBAGENT_PI_BINARY env 覆盖 → execPath 名 pi → 解析 pi CLI 脚本 → 末位裸 `pi` PATH 回落）；`:31-41` resolvePiPackageRoot 从 argv[1] 上溯
- 前台 print：vendor/runs/foreground/execution.ts:350 baseArgs ['--mode','json','-p']；`:588` spawn；`:553` depth env 统一注入
- 后台 runner：vendor/runs/background/async-execution.ts:537,564 spawn(node,[jitiCliPath,subagent-runner.ts,cfgPath])；`:526-527` 无 jiti fail-closed；`:88-130` 模块加载期 4 种探测解析 jiti CLI
- 输出 authority：vendor/runs/shared/single-output.ts:18-59 输出内容 authority = 子进程成功 `write` 工具调用匹配目标路径，非磁盘读回；parallel-utils.ts:59-63 outputPath/outputClaimPath/namespaceOutputPath；child-launch-plan.ts resolveSingleOutputPath + parallelOutputNamespace 路径命名空间化

### A5 RPC schema 生成/校验点
- input-preparation-service.ts:41-46 单一 authority；pi-rpc-host.ts:62,128-133 + pi-prepared-host.ts:173 PermissionPolicySchema.safeParse + delegated flags 必须等于 policy 投影；两 host config 精确键集校验（pi-rpc-host.ts:51-76 / pi-prepared-host.ts:156-214）
- sealed 构建规则：scripts/build-sealed-host.mjs:16-22（sealed metafile 必含 structured-output-sealed.ts 与 src/extension/rpc.ts、不含 structured-output.ts / node_modules/pi-subagents）；tsup.sealed.config.ts:14-18 external（typebox/compile、jiti、yaml）；pi-sealed-factory-closure.test.ts:11-22,59 sealed_structured_output_unsupported
- rpc-client.ts:21-27 — RPC wire 客户端松散 JSONL（"loose bag"），该路径无帧 schema 校验

### A6 jiti / 隐式发现 / 自动安装 / 未闭合动态装载 / tripwire
- jiti 2.7.0 依赖（package.json:97）+ sealed external（tsup.sealed.config.ts:17）；async-execution.ts:526-527,564 = sealed 路径最大未闭合动态装载
- vendor 隐式发现（WP4 要替换）：pi-spawn.ts:6,143-147,162 env 覆盖 + argv[1]/包根上溯 + 裸 pi PATH 回落
- dist 闭包守卫：dist-subpath-closure.test.ts:106-113（daemon-free dist 禁 jiti/pi-coding-agent/@earendil-works/ajv/photon/@modelcontextprotocol/client 子串 + codegen 规则 + 非字面量 import/require）；`:95,324-343` adapters/index.js 唯一豁免=数据式两行；`:364-385` 负控证明 checker 非空洞；`:345-362` `#byok-pi-todo-runtime` 唯一字面量懒装载点（pi-rpc-host.ts:137，前置 verifyTodoLocaleAssets）
- 自动安装：SDK 源码零自动安装；pi-s2-bundle-resolution.test.ts:207,325-331 bun cache 空 + registry 零尝试 + provider 零请求断言；`:260` bootstrap --no-install
- S2 attested 资产闭包：theme×2 + export 5 + locales + photon_rs_bg.wasm（:277-281）
- 网络面：pi-prepared-host.ts:298-307 modelsPath:null / allowModelNetwork:false / refreshOnCreate:false
- extension 全静态工厂无运行时 resolver：src/bin/pi-extension-factories.js:1-3

### A7 native1006 可消费闭包边界（结论）
闭包 = 三层并集 + 行为契约：
1. 模块面：root 导出（createPreparedAgentSession/AgentSessionRuntime/runRpcMode/DefaultResourceLoader/SessionManager/SettingsManager/ModelRuntime/getAgentDir/createAgentSessionServices/resolveCliModel/docs-examples snapshot）+ 子路径 /prepared-session-input、/input-preparation（类型）、/rpc-types（无依赖帧工具）
2. 物理资产面（attested record 逐 digest）：package.json + themes 2 json + dist/core/export-html/* 5 文件 + extensions/rpiv-todo/2.8.0/locales/*.json + photon_rs_bg.wasm；PI_PACKAGE_DIR 唯一受控目录 env（tool-implementation-identity.ts:33-35）
3. bin 面：native manifest 的 pi bin（resolve-bin.ts:151-157，仅 dev/unconfigured lane）
- 行为契约：agent-session.js:999 prepared 拒绝（pi-prepared-host.ts:37）、prepared session 永不替换（:365-371）、auto-compaction/retry 关闭（:342-343）
- 具名缺口：公开静态 export API（pi-export-assets.ts:16-17）

## Map B — custody 五项现状（WP3）

### ① 原子 fanout
- vendor/runs/shared/run-fanout-budget.ts:13（TEMP_ROOT/run-fanout-budgets）；`:88-89` manifest wx 原子写；`:140-205` admission lock（mkdir+owner.json+pid 活性 stale 60s 回收）；`:228-264` 锁内批量 claim（容量预检→wx 逐 slot→失败回滚已建）；`:217-221` snapshot；`:127-138` descriptor base64url env/config 继承；`:223-226` parentPath 前缀限定
- vendor/extension/doctor.ts:184 claims 永不释放；types.ts:2749-2756 默认 64/run；async-execution.ts:1182,1564 fallback createRunFanoutBudget(id,64)
- 缺口：implementation-identity/src/descendant-launch.ts:121 自述 "not an atomic budget claim"、无 SDK 侧 verified-parent 绑定；vendor/runs/foreground/subagent-executor.ts:1342,5098,5327 admit 钩子全在 vendor 进程内、未接 attested launch

### ② session/parallel 生命周期
- vendor/shared/fork-context.ts:40-54 fork=剪枝副本，spawn 前父写好（结构性单 writer）；execution.ts:1779-1780 alignForkedSessionCwd 只改文件头；session-file-trust.ts:7-19 realpath 须在 sessions base 内且等于 recorded file
- parallel-utils.ts:151,159-185,279 进程内 Semaphore（全局默认 20、每组 max 4）；`:177-184,207-228` finally 释放；scripted-workflow.ts:2000-2002 launch semaphore finally release
- 缺口：identity.ts:494-500 + descendant-launch.ts:131-134 descendantPolicy.parallel/sessionCap 仅数值校验，跨进程无并行帽执行者

### ③ charge-once
- descendant-launch.ts:139-147 runner→print 零计费 bootstrap（expectedDepth = parent.depth + (bootstrap?0:1)）；`:149-152` PI_SUBAGENT_DEPTH 投影须与契约一致
- vendor 侧：types.ts:2711-2717 每子进程 +1；execution.ts:553 前台统一注入；pi-args.ts:875-883 async 侧 nested route env 再 +1
- 冲突：逻辑一次委派 rpc→runner→print，vendor 物理计 depth 2，SDK 契约计 1
- 关键事实：assertDescendantSpawn（identity.ts:1730-1747）client 侧零调用（全仓引用仅 implementation-identity 及其 __tests__）——契约就绪、接线未发生

### ④ 取消/重试 permit
- vendor/shared/workflow-child-permit.ts:40,59-77 不透明内存态 permit（WeakMap）available→claimed→consumed；`:87-96` 先 claim 再验产物形状、错 key 直接烧毁；`:98-111` consume 在唯一 native spawn 前（runId/childKey/agent/runner/digest 全对上）
- execution.ts:561-581 consumeWorkflowChildPermit spawn 前消费；subagent-executor.ts:6756-6775 签发经私有 delegatedWorkflowPermit；`:5308` + scripted-workflow.ts:1068,1903-1906 workflow 单用 claim，permit 下禁 runs.all/resume/batch（:1905-1906、subagent-executor.ts:5337-5339）
- 对照：parallel-utils.ts:159-185 Semaphore 是容量池非授权
- 缺口：createWorkflowChildPermit 全树无调用者（仅定义处 workflow-child-permit.ts:59）；SDK client 源码零引用——签发侧未接线
- 取消：execution.ts:594-640 abort→detach+三级 timeout 计时器；重试：subagent-executor.ts:516-533 promptAuditRedoParams 剥 lineage 新 dispatch、不重用 permit

### ⑤ root/parent custody
- descendant-launch.ts:32-38 SpawnExpectation "Independently selected from the verified parent, never reconstructed from the submitted child config"；`:122-171` validateDescendantSpawn 全套（policy/template digest 对 expected `:134`、边对冻结表 `:135-138`、深度从 verified parent `:142-148`、env allowlist+exactNames digest+逐值对 actual env `:158-165`、credential custody `:166-167`、loader env drift `:168`、invocation 一致 `:169`）
- identity.ts:1730-1747 assertDescendantSpawn 物理字节复验，自述不含 concurrency/budget custody
- runtime-descendant-plan.ts:69-106 模板逐 digest 钉死（self 模板=self binding `:101`、声明相等 `:84-88`）；runtime-launch.ts:103-128 descendantPlan 仅 Host-resolved locator 构建（`:107-108` 不 retarget/不合成/不发现 bin；`:114-115` 子代声明与 self 全同）
- 现状=env 自报：types.ts:2706,2713 PI_SUBAGENT_DEPTH；pi-args.ts:138,875 PI_SUBAGENT_PARENT_DEPTH；nested-events.ts:160-179 route/parent 从 env；capability token PI_SUBAGENT_PARENT_CAPABILITY_TOKEN 在 env 名单内（identity.ts:419-467）
- dispatcher：sdk-reserved-helper-host.ts:91-92 拒 ['__byok_sdk_helper','pi-subagent-runner'|'pi-subagent-print']——该形状正是 attested fixedArgv 强制形状（identity.ts:411-414；tool-implementation-identity.ts:166-168 逐位相等）→ 所有未来 attested descendant launch 的唯一合法入口；双重拒绝=kind 白名单（tool-implementation-identity.ts:163-164 + RUNTIME_LAUNCH_KINDS `:25-29`）
- 测试钉死：sdk-reserved-helper-host.test.ts:263-266；runtime-launch-description.test.ts:401-403；pi-installation-observation.test.ts:92
- detection 侧同样只观测两顶层 kind：installation-observation.ts:31

## 五项总缺口（一行）

SDK 侧原语（fanout budget / spawn expectation / one-shot permit / 零计费 bootstrap 规则）均已存在且 fail-closed，但 未串成 admission→permit→spawn→charge 一条链 未接线到 vendor 真实 spawn 点（execution.ts:588、async-execution.ts:564） 统一入口 dispatcher 显式关闭。WP4 五边接线实质 = 把 vendor 两个 spawn 点改道 `__byok_sdk_helper` 形状并在这条链上落 ①–⑤。
