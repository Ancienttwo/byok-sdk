# Lane M：发布 JS 注释清理与组合验收

状态：配置与本地组合验收完成；GitHub 最终 CI、依赖 PR 合并和发布仍独立跟踪。
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

## Parent final composition evidence — 2026-10-28

Product inputs are frozen in candidate tree `ad0a16f39c3c5fa1d8c9541c704e1a0697b87046` (artifact source `04b4aa4a62b3f55b8cbc6d34af0f8dc350081acb`; merging current main produced `679f09f8e` with the identical tree). The composition includes the independently reviewed fixes and tool controls, M, and #1012. This is a development candidate whose manifests still say 0.30.2, not a republished 0.30.2 or an npm 0.31.0 release.

- Root build, final typecheck, API surface and version-authority: exit 0. Full `bun run test` second run: exit 0; 20 Vitest workspace summaries total 13,551 passed / 822 skipped. Optional substrate/platform skips are not external deployment evidence.
- The first full run exposed two stale contract assertions (forged Host env wording and exact memory module graph), now precisely aligned with the reviewed authority changes. A sealed-steer timeout was not reproduced by candidate/baseline named cases or the candidate's 69-test file; its first failure remains unattributed. No assertion or timeout was relaxed for that case.
- Parser audit of all 38 package dist JS files (including the private testkit and all published dist JS) found zero ordinary comments; 86 remaining comments are legal notices, shebang/map markers or semantic annotations. Fourteen copied license/provenance files match their inputs byte-for-byte. Five map samples (client, todo, sealed host, core and core sealed entry) resolve to exact source contents.
- All public declaration goldens remain unchanged by M/#1012. In addition, cloud `cloud.d.ts` and `index.d.ts` compare byte-for-byte with the validated unchanged-cloud baseline.
- Forty-three closure limits are pinned to measured composition sizes; non-budget policy values are unchanged. Only sealed-host codegen locations needed regenerated facts. The cloud split no longer exceeds its old limits: cloud 496237 B, cloud-dataplane 721316 B, runtime 685791 B, server 632143 B, ui-runtime 519691 B. Adapter/testing increases in the combined table account for the separately reviewed runtime controls, not extra budget headroom for the split. Coordinator wB:p4 signs this exact composition under #1008 authority.
- Native helper build reproduces darwin-arm64, darwin-x64 and win32-x64 bytes from two independent source paths. This is build reproducibility, not Windows power-loss qualification.
- `bun run check:release-pack -- --out-dir _ops/release-pack-04b4aa4a`: exit 0, nine tarballs. Installed root/adapters/CLI MCP tools/call and submit_result smoke pass, as do asset integrity and official Pi pin checks. The prior packed fixture was corrected to require exact SDK helper grants while rejecting default Host grants; no production code changed.

Local receipts: `_ops/lane-m-{artifact-audit,map-license-audit,measured-closures}.json`, `_ops/release-pack-04b4aa4a/release-manifest.json`, and `/tmp/byok-final-composite-{build,test-r2,typecheck-final,api-final,version-final,pack-r2-run}.log`. Final CI must bind the reviewable PR head. Individual pre-M budget records in other plans are historical; `api-surface/entries.json` is the current budget authority.


## Reviewed CI scope for M build inputs

Coordinator wB:p4 approved the exact sealed-client path to retain ordinary client tsup coverage, and the complete M changed-file audit identified seven more precise build inputs. Each selects its actual workspace owner plus npm-release-pack; existing dependency expansion and family ownership remain intact. No tsup wildcard or unknown-path fallback is added.

| Exact path | Workspace |
| --- | --- |
| `packages/client/tsup.sealed.config.ts` | `packages/client` |
| `packages/cloud-dataplane/tsup.config.ts` | `packages/cloud-dataplane` |
| `packages/cloud-do/tsup.config.ts` | `packages/cloud-do` |
| `packages/cloud/tsup.config.ts` | `packages/cloud` |
| `packages/protocol/tsup.config.ts` | `packages/protocol` |
| `packages/server/tsup.config.ts` | `packages/server` |
| `packages/testkit/tsup.config.ts` | `packages/testkit` |
| `packages/ui-runtime/tsup.config.ts` | `packages/ui-runtime` |

The complete changed-file selector run against main c4a725603 resolved all 71 paths. Selected workspaces: `examples/basic`, `examples/bot-collaboration`, `examples/byok-mcp-server`, `examples/codex-interaction-host`, `examples/host-execution-core`, `examples/hosted-bot-collaboration`, `examples/hosted-bot-collaboration-worker`, `examples/live-activity-host`, `examples/packaging`, `examples/salesko-connector-broker`, `packages/client`, `packages/cloud`, `packages/cloud-dataplane`, `packages/cloud-do`, `packages/conformance`, `packages/core`, `packages/keys`, `packages/protocol`, `packages/server`, `packages/testkit`, `packages/ui-runtime`.

Selected families: `adapter-lifecycle-smoke`, `credential-isolation-audit`, `dataplane`, `npm-release-pack`.

`node --test scripts/ci/select-impact.test.mjs scripts/ci/plan-ci.test.mjs`: 54 passed, zero skipped. Regressions require sealed/ordinary client scope equality, owner-consumer and pack coverage, rejection of nearby unknown configs, and failure when required pack coverage is skipped. The complete release-only matrix is not used as a fallback. Product sources, build inputs and all 43 measured budget values remain unchanged.
