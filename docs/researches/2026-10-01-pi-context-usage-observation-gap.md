# Pi context usage：现有公开字段的只读投影

基线：main `12ca4402`，2026-10-01；只做静态 trace，无 provider 请求或新插件。

## 结论与界限

**字段足够：Host 直接消费，SDK 不改。** 可展示“最后一次观察到的 prompt tokens”和 prepared “初始/峰值”，缺少证据显示 unknown；Host 若已经拥有可见输入，可另给 estimated 数字。不能把这份结论扩大为“SDK 能提供实时精确的当前占用、剩余容量或 system/tools/turns 精确分桶”。这些目前 unknown，不能填 0。

三类是 **Host 展示的来源分类**，不是当前 SDK 已有的 source enum。provider-reported 在本文特指可信 Pi adapter 对 native assistant usage 的投影，未经本次真实 provider 复核。仅 `runtime: pi` 或一个数值不证明来源：自定义 adapter、未知版本或未知 producer 应显示 unknown，不能猜成 provider-reported。

## P1/P2/P3：边界与完整路径

P1：Pi adapter 映射 runtime observations，daemon 保留最后一条；cloud 持久化并公开 terminal evidence；Host/UI 拥有展示、可见 context 和模型配置。`packages/ui-runtime/src/types.ts:80-86`、`packages/ui-runtime/src/timeline.ts:296-303` 只投影 optional token fields，不提供来源 enum/百分比。`examples/basic/public/index.html`、`examples/basic/server.ts` 没有 usage/contextWindow 展示命中；外部 SaaS Host 的既有 UI 实现未证。

P2：native assistant message_end → `packages/client/src/adapters/pi/events.ts:55-76` 的 usage → `packages/client/src/daemon/task-runner.ts:3762-3777` 的 lastUsage/prepared observation → 同文件 `:4853-4892` 生成 terminal → `packages/cloud/src/terminal-result.ts:100-114` 保存 usage/preparedObservation → 公开 `packages/server/src/index.ts:186-193` 的 tasks.deviceTerminal；实现 `:774` 调 cloud，`packages/cloud/src/cloud.ts:2323-2325` 读 durable terminal receipt。实时事件展示可能受 egress policy/投递影响；这条 terminal 路径不保证 running 时可见。

P3：保留 observation 与 admission 的边界。UI 标注 scope/来源/时间，不增加插件、模型调用或自动 compaction；估值来自 Host 可见数据，本地使用，不上传 raw prompt/tool body。

## 字段 → 来源 → 三类映射

| 公开字段/输入 | 来源与语义 | Host 分类与展示限制 | 源码 |
|---|---|---|---|
| AgentEvent.inputTokens | Pi native input + cacheRead + cacheWrite；三项均合法才生成，非累计 | 可信 Pi 来源：provider-reported，单次调用 whole prompt；缺项 unknown | `packages/client/src/adapters/pi/events.ts:27-28`、`:41-75` |
| cachedInputTokens | native cacheRead；不是 system/tools token bucket | provider-reported cache read observation；不能从 cacheRead/cacheWrite 拆出 system/tools | 同文件 `:59-72` |
| outputTokens/reasoningTokens/totalTokens | 各 native 数字独立校验、独立 optional | provider-reported 的对应指标，不是 prompt 占用；缺字段 unknown，不自行补齐 total | 同文件 `:66-75` |
| terminal payload.usage.promptTokens/completionTokens | 最后观察的 input/output，不累加；未启动或没有可读计数可无 usage | 可信 Pi 来源按上述分类；scope=last-observed-call；缺失 unknown，真实 0 才显示 0 | `packages/client/src/daemon/task-runner.ts:3762-3767`、`:4853-4873`；`packages/protocol/src/messages.ts:1145-1168` |
| usage.provider/model/reportedAt | provider/model optional；当前 daemon builder 未写 provider/model；reportedAt 是 device terminal observation 时间 | 缺 provider/model unknown；reportedAt 不是 provider call 的精确发生时间/新鲜度保证 | `packages/protocol/src/messages.ts:1153-1168`；`packages/client/src/daemon/task-runner.ts:4865-4873` |
| preparedObservation.initialPromptTokens/maxPromptTokens/requestDigest | prepared 首次/最大 observed prompt，绑定 frozen request；不是最后一条、当前值或所有调用总和 | 可信 Pi 来源 provider-reported；显示 initial/peak，先与 Host reservation 的 requestDigest 对齐 | `packages/protocol/src/messages.ts:1172-1205`；`packages/client/src/daemon/task-runner.ts:4883-4892` |
| input-preparation artifact.requestBytes/projectionBytes | 字节长度；projection 仅 kind/digest，没有完整 context body | 非 token observation，不可直接归入 reported/estimated token；没有独立 estimator 则 token 值 unknown | `packages/protocol/src/input-preparation.ts:585-595`、`:615-633` |
| model.contextWindow/model.maxTokens/options.maxTokens | Host 提供的 prepared model/options；session 使用这些配置；不是 provider 实测剩余容量 | 单独标 configured denominator/output reserve，不能伪装 provider-reported；无同 model/revision 配置则比例 unknown | `packages/protocol/src/input-preparation.ts:243-256`、`:272-284`；`packages/client/src/adapters/pi/prepared-session.ts:239-269` |
| Host 可见 transcript/system/tool schema 的本地 estimator 输出 | Host 自有输入，不是 SDK 已提供的估值；必须标 method/version/coverage/snapshotRevision | estimated，仅 visible-input-estimate；遗漏隐藏/后续 tool context 时不能称全 prompt | 无现有 SDK estimator 输出声明；prepared artifact 不含 body：`packages/protocol/src/input-preparation.ts:593-595` |
| 当前 exact occupied/remaining、精确 system/tools/turns buckets | 上述公开计数不提供这组实时事实 | unknown；不能由 last/peak、cache 或 chars/4 假造 | `packages/protocol/src/messages.ts:1145-1205`；`packages/ui-runtime/src/types.ts:80-86` |

terminal 缺失不等于零；usage 存在也不意味着 promptTokens 必然存在。只读 duration/clientVersion 是执行元数据，不能用于推断 tokens。不同 runtime 的数值不自动共享 Pi 的 provenance 解释。

## Host 消费示例（仅文档，不是新 SDK API）

下面 `trustedPiSource` 必须由 Host 的部署/adapter attestation 及 exact task binding 确定，不能来自用户输入或单凭 runtime 字符串。deviceTerminal 要通过 tenant-scoped server、reservation 的 exact taskId 读回；这不是自动 admission 决策。

```ts
const terminal = await byok.tasks.deviceTerminal(reservedTaskId);
const envelope = terminal?.envelope;
const payload = envelope?.type === 'task.complete' ||
  envelope?.type === 'task.fail' || envelope?.type === 'task.cancelled'
  ? envelope.payload : undefined;
const usage = payload?.usage;
const n = usage?.promptTokens;
const display = trustedPiSource && usage && typeof n === 'number' &&
  Number.isSafeInteger(n) && n >= 0
  ? { kind: 'provider-reported', value: n,
      source: 'pi-native-assistant-usage', scope: 'last-observed-call',
      observedAt: usage.reportedAt, taskId: reservedTaskId }
  : { kind: 'unknown', value: null, scope: 'last-observed-call' };
// Current occupancy has no observation here, even if the last-call value exists.
const currentOccupancy = { kind: 'unknown', value: null };
```

有 Host-owned estimator 时另输出 `{kind:'estimated', method, version, coverage:'visible-input', snapshotRevision, value}`，不要覆盖 display 或 currentOccupancy。两个来源可并排；没有估值就不造一个。若显示 last-prompt/window 比例，分母必须是同模型/配置 revision 的窗口，标题明确“最后观察值相对于配置窗口”，不能名为“当前可用百分比”。分母未知则比例 null，不能从 requested model 名推断实际 observation。

## admission、反证与停止条件

**不能用估值替代 token admission。** exact requestBytes 是 byte evidence，不是 token estimate；其 accounting policy/常量/输出预算另有权威：`packages/protocol/src/input-preparation.ts:621-626`。preparedObservation 用于 Host 对自身预算 ruling 的事后核验，普通 usage 是非计费 telemetry：`packages/protocol/src/messages.ts:1188-1192`；`packages/cloud/src/terminal-result.ts:54-67`。不要把 provider-reported 的 last/peak 也当成下一请求准入凭据。

prepared 关闭 native compaction：`packages/client/src/adapters/pi/prepared-session.ts:324-327`。高占用 UI 不触发自动 compaction/steer，也不更改 frozen input。

Falsifier：若消费者的验收明确要求 running 中每次请求的当前精确 prompt/window/reserve，或要求无 Host producer 信任配置即可区分任意 adapter 的估值与 provider 数值，则现有字段不够。这会推翻“足够做本文限定展示”，应另提绑定 task/request ordinal、source、scope、观察时间的最小只读增量，先离线 fixture 证明缺口；本刀不实施、不改 wire。

停止条件：需真实 provider/插件、缺公开导出、需要发送 raw body、新 observation wire、architecture gate 或 daemon mismatch。10x 下先关注高频 usage timeline 的 retention/fanout；默认只存最后/峰值读模型，不为展示保存或上传完整 prompt。

## 验证

静态源码/行号核对、无生产源码 diff、workflow strict；具体退出码记录任务 notes。build/typecheck/root test/API/version **未跑**，没有安装依赖、provider 调用或 native Pi 探针。真实 provider 的 usage 语义与下游现有 SaaS UI 都未运行验证；本文不宣称完成产品集成。
