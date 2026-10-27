# #977 Pi `submit_result` 产品门禁：证据清单

状态：证据清单和复跑步骤。门禁结论待测量（pending measurement）。

日期：2026-10-27。基线 tag `v0.30.2`（`b1469e5a`），`@byok-sdk/*` 九包 0.30.2。
依据：[#977](https://github.com/Ancienttwo/byok-sdk/issues/977)、[#610](https://github.com/Ancienttwo/byok-sdk/issues/610)、[测量方法](../submit-result-measurement.md)、[K8 validation 记录](../../examples/bot-collaboration/VALIDATION.md#open-acceptance-rows)。

本文不记录新的测量数据。下面的数字都注明来源；数据集没有入仓的，标 `[unverified: dataset not attached]`。

## 1. 验收项对照

| #977 验收项 | 状态 | 证据 |
| --- | --- | --- |
| #610 方法已合入，VALIDATION 行能点到方法 | 满足 | 方法 `39545751`、`1ed9d8ca`（#670）；runner `ad3c7d94`（#795）、`e0197f91`（#799）、`b64851bc`（#802）。VALIDATION 已按 cell 拆行 |
| Pi @ 0.30.2 至少一组 N 次实测 | 有报告值，数据集未入仓 | `submit-result-v1` 120 个计数 trial，见 §2 第 1 行 |
| AiphaBee macOS + Windows 同一条结构化 outcome 路径 | macOS 只有代理 cell；Windows 没跑 | §2 第 2–4 行 |
| 维护者/PM 写门禁结论 | 待测量 | §5 |

## 2. Cell 清单

cell 按方法文档冻结：runtime、provider/模型、平台、语料、是否带 `messageEgress` 任何一项不同就是另一个 cell，不合并。

| # | Cell | 语料 | 状态 | 结果 | 来源 |
| --- | --- | --- | --- | --- | --- |
| 1 | `pi.zai_glm-5.3-flash.darwin-arm64`，Pi 1.4.0，无 `messageEgress` | `submit-result-v1` | 已跑，数据集未入仓 | valid 76/120（95% CI 54.4–71.4%），exact 65/120；C01–C03 各 20/20；C04-union 1/20（18 次 `terminal_failure`）；C05-unicode valid 15/20、exact 4/20；C06-large 20/20 在 600 s 超时 `[unverified: dataset not attached]` | [#977 评论](https://github.com/Ancienttwo/byok-sdk/issues/977#issuecomment-6433620715)，run `m977-pi140-glm53flash-v0302-20261027-r2` |
| 2 | `pi-1.4.0/proxy/zai/glm-5.3-flash/darwin-arm64/reply`，`messageEgress` `aiphabee.bot-chat.reply.v1` maxBytes 65536 | `aiphabee-bot-chat-ask-user.v1`（扩展语料） | 已跑，导出在 AiphaBee 本机 | valid 40/40（Wilson 91.2–100%），first-call-valid 40/40，A02 exact 20/20；其余分类 0；回复 sent 40；A01 耗时中位数 38.9 s / p95 58.4 s，A02 29.3 s / 41.7 s | AiphaBee 导出 `m977-count-proxy-zai_glm-5.3-flash-20261026T210918Z` 的 `summary.md`（本 worker 上读过）；**不代表产品条件**，见下方更正 |
| 3 | `pi-1.4.0/zai/glm-5.3-flash/darwin-arm64/reply`（原生 provider） | 同上 | 只有校准（不计数） | 1 个校准 turn：`Complete`，标签 `submit_result`，回复 accepted，交了单选题；耗时 73.5 s | AiphaBee 导出 `m977-calibration-zai-glm-5.3-flash-20261027T035319Z`；计数 `[blocked: paid Pi runs / owner auth]`；**不代表产品条件**，见下方更正 |
| 4 | 同 2 或 3，`win32-x64` | 同上 | NOT RUN | — | `[blocked: no Windows seat on this worker]` |
| 5 | Claude / Codex / Grok 各 cell | `submit-result-v1` | NOT RUN | — | PRD Q8 定 v1 只用 Pi，不挡本门禁 |

**更正（2026-10-28）：第 2、3 行没有产品条件。** AiphaBee 的测量 runner 当时把 bot 的 Agent home 放在 AiphaBee 仓库目录里。Pi 从 cwd 往上读 context 文件，每次请求都带上了仓库根目录的 `AGENTS.md` 和 `CLAUDE.md`（给编码 agent 的指令）。产品里 bot 的 Agent home 不在任何仓库里，没有这段指令。受影响的 run：第 2 行的 40/40 计数 `m977-count-proxy-zai_glm-5.3-flash-20261026T210918Z`（[#977 评论 6428287503](https://github.com/Ancienttwo/byok-sdk/issues/977#issuecomment-6428287503)）、第 3 行的校准 `m977-calibration-zai-glm-5.3-flash-20261027T035319Z`，以及未入本文的 8 个模型代理校准和一次已作废的计数。第 1 行是本仓库自己的 `submit-result-v1` run，不受影响。runner 已改为在仓库外的临时目录里跑，更正见 [#977 评论](https://github.com/Ancienttwo/byok-sdk/issues/977#issuecomment-6450158833)。第 2、3 行需要在新 runner 上重新测量，两行的数字在那之前不能当作产品门禁证据。

第 1 行和 0.30.2 发布前 `ebcb8d96` 那次（valid 73/120，exact 63/120，[评论](https://github.com/Ancienttwo/byok-sdk/issues/977#issuecomment-6414261055)）在误差范围内一致。两次都不合并计数。

第 2 行经过本机 OpenAI 兼容代理，代理可能改写请求，数字不能当 zai 原生 API 的结果。

第 4 行在 0.30.2 上另有一个和 `submit_result` 无关的问题：daemon 的 store 路径如果是别名（比如 8.3 短名），重启时会碰到 [#1030](https://github.com/Ancienttwo/byok-sdk/issues/1030)（`retention_root_identity_invalid`），daemon 起不来。

## 3. 已知缺陷与差异

- **C04-union**：两次运行都几乎全是 `terminal_failure`，原因还没定位。#1003 / #1005（`a3af443f`，在 main，不在 `v0.30.2` tag 里）修的是 prepared lane 编译根部 `oneOf` schema 的缺陷；#1005 写明它不能解释 #977 普通车道的结果。下一步先读第 1 行 C04 trial 的原始 reason，再决定修 SDK 还是归为模型行为。
- **C06-large**：20 次都跑满 600 s 截止。方法文档的 C06 规则把它单独列一行，不当作模型不交结果。
- **C05-unicode**：valid 和 exact 差得多（15/20 对 4/20），模型交的文档通过 schema，但内容和目标不一致。
- **C04 和 ask_user 的差别**：同一个模型，C04 根部 `oneOf` 在 0.30.2 上几乎全失败，ask_user 的 `oneOf` 在 `ask_user` 字段里，经代理 40/40。可能和 `oneOf` 的位置有关，也可能是代理改写了请求；第 3 行的原生计数能排除代理这一项。

## 4. 复跑步骤

### 4.1 byok-sdk 基线 cell（第 1 行）

在 `v0.30.2` 的干净 checkout 上：

```bash
bun install --frozen-lockfile
bun run build
# 不花钱：只打印计划
bun examples/bot-collaboration/src/submit-result-measurement/cli.ts --runtime pi --model zai/glm-5.3-flash
```

2026-10-27 在本 worker（darwin-arm64）上跑的 dry run 输出：

```text
DRY RUN: no daemon, no runtime and no provider call.
Cell: pi.zai_glm-5.3-flash.darwin-arm64
Runtime: pi; model zai/glm-5.3-flash (from the Pi configuration; recorded as a label)
Corpus: submit-result-v1; preflight ok
Plan: 1 uncounted calibration trial + 20 rounds x 6 cases = 120 counted trials
Runtime tasks: 121 (max-trials 120). Each task makes at least two model requests; token counts are unknown until measured.
Instruction bytes: 65850 per round, 1317000 in all counted rounds.
```

付费运行要 owner 批准。Pi 用它自己配置里的模型，runner 只把 `--model` 记成标签：

```bash
bun examples/bot-collaboration/src/submit-result-measurement/cli.ts --runtime pi --model zai/glm-5.3-flash \
  --execute --authorization <approval-ref> --deadline-ms 600000 --max-spend <label> --out <dir>
```

### 4.2 AiphaBee ask_user 路径（第 2–4 行）

runner 是 AiphaBee 的 `apps/local-agent/src/bot-chat-outcome-live.test.ts`，随 AiphaBee 的 PR 379 合入 AiphaBee main（squash `95b9c6c9`），AiphaBee 钉 `@byok-sdk/*` 0.30.2。环境变量和命令以该文件头部注释为准。

- `AIPHABEE_LIVE_BOT_CHAT_OUTCOME_PROVIDER=loopback`：不花钱的 dry run，检查管线，manifest 标 synthetic。
- `=zai`：原生 provider，需要 `AIPHABEE_LIVE_BYOK_DATA_DIRECTORY`、`AIPHABEE_LIVE_BYOK_PROFILE_REF` 和授权引用。第 3 行的计数用 `AIPHABEE_LIVE_BOT_CHAT_OUTCOME=count`、`_ROUNDS=20`。
- `=proxy`：经本机代理，cell 记成 `proxy/<model>`，不能当原生结果。
- Windows：在 win32-x64 真机上用同一个 AiphaBee 提交和同一组变量再跑一次第 3 行，得到第 4 行。

### 4.3 报回

按方法文档「Updating acceptance」：提 PR 改 K8 validation 对应的 cell 行，附脱敏后的 `manifest.json`、`trials.jsonl`、`not-started.jsonl`、`summary.md`，PR 写 `Refs #610`。issue 评论只指向 PR。AiphaBee 是私有仓，导出要先脱敏、经 owner 同意再进公开仓。

## 5. 门禁结论草案

**待测量（pending measurement）。** 现在不能写「通过」或「不通过」：

1. 第 1 行的数据集没有入仓，C04 的 `terminal_failure` 原因没定位。
2. AiphaBee 路径在 macOS 上只有代理 cell 的计数（40/40）；原生 provider 只有 1 个校准 turn。这些 run 的 Pi 上下文带着 AiphaBee 仓库的编码 agent 指令，不代表产品条件，需要在新 runner 上重测。
3. Windows 没跑。

要下结论，至少还要：第 2 行代理计数在新 runner 上重测；第 3 行原生计数（40 个 trial，`[blocked: paid Pi runs / owner auth]`）；第 4 行 Windows 计数（`[blocked: no Windows seat on this worker]`）；第 1、2 行的脱敏数据集入仓。通过的阈值由 owner 定，方法文档不给阈值。
