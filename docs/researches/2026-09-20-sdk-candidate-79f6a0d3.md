# SDK 候选元组：`79f6a0d3`（2026-09-20）

## 0. 这份记录解决什么

两仓之间此前没有「一套可独立安装、可共同验证的产品组合」：Host 侧消费的是**开发 symlink**（随本地工作树变化），且混用不同提交构建的包。本记录冻结**一组同源、相互匹配、可独立安装**的 SDK 候选包，供 Host 在隔离 worktree 中消费并做有界验证。

**这不是 npm 发布，也不是部署事实**，也不代表候选已通过完整验收。

## 1. 元组身份

| 项 | 值 |
|---|---|
| 源码提交 | `79f6a0d35952392c37652cb2f7fecaf6dcc255a6`（`origin/main` HEAD，Merge PR #209；**不含** 官方迁移分支的任何提交） |
| release 版本 | `0.18.0`；`@byok-sdk/keys` 独立为 `0.5.0` |
| 构建环境 | node `v24.18.0`，darwin / arm64 |
| 包数量 | 10（`core`、`implementation-identity`、`protocol`、`server`、`cloud`、`client`、`cloud-dataplane`、`ui-runtime`、`testkit`、`byok-sdk`）+ `keys` |
| manifest | `release-manifest.json`，`sha256 = 3ffb554bc9261b45482277d3de14ee83b2397c7a58df7af9d44dea64d51ba934` |
| 产物位置 | `_ops/candidate-freeze-20260920-main-79f6a0d3/`（本机忽略目录，不进 git；共 11 个文件 / 11 MB） |

### 1.1 逐包 hash（来自 manifest，sha256 与 sha512Integrity 并列）

| 包 | 版本 | sha256 |
|---|---|---|
| `@byok-sdk/core` | 0.18.0 | `8dbaa5aa7cef6e52ed596294dc3ec55d2705caee2fa4c5c8ddf9adba1fa2ebfb` |
| `@byok-sdk/implementation-identity` | 0.18.0 | `c8d02f81232591b45dc0181473e3fad3ff5710b4f27133c0a21409b3a6e08d84` |
| `@byok-sdk/protocol` | 0.18.0 | `7178d312c0ff78b465c3d9fdc29bd9ac89c0b03184b2d316c82a954331b74adc` |
| `@byok-sdk/server` | 0.18.0 | `9b0185d5136ce1e592031bea89d3a35e5af939b406544cdb205d4e1f247bd960` |
| `@byok-sdk/cloud` | 0.18.0 | `9507578682f0fe8f28ebe8f2901397b814ddbfe6df85dee6ba391af39b0c0bc7` |
| `@byok-sdk/client` | 0.18.0 | `fdc673ea40cfdd681030cd0ef0f06e56e6072cb765ae8f1cb9ff912e8d3326b7` |
| `@byok-sdk/cloud-dataplane` | 0.18.0 | `75908e6dd284360195ec9a5a8c584643c12c3000c62c190a136cb5e3630c5658` |
| `@byok-sdk/ui-runtime` | 0.18.0 | `eeacb3ecc85e9f36b0576cd38ca5839d0ec8b5b902bf7e58307385187771a1a0` |
| `@byok-sdk/testkit` | 0.18.0 | `99590e7749ed9752cc437899ce3af3c0d66492155c1d18480a9f161d492a2de5` |
| `byok-sdk` | 0.18.0 | `10ccb1701c9d29f5d279e601b86d0f91f0828ed5f4eb40dd01adf00842254d90` |
| `@byok-sdk/keys` | 0.5.0 | `695e22f0effecb2cb3e52a3caec559dc12adebde8cd7b0a6988874471d71559c` |

（`sha512Integrity` 逐包同列于 `release-manifest.json`，供 Host 以 npm integrity 形式校验。）

## 2. Pi 运行时身份（实际产物，非声明）

打包器在临时 npm 安装树中实测并断言（原始输出）：

```
[release-pack] single @byok-sdk/pi-coding-agent@0.85.1006 runtime at node_modules/@earendil-works/pi-coding-agent;
upstream @earendil-works/pi-coding-agent manifests=0;
dist/core/prepared-session-input.js present;
byokFork.upstreamCommit=d981de1229ef899957bbe968bc8dcda02a21f477
```

即：**仍是自维护 fork（`0.85.1006`）**，`prepared-session-input` 入口存在，上游包未被混入。`@byok-sdk/client` 的 `byok.piRuntimePin` 与之一致。

> 与 OP0 记录的来源问题相同且仍未解决：该 fork 包在 npm 上没有可绑定的构建提交与 provenance attestation。本记录只声明**本次构建实际装到了什么**，不为其补造证明。

## 3. 本次构建实际执行了哪些验证

由 `scripts/release/pack-and-smoke.mjs` 在固定提交的**干净** worktree 中执行（打包器自身拒绝脏 worktree）：

1. 构建 workspace 产物；
2. 逐包 `bun pm pack`，断言内部 `@byok-sdk/*` 依赖边闭合；
3. 把 tarball 安装到临时树，断言安装闭包与 Pi runtime 身份（上文第 2 节）；
4. packed CLI / adapters / root 三条路径的 **MCP `tools/call` 实际往返**：

```
[packed-cli-mcp] root: actual MCP tools/call passed
[packed-cli-mcp] adapters: actual MCP tools/call passed
[packed-cli-mcp] cli: actual MCP tools/call passed
```

**本轮未执行**：该提交上的全仓测试套件、平台矩阵、真实安装与进程重启验证。因此本记录不构成「候选已通过验收」，只构成「产物已冻结且可独立安装」。

## 4. 复现命令（另一份干净 checkout 可得到同一元组）

```bash
git worktree add --detach <path> 79f6a0d35952392c37652cb2f7fecaf6dcc255a6
cd <path>
bun install --frozen-lockfile
node scripts/release/pack-and-smoke.mjs --out-dir _ops/candidate-freeze-20260920-main-79f6a0d3
shasum -a 256 _ops/candidate-freeze-20260920-main-79f6a0d3/release-manifest.json
# 期望：3ffb554bc9261b45482277d3de14ee83b2397c7a58df7af9d44dea64d51ba934
```

同一提交 + 同一 lockfile + 同一 node 版本应得到同一逐包 hash；实测若不同，按「产物身份不一致」处理，不得继续消费。

## 5. Host 消费的已知缺口（先于 Host 验证记录在此，供直接对号）

前一轮 Host 侧消费实验（`docs/researches/2026-09-19-frozen-sdk-candidate-tuples.md`）已定位一处**接口缺口**，本轮候选**未改变它**：

| 项 | 内容 |
|---|---|
| Host 消费点 | `apps/local-agent/src/tool-implementation-authority.ts` 构造 runtime `nativeProvenance` 时 |
| 需要的接口 | `SUPPORTED_PREPARED_COMPILER_VERSION`（或「从已安装 fork 构造 nativeProvenance」的 helper） |
| 当前包实际提供 | **不提供**：它是 `@byok-sdk/client` 的模块私有常量（`packages/client/src/adapters/pi/input-preparation.ts:92`），既不在 `@byok-sdk/client` 根导出，也不在 `@byok-sdk/implementation-identity` |
| 责任方 | **SDK**（导出该权威；按 pre-1.0 policy 属 public API 增项，MINOR）。备选：fork 产物在 `byokFork` 里自带 `compilerVersion` |
| 为什么不能由 Host 自行解决 | Host 只能硬编码 `2`，复刻 SDK 内部权威，未来 forkBuild 换代时会静默漂移——属「权威值缺失须上报、不得本地重造」 |

同一实验的其他结果（供对照，非本轮复跑）：候选元组 + 原 Host 代码 = 250 pass / 0 fail；main 元组 + Host 迁移 = 242 pass / 9 fail，9 项全部来自该类缺口，而非 Host 迁移本身引入的回归。

## 6. 下一步（Host 侧，隔离 worktree）

在 Salesko adoption 分支的隔离 worktree 中：

1. 用本元组的 tarball 替换本地候选 symlink（不再指开发者本机目录）；
2. 跑有界消费检查：公开接口可导入 → `contracts` / `local-agent` / `byok-control` 可构建 → preparation 与 D2 所需接口齐全 → 既有定向测试；
3. 失败只输出「哪个消费点需要哪个接口 / 当前包提供什么 / 由谁修复」，不再以「等 0.19」作为阻塞项。

**完成标准**：另一份干净 checkout 不依赖开发者本机目录，也能复现同样的构建与定向验证。
