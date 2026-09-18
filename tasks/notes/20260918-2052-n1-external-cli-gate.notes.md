# Notes: n1-external-cli-gate (20260918-2052)

## Seam 定位（P2 trace 结论）

external-cli 执行链（origin/main @ e0423d84 核验）：

- 定义来源全部在 vendored：agent 文件 frontmatter（`agents.ts:parseAgentRunnerFrontmatter`）、runtime registry（`runtime-agent-registry.ts`）、agent-management 更新面。**SDK 不拥有任何 subagent 定义注册面**——`adapters/pi/` 下唯一 subagent 相关面是 readonly ceiling（`subagents-policy-extension.ts`），auto 模式无 ceiling，且 name→kind 映射的权威在 vendored discovery，SDK 侧再建一个 name 门 = 第二权威，不做。
- external-cli 强制 async-only（vendored `subagent-executor.ts:6271-6276`：`runner.type='external-cli'` 只支持 async/background），而每个 background runner child 都由 `spawnRunner`（vendored `async-execution.ts:480`，两处调用 1254/1766 均同路径）写 runner config 后经 SDK dispatcher mint——runner config 的序列化 steps（`buildSeqStep` 透传 `a.runner`，`async-execution.ts:929`）是 kind 恰好一次穿越 SDK 边界的位置。
- 外部二进制唯一 spawn 点：vendored `external-cli-runner.ts:330`（`subagent-runner.ts:1502` 的 external-cli step 分支调用），在 runner child 进程内执行，SDK 侧唯一可拦截点是 config 交界的两个 custody 面。

## 拒绝点（file:line）

1. **dispatcher admission**：`packages/client/src/custody/custody-dispatcher.ts` — `dispatchCustodyPiSubagentSpawn` 内，edge vocabulary 检查之后、depth/铸造之前（现约 :490-498）。`child === 'pi-subagent-runner'` 时读 runner config 并扫描 steps；unreadable / 非 JSON / external-cli step 均以 `CustodyDispatchRefusalError` typed 拒绝，零状态（未准入）。放在 edge 检查之后是硬约束：five-edge `refuse-edge` 用例传入不存在的 config 路径且预期 edge 拒绝文案，门若在前会改掉该文案（回归）。
2. **runner payload 交界**：`packages/client/src/custody/pi-subagent-runner-payload.ts:34-38` — `runPiSubagentRunnerPayload` 在 `#byok-pi-runtime-host` import 之前扫描同一 config，拒绝即 stderr + exit(1)（对齐该模块既有失败形态）。覆盖 admission 后改写 config 与手工驱动 payload 两条缝；vendored runner closure 对被拒 config 永不加载。
3. **共享扫描/文案权威**：`packages/client/src/custody/external-cli-admission.ts`（新文件）— `findExternalCliRunnerStep`（纯函数，覆盖 vendored `RunnerStep` 三形态：sequential / `parallel[]` / dynamic `parallel{}`）、`EXTERNAL_CLI_CUSTODY_REFUSAL_PREFIX`（稳定断言串，含裁决引用）、`externalCliAdmissionRefusal(configPath)`（读文件→判定）。kind-based（`runner.type === 'external-cli'`），非 name-based：改名/手构定义不可绕过，且不引入第二 name→kind 权威。

五边零改动：门只新增拒绝分支，不改既有 admission/caps/permit/mint/settle 任何路径；`custody-five-edge-dispatch.test.ts` 全量重跑绿（26 用例含 charge-once 与 runner-entry 套件）。

## 明确不做（含理由）

- **`adapters/pi/` 定义面不加门**：SDK 无定义注册面（见 seam 定位）；readonly allowlist `BYOK_PI_READONLY_SUBAGENT_AGENTS` 里的三个 external-cli agent 名不动——那是 name 投影不是 kind 权威，动了会造出第二拒绝权威并改 readonly 错误文案；终态一致（仍拒绝，落到 dispatcher 的 typed 拒绝）。
- **vendored append 链（已记录 residual）**：在跑 chain 的 `append-step`（vendored `chain-append.ts` enqueue → runner 消费）携带 external-cli step 时不经 dispatcher，SDK 侧无拦截点，关闭它必须改 vendored 文件——按 stop rule 属 B 实现面，已记入 todos B 行，未在本刀夹带。
- **external-job kind 不在门内**：contract 只裁 external-cli；测试显式断言 external-job 通过扫描（钉住刀刃位置）。

## 测试面

`packages/client/src/__tests__/custody-external-cli-admission.test.ts`（15 用例）+ `fixtures/custody-external-cli-payload-probe.ts`：

- 扫描单元面：无 steps/pi/external-job 放行（含刀刃断言）、sequential/parallel/dynamic 三形态定位、file→verdict（admit/finding/invalid JSON/unreadable）。
- dispatcher admission：裸 external-cli + codex-exec/claude-code/cursor-agent/claude-code-writer 四 adapter 面 → `CustodyDispatchRefusalError` + 前缀 + 定位串 + adapter 名，零 custody 状态；parallel/dynamic 嵌套同拒；unreadable/invalid JSON 拒绝（无 fallback lane）；**clean config 控制组**仍正常 mint（证明 runner lane 本身未被过度拒绝）。
- vendored 端到端：`executeAsyncSingle` + external-cli agentConfig → `isError` + typed 前缀文案 + 零 mint 状态（SDK 面提交定义的 falsifier 路径）。
- payload 门：bun 子进程驱动真实 `runPiSubagentRunnerPayload` → exit ≠ 0 + stderr 前缀。

## 验证结论

- `bun install` ✓（457 packages）
- `bun run build` ✓；`bun run typecheck` ✓（client tsc + vendor tsc）
- `bun run --filter @byok-sdk/client test`：1 failed | 2872 passed | 11 skipped（Test Files 1 failed | 239 passed | 2 skipped）——唯一失败即 K1 已知本地项 `pi-s2-bundle-resolution.test.ts:327`（local registry tripwire，CI authoritative，本刀不修不碰）；其余含新 15 用例与五边/charge-once/runner-entry 全部绿。K1 该文件单独跑时绿，全套并发跑时 trip（本地网络环境项，与本刀 diff 无关，该文件不在 allowed_paths 内）
- `bun run check:api-surface` ✓（custody 模块不在 public exports closure，golden 零变化）
- `bun run check:version-authority` ✓
- `git diff --name-only origin/main..HEAD | grep -c '^packages/client/vendor/'` = 0 ✓（零 vendored 改动）
