# 官方 Pi 迁移：两线合并裁定（w2:pB，2026-09-25）

## 结论
- **唯一 plan**：Codex 的 `plans/plan-20260925-0300-official-pi-087.md`（时间更早、范围更全，含 M4/M5）。w2:pF 的 `plans/plan-20260925-0331-pi-087-official-migration.md` 标记为 superseded，commit 不删，归档时注明"合并入 0300 plan"。
- **实现基线**：w2:pF 的分支 `claude/pi-087-migration`，worktree `/Users/kito/Projects/byok-sdk-wt-pi-087-migration`，HEAD 27d28c05，领先 main 7 个 commit，已有 conformance 与身份 gate 证据。
- **唯一 writer**：从现在起只有 Codex（w2:p7）写这个分支。w2:pF 不再向迁移分支写入，改为只读 reviewer；bisect 可以跑完并回报结论。Codex 的 `claude/official-pi-087`（checkpoint 37a2d0ee）只作为移植来源，不再单独推进。
- plan 文件的交接：Codex 把 0300 plan 以及 Amendment（A1''、U2、envelope v4、pi-tui 等裁定）移到基线分支上，作为唯一 plan；0331 plan 标 superseded。

## 需要移植或收尾的裁定项（Codex 在基线分支上完成）
1. **U2 wire/record 7**：prompt 只保留必填的 `systemPrompt`，删除 `customPrompt`（包括 pF 线用 customPrompt 承载整条 system 消息的做法）以及 append/cwd/toolSnippets/toolGuidelines/promptGuidelines/contextFiles/skills/docsPaths。一次切换，不做 dual read。
2. **envelope v4**：P(D) = 完整捕获的 D，residual = []，删除 `prepared-request.ts` 里的分类表。compilerVersion 与格式 id 沿用 pF 线的 v4 命名。
3. **provenance 命名**：attested record 的 `upstreamBase/upstreamCommit/forkBuild` 改为官方来源命名（例如 packageName、version、tarball integrity、gitHead），不保留 `forkBuild: 0` 这种空语义。与 wire 7 同一次切换。
4. **执行期两层 retry 关闭**：AgentSession `retry.enabled=false`，provider 层同样关闭。每次 stream 的 scoped fetch 最多发一次。只在编译期把 `maxRetries` 设为 0 不够。
5. **pi-tui 等带 native prebuild 的包**：不作为 client 的直接依赖，保持为传递依赖。精确性由 bun.lock integrity、M3 运行时 closure attestation 和 release-pack 三层兜底；spec 如实写明 win32-x64 prebuild。
6. **OPENAI_* 环境暴露**（pF 的新发现）：
   - (a) prepared host 子进程的 env 由显式 allowlist 构造，沿用现有 EnvironmentBuilder 的做法，不继承父进程 env。OPENAI_ADMIN_KEY、OPENAI_ORG_ID、OPENAI_PROJECT_ID、OPENAI_WEBHOOK_SECRET、OPENAI_LOG、OPENAI_CUSTOM_HEADERS 以及其他未声明的 OPENAI_* 一律不传入。
   - (b) 字节门同时校验请求头：只允许预期的 header 集合（content-type、authorization，以及 SDK 已知的固定头，以实测为准）。出现 OpenAI-Organization、OpenAI-Project 或任何自定义头，按 typed refusal 处理，零发送。
   - (c) 编译期：补一条 conformance，证明污染这六个变量后 D 字节不变（pF 已实测）。
   - (d) 残余风险写进 notes：daemon 进程里如果设置了 OPENAI_LOG，编译时 openai client 可能把请求写进本地日志。这是设备 owner 主动打开的调试开关，日志只在本地，接受这个风险。
   - purity 的 6 个红测应在 (a)+(b) 落地后转绿，不许放宽测试。
7. **G1/G2**：`validatePreparedModel` 拒绝空的 provider id；`projectTool` 拒绝没有 properties 的工具 schema。两者都 fail closed，与 fork 行为一致，并把对应的 it.todo 改成真实测试。
8. **14 个超时**：在相同负载下与 main HEAD 对照复跑。属于回归就修，属于负载就照原样报告，不放宽 timeout。
9. **release-pack 的 RuntimeDisposalFailure（packed-cli-mcp-smoke）**：等 pF 的只读 bisect 给出根因，Codex 按根因修复；修复之前 release-pack 不算过。

## 之后的顺序
M1–M3 全链（build/typecheck/test/test:scripts/api-surface/version-authority/release-graph/release-pack/strict workflow）全部通过 → 独立 gate → M4 递归/custody 回归 → gate → M5 C 重探（Owner 睡前说"完成全部任务"，按 ≤3 次普通推理、不调 tokenizer、key 不落盘执行）→ 发版准备，停在 dry run，publish 等 Owner。

## 第 9 条补充裁定

使用全新空 TMPDIR 做 test/release-pack 及 main 对照；不清理系统 TMPDIR。泄漏临时目录和 daemon.stop 遮蔽 smoke 原始错误另列 todo，本 WP 不修。pF bisect 判为 LIKELY 环境问题，尚不能替代当前合并结果的复验。

## 第 6 条编译 purity 修订（w2:pB 明确裁定）

INV-03 定义为 D 与环境无关，且读取集合精确受限。官方 OpenAI 构造器必读 OPENAI_ADMIN_KEY、OPENAI_ORG_ID、OPENAI_PROJECT_ID、OPENAI_WEBHOOK_SECRET、OPENAI_LOG、OPENAI_CUSTOM_HEADERS；读取集合必须恰好这六个，增减都阻止升级。不得全局 monkey-patch env。用污染后 D 不变、prepared 子进程不继承这些变量、header 门零发送共同锁定边界。设备 owner 主动设置 OPENAI_LOG 时，编译可能将请求写入本地日志；接受这个只在本地、不影响 D、不外发的副作用。
