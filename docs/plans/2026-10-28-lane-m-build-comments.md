# Lane M：发布 JS 注释清理准备

状态：仅配置准备；未运行 build/typecheck/tests，未测量或修改 closure budgets，未完成 lane M 验收。
依据：[#1008](https://github.com/Ancienttwo/byok-sdk/issues/1008) owner 2026-10-27 决定；本次任务明确允许先准备配置，统一重测留给其他车道合入后的父方。
调查基线：`92be29d522141965c76f2ea854b4fb9763c5789b`。

## P1 — Map

- 根 `build` 调用 workspace build；10 个有构建的 packages 均由 tsup 生成发布 `dist` JS，之后由独立 `tsc -p tsconfig.build.json` 生成声明。conformance 无 build。examples 不在本切片内。
- client 的主构建还通过 `check-adapters-entry.mjs --build-todo` 调用 todo config，通过 `build-sealed-host.mjs` 调用 sealed config。主 config 已有 `minifyWhitespace`，todo 已有 whitespace/syntax minification 和 inline legal comments，不重复添加。
- core shared config 覆盖两个 entry；cloud-dataplane 两个 config 均需设置。cloud-do 的 Wrangler `dist-worker` 不在发布 files 内。
- client 资产脚本输出 JSON、复制声明和 LICENSE/THIRD-PARTY/provenance；memory helper 脚本输出 Go 二进制，不输出 JS，均不修改。未发现 `.codegraph/`；`.ai/context/capabilities.json` 和 `context-map.json` 在本 checkout 不存在，本切片不增加 scoped context。

## P2 — Trace

`src` entry → tsup/esbuild → 已有 Rollup treeshake → `dist/*.js` + sourcemap → manifest `files: dist`。独立 `tsc` 使用 `emitDeclarationOnly: true`，继承配置未开启 `removeComments`；手写 ACP/todo 声明原样复制。

只读检查主 checkout 已安装的 tsup 实现确认：`minifyWhitespace` 传入 esbuild；Rollup 继续消费已有 sourcemap 并生成映射。tsup 的 NODE_ENV 重写受 `replaceNodeEnv` 控制，本仓配置未启用该选项。不使用事后正则删注释，以免改变字符串或破坏映射。

## P3 — Decide

- 补齐其余 JS config 的 `minifyWhitespace: true`；所有 config 明确 `legalComments: 'inline'`（todo 已具备）。普通源码说明注释删除，legal comments、shebang、sourceMappingURL 和工具语义注解不作为普通说明注释删除。
- 不新增 identifier/syntax minification；保留现有 target、externals、插件、treeshake、define、清理顺序和 sourcemap；todo 原有 syntax minification 不变。d.ts 编译路径、LICENSE/NOTICE 资产路径不变。无新增依赖。
- 代价是 JS 排版压缩，调试依靠 sourcemap；source map 的 sourcesContent 仍可包含原始注释，这不是源码隐藏功能。10 倍构建图首先放大现有 bundling/treeshake 和 map 成本，本切片不增加扫描或后处理阶段。

## 父方统一验证

其他车道合入并冻结目标 head 后，在装好锁定依赖的集成 checkout 运行以下命令，分别保留退出码：

```sh
bun run build
bun run typecheck
bun run test
bun run check:api-surface
bun run check:version-authority
```

`check:api-surface` 同时报告所有 entry closure 的 bytes/budget；此处不使用 `--update`。预算调整与 lane M 验收由父方统一负责。

产物验收还需检查全部发布 dist JS 的普通注释已移除（用 JS parser，排除 legal comments、shebang、sourceMappingURL、工具语义注解），d.ts 文档与基线一致、LICENSE/THIRD-PARTY 资产完整，并抽查主 client、todo、sealed 及多 entry 的 sourcemap 能定位原始源码。配置准备不能替代这些产物证据。

发布包 smoke 需要 native helper 完整后另行运行：

```sh
bun run --filter @byok-sdk/client build:agent-memory-helper
bun run check:release-pack
```

本次只完成源码管线调查、配置 diff 自审及 `git diff --check`；上述构建、测试和产物验证均未执行。
