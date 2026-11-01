# pi-subagents 0.60.0 → 0.83.1：改为直接依赖

基线：`feat/pi-subagents-0.83`，#1125 合并后 rebase 到 main `eb0c7c25`。

## 授权

用户（owner）2026-10-29 批准：「尽量不要自己胶水，可以依赖就依赖」「发PR合并后，升级pi-subagents到最新」「批准」。批准的建议：

1. 接受上游前台子 agent 改为进程内 `createAgentSession`；删除 SDK print 子进程重入；授权 gate 改为文件形式注入每个子 agent。
2. keys-profile 通道不加载 subagents 扩展（替代子进程启动后再拒绝）。
3. 单文件产品先降级（方案 c），同时向上游提议宿主指定 runner 命令的扩展点（方案 a）。
4. 修订 spec 的子 agent 条款。

## 事实（读 v0.60.0..v0.83.1 源码与 npm 包得出）

- 前台：`src/runs/foreground/execution.ts` 每次尝试驱动一个进程内子会话（`child-session.ts`，`createAgentSession`），不再启动 `pi -p` 子进程。子会话新建自己的 `ModelRuntime`，读 agentDir 的 `auth.json`/`models.json`，**看不到**父会话 `setRuntimeApiKey` 的内存 key。
- 后台：独立 runner 进程。npm 宿主用 `node <pkg>/bundle/subagent-runner-bootstrap.js <cfg>` 加 peer alias；Bun 编译宿主用 pi CLI 参数重启 `process.execPath`。没有宿主替换 runner 命令的扩展点。
- 包内文件是运行时依赖：`package.json`（加载时版本校验，读不到即抛错）、`agents/`、`prompts/`、`skills/`、`workflow-script-worker.cjs`、runner 脚本、`runner-peer-*.mjs`，全部经 `import.meta.url` 定位。**因此不能再打进 SDK bundle，只能作为已安装依赖加载。**
- `registerRequiredChildExtensions({ sessionId, extensions: [{ id, path }], requireForAllRunners: true })`：前台、后台、嵌套、恢复的每个本地原生子 agent 都加载指定扩展文件；解析到 external-cli / external-job / machine 的启动在进程启动前拒绝。覆盖 SDK 原有的 gate 继承与 #1061 external runner 拒绝两处补丁。
- CommonJS 兼容（顶层 await、`import.meta.resolve`）上游已处理或只在 try/catch 内。
- 运行时依赖：`@js-temporal/polyfill`、`acorn`、`jiti`、`undici@8.12.3`、`yaml`，均为纯 JS；peer 全部 optional。

## 设计

- `pi-subagents@0.83.1` 成为 client 的运行时 `dependencies`，在普通 host 中保持 external（`import from 'pi-subagents'`）。删除 `vendor/pi-subagents/0.60.0`、`scripts/subagents-build.ts` 的 vendor 部分与 devDependency oracle。
- 子 agent 授权：新增自包含入口 `dist/bin/pi-subagent-gate.js`（默认导出扩展 factory，从 `BYOK_TOOL_AUTHORIZATION_GATE` 读 gate，并以子会话 id 标注 `nativeAgentId`）。父 host 的 gate 扩展在 `session_start` 用父会话 id 调用 `registerRequiredChildExtensions(..., requireForAllRunners: true)`，`session_shutdown` 时 dispose。未启用 gate 时不注册，external runner 与上游行为一致。
- keys-profile：`pi-rpc-host` 在 `credentialSource: keys-profile` 时不装载 subagents 扩展；删除 `credential-guard.ts`。
- 删除 `pi-subagent-print` / `pi-subagent-runner` helper 种类、`subagents/spawn.ts`、`print-argv.ts`、`runner-bridge.*`、`subagent-print-host.ts`、`subagent-runner-host.ts`；`piSubagentHelperKinds` 随之移除（breaking，写 upgrade-manifest 条目）。
- 打包形态（sealed host、`PI_BUNDLED_NODE` 单文件产品）：不加载 subagents 扩展，`subagent` 工具不可用。后续切片：把 pi-subagents 作为资产 Pi package 随 `copyPiRuntimeAssets` 发布以恢复前台；后台等上游扩展点。sealed structured-output 替换随 vendor 一起删除。
- CI：`reviewed-content.mjs` 登记依赖与 lock 行；`select-impact.mjs` 移除 vendor 0.60.0 映射，登记删除路径。

## Task Breakdown

- [x] 依赖与构建：client `dependencies.pi-subagents = 0.83.1`，普通 host external；删除 vendor、sealed 替换与 build-sealed-host 的 provenance 复制；`check-adapters-entry` 断言更新。
- [x] 子 agent gate：`pi-subagent-gate` 入口、父侧注册与 dispose；keys-profile 不装载；删除 credential guard。
- [x] 删除重入 helper 与 `piSubagentHelperKinds`；打包形态不装载 subagents。
- [x] 测试：删除 vendor/重入相关测试，新增 gate 注入、keys-profile 不装载、打包形态不装载、external runner 拒绝的回归。
- [x] spec、client README、CHANGELOG、upgrade-manifest、THIRD-PARTY；api-surface golden 与预算。
- [x] CI 登记；build / typecheck / test / api-surface / version-authority / release-pack；PR。
- [x] 上游：向 nicobailon/pi-subagents 提议宿主 runner 命令扩展点（方案 a）：https://github.com/nicobailon/pi-subagents/issues/3105

## 实施记录

- 原假设“`byok-pi-rpc`/`byok-pi-prepared`/`byok-pi-durable` 的 `__byok_sdk_helper` 只服务子 agent 重入”不成立：prepared 描述进程经它启动 MCP helper（`prepared-agent-memory.test.ts` 捕获）。三个 bin 保留 reserved helper 分派，只删除子 agent 种类。
- 新增端到端：前台原生子 agent、后台 runner 进程中的子 agent均经父 gate；external-cli 在启动前被拒（拒绝文本含 `byok-tool-authorization`）；keys-profile 通道不提供 `subagent` 工具；单文件 CJS 产品（普通/sealed）经 `pi-rpc` 跑真实会话且无 `subagent`。
- CI 首轮：`pi-rpc-host.test.ts` 清理时 `ENOTEMPTY`。根因是 pi-subagents 在 session 启动时执行 `npm root -g`（全局 agent 发现，遵守 `PI_OFFLINE`）；测试只对 host 发 SIGTERM，孤儿 npm 随后写 `$HOME/.npm/_logs`。daemon 路径清理整个进程树，不受影响；三个启动 host 的测试按仓库惯例改为带重试的删除。
- 删除 vendored workflow 探针：其测试对象（arbiter、workflow worker、permit）属上游内部，0.83 已删除 arbiter，且包 `exports` 不暴露内部路径。
- 本机全量 client 测试在负载 10–16 下每轮有 15–25 个时序用例失败，集合每轮不同；同批文件在 merge-base 上同样间歇失败（retention、daemon 循环、bin-start、durable recovery 等，均不经过 Pi subagents）。以 CI 为准。
