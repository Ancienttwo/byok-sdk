# #2056 retained text / reasoning：确定性测量

Refs [#2056](https://github.com/Ancienttwo/byok-sdk/issues/2056)、[#2049](https://github.com/Ancienttwo/byok-sdk/pull/2049)、[#1932](https://github.com/Ancienttwo/byok-sdk/issues/1932)。

2026-11-14；被测源码 `7416804b4e1458f42458f900eacf94b8451369ac`，vendored OAR `95c6547`。这是测量文档，不包含修复或修复设计。

## 结论与证据边界

**确定性 native-frame replay 达到了几十 MiB：六个 runtime 对应的生产文本投影路径在 128 turn 后均保留 32 MiB text + 16 MiB reasoning = 48 MiB。** 每 turn 为 256 KiB text + 128 KiB reasoning。默认 16 MiB native/tool 预算生效，旧 native 已 elide，text/reasoning 仍完整保留；预算改为 1 byte 后结果仍是 48 MiB。另一组 16 turn、每 turn 2 MiB text + 1 MiB reasoning，也保留了 48 MiB。

这里测的是**运行真实 OAR 投影和 session kernel 的独立 Node 进程**。输入是本地生成的确定性协议帧，不是模型输出。没有启动 vendor CLI、provider HTTP 服务或完整 SDK task runner，也没有测 vendor 子进程 RSS。Grok、Antigravity 和 OpenCode 的行是同一 ACP 文本投影路径的独立运行，不能解读为三个 CLI 的性能差异。

因此可以确认 retained log 的线性增长机制和合成负载下的量级，**尚不能确认真实长 task 是否、多久或多频繁到达几十 MiB**。Issue 要求的「每 runtime 至少一个真实长 task」仍未完成；本报告不以合成 48 MiB 替代该项，也不据此直接决定排修复。保持 #2056 打开，后续在已确认登录且无额外计费的 CLI 上补实际 workload 样本。未访问凭证、读取认证文件、检查登录状态或调用收费服务。

## 方法

- 平台：Darwin arm64；Node `v24.18.0`。测量没有用 Bun 执行源码；本机 Bun `1.4.4` 只用于版本文档检查。
- 每组运行使用一个新 Node 进程，串行执行，避免本测量自己的并行进程竞争。默认预算来自 [`session-limits.ts`](../../packages/client/src/adapters/session-limits.ts)：`16 * 1024 * 1024`。
- 通过仓库已有 [`ts-source-resolve-hook.mjs`](../../packages/client/src/__tests__/fixtures/ts-source-resolve-hook.mjs) 直接加载 TypeScript，未安装依赖或生成 `dist/`。
- 每个 4,096-byte chunk 是固定 seed `2056` 的 xorshift32 生成的 ASCII 小写字母。每 chunk 使用新 buffer/string，并把 native frame 做 JSON stringify/parse 后才投影，避免对一个共享常量字符串计数 48 MiB 却只分配一次。字节数是 UTF-8 `Buffer.byteLength`，1 MiB = 1,048,576 bytes；不是 token 数、堆大小或完整事件 JSON 大小。
- 一个 synthetic turn 先输出 reasoning，后输出 text。`many`：128 turn × 96 chunk；`long`：16 turn × 768 chunk；二者总内容完全同量。多 turn 在同一 kernel/log 中累积，不重开 session。
- `many` 默认预算重复三次；`long` 和 `tiny-budget` 各一次。共 30 个成功进程。采样点是 turn 0、1、4、16、32、64、128 中适用于该场景的点。
- 每个采样点执行两次显式 GC，然后先读取 `process.memoryUsage()`，再遍历 log 计数。RSS 是测量宿主进程的当前 RSS；heap 是 V8 `heapUsed`。附录另存 `process.resourceUsage().maxRSS * 1024`，它是进程至此的峰值而非当前 RSS。
- 每次采样断言 text/reasoning 等于输入的精确累计字节，`turn_ended` 数等于已完成 turn，record seq 连续。默认预算还断言当前非 null native JSON 总量不超过 16 MiB。测量器不保存输出文本副本或 live observer 历史。
- `nativeBytes` 不计已 elide 的 `null` 字面量、事件 JSON 和元数据；这是未 elide native 的逻辑序列化字节，不能与 heap/RSS 相加。native 和投影事件可能共享字符串，RSS 也包含代码、分配器、GC 工作区和瞬态分配的影响。

## 各 runtime 覆盖了什么

所有路径最终调用生产 [`createSessionKernel`](../../packages/client/vendor/oar/95c6547/shared/session-kernel.ts) 和 [`recordRetention`](../../packages/client/vendor/oar/95c6547/shared/record-retention.ts)。没有重写 retention 算法。

| Runtime | 直接运行的投影 | 输入形状及限制 |
| --- | --- | --- |
| Claude | `foldClaudeStdout` | `stream_event` 的 `text_delta` / `thinking_delta`；`message_start`、`message_stop`、`result`。未生成最终 assistant snapshot；生产去重分支不在本测量内。 |
| Codex | `foldCodexNotification` | `item/agentMessage/delta`；`rawResponseItem/completed` 中 reasoning summary。reasoning 每 4 KiB 是一个独立 completed item，不是 reasoning token delta；不代表真实模型的 item 密度。 |
| Grok | `projectAcpUpdate` | `agent_message_chunk` / `agent_thought_chunk`；使用生产共享 ACP 文本投影。 |
| Antigravity | `projectAcpUpdate` | 同上；未运行 vendor profile 的握手、模型选择或限额。 |
| OpenCode | `projectAcpUpdate` | 同上；未运行 v1/v2 启动与 child attribution。 |
| DSH | `foldDsh` | `agent/assistant-stream` 的 `text-delta` / `reasoning-delta`，以及 `session/event` turn start/end。未生成 durable assistant message snapshot。 |

ACP 的 turn start/end 是 fixture 直接加入 kernel 的标记，不经过 ACP prompt RPC。它们只划分 synthetic turn，不携带正文。无 user prompt、tool、subagent、retry、compaction、redactor 或 result-text fold。这里的 turn 数、最大单 turn 输出是**设置并核验过的合成输入**，不是 provider 上限或已观察到的真实任务输出。真实 reasoning 还可能是 redacted/empty，不能把模型 reasoning token 数直接当成可保留字节数。

## 按 runtime 的量级

下表是 `many` 场景；每个 runtime 均为 **128 turn，最大单 turn 0.375 MiB，累计 text 32 MiB、reasoning 16 MiB、总量 48 MiB**。RSS 与 heap 单位均为 MiB。中位数来自三次独立运行，RSS 增量先在每次运行内减去其 turn-0 baseline，再取中位数。

| Runtime | RSS baseline 中位数 | RSS 终点中位数（范围） | RSS 增量中位数 | heap 终点中位数 | 未 elide native bytes | 已 elide / 总帧数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| claude | 76.66 | 195.56 (194.08–225.33) | 117.42 | 62.51 | 16774639 | 8565 / 12672 |
| codex | 67.77 | 172.36 (170.09–194.59) | 106.47 | 62.32 | 16774725 | 8456 / 12544 |
| grok | 87.42 | 206.86 (198.20–217.44) | 119.44 | 62.33 | 16775180 | 8475 / 12544 |
| antigravity | 88.58 | 243.47 (211.14–247.22) | 154.89 | 62.33 | 16775180 | 8475 / 12544 |
| opencode | 89.81 | 235.14 (234.77–235.44) | 145.63 | 62.33 | 16775180 | 8475 / 12544 |
| dsh | 89.53 | 234.23 (225.06–251.31) | 144.70 | 62.01 | 16774448 | 8426 / 12544 |

RSS 的测量噪声显著，尤其同一 ACP 路径的三组结果不能用来比较 runtime。更稳定的共同证据是终点 live heap 约 62 MiB，相比 baseline 约 8 MiB 增长约 54 MiB，且 retained text/reasoning 精确为 48 MiB。没有把整段 RSS 增量都归因于字符串，也没有将逻辑 UTF-8 字节等同于 V8 的实际字符串存储。

## 随输出量增长

下表为 `many` 场景 GC 后 RSS 的三次中位数，单位 MiB。原始单次读数在附录中。

| Turn | Text MiB | Reasoning MiB | 总量 MiB | Claude RSS | Codex RSS | Grok RSS | Antigravity RSS | OpenCode RSS | DSH RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 0 | 0 | 76.66 | 67.77 | 87.42 | 88.58 | 89.81 | 89.53 |
| 1 | 0.25 | 0.125 | 0.375 | 72.56 | 68.50 | 87.47 | 91.75 | 92.42 | 92.39 |
| 4 | 1 | 0.5 | 1.5 | 69.06 | 70.88 | 90.59 | 95.97 | 96.23 | 96.39 |
| 16 | 4 | 2 | 6 | 76.84 | 83.03 | 97.91 | 111.41 | 111.16 | 111.05 |
| 32 | 8 | 4 | 12 | 99.02 | 94.08 | 117.92 | 128.80 | 134.80 | 128.75 |
| 64 | 16 | 8 | 24 | 135.11 | 132.03 | 135.48 | 161.05 | 171.45 | 152.88 |
| 128 | 32 | 16 | 48 | 195.56 | 172.36 | 206.86 | 243.47 | 235.14 | 234.23 |

在 turn 64，总文本已经达到 24 MiB；turn 128 为 48 MiB。native 的逻辑预算到达上限后旧帧继续 elide，text/reasoning 没有随之归零或出现平台。前几个点的 RSS 可下降，不能用短区间 RSS 波动推断 log 释放。

## 长 turn 与极小预算对照

`long`：每个 runtime 16 turn，最大单 turn 3 MiB（text 2 + reasoning 1），累计 48 MiB（text 32 + reasoning 16），默认预算 16 MiB。

`tiny-budget`：每个 runtime 128 turn，最大单 turn 0.375 MiB，累计仍为 48 MiB，预算 1 byte。最新帧按生产策略始终保留，所以采样末尾最新 turn-end native 的 26–86 bytes 可以超过该预算；它不表示 native 限制失效。表中 1-byte 对照的大部分旧 native 已清空，约 61 MiB 的 heap 仍然存在。

| Runtime | Long baseline → 终点 RSS | Long 终点 heap | Tiny-budget baseline → 终点 RSS | Tiny-budget 终点 heap | Tiny-budget 剩余 native bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| claude | 92.38 → 245.83 | 62.13 | 95.09 → 209.13 | 61.42 | 54 |
| codex | 89.80 → 252.09 | 62.16 | 89.53 → 207.16 | 61.17 | 86 |
| grok | 73.73 → 190.58 | 62.26 | 80.09 → 222.42 | 61.20 | 26 |
| antigravity | 80.69 → 225.80 | 62.26 | 90.28 → 253.78 | 61.20 | 26 |
| opencode | 91.03 → 231.27 | 62.26 | 88.94 → 246.16 | 61.22 | 26 |
| dsh | 88.97 → 236.44 | 61.69 | 88.14 → 232.19 | 61.28 | 58 |

## 还需要什么证据

本次只通过 PATH 查询到 `claude`、`codex`、`grok`、`agy` 命令存在；`opencode`、`dsh` 未在 PATH 中找到。命令存在不证明已登录、可运行或不会额外计费，因此没有据此发起真实模型任务，也没有搜寻凭证或用户历史日志。

要完成 #2056 的真实 workload 条件，需要为每个可运行且确认不额外计费的 CLI 记录一个实际长 task：有效 provider/model、turn 定义与计数、每 turn 可见 text/reasoning 字节、最大单 turn、累计总量，以及 SDK 宿主和 vendor 进程各自的 RSS。缺少 CLI 或费用条件不明确的 runtime 应继续标记未测。无需为这份只读测量改 runtime 代码；修复是否排期仍由 #2056 的后续实测和决策确定。

## 验证与复现

30 组运行全部完成，所有字节、turn、seq 和默认 native 预算断言通过。`bun run check:version-authority` 通过。仓库 CI 的 `selectImpact` 对本文返回 `reason: docs-only`、`dirs: []`、`families: []`。未运行完整 build/typecheck/test/API-surface：本工作树没有依赖与 dist，build 会写入唯一允许文档以外的仓库路径。本次没有代码变更或 package/version 变更。

把下面两段分别保存为仓库外同一临时目录中的 `measure.mjs` 与 `run.py`，在上述源码 revision 的仓库根目录执行：

```sh
python3 /path/to/scratch/run.py
```

runner 串行调用如下形式的命令；不调用 vendor CLI、不访问网络：

```sh
node --expose-gc \
  --import ./packages/client/src/__tests__/fixtures/ts-source-resolve-hook.mjs \
  /path/to/scratch/measure.mjs claude 128 1 16777216 1
```

参数依次为 runtime、turn 数、每 turn 输出倍率、native/tool 预算 bytes、重复编号。runner 对每个新进程设 55 秒 timeout；进程是 runner 自己创建的子进程，cwd 是当前工作树。它不查找或结束其他进程。已有完整 JSONL 会被跳过；复测使用新的临时目录。

### measure.mjs

```js
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const [runtime, turnsArg = '128', scaleArg = '1', budgetArg = '16777216', repeat = '1'] = process.argv.slice(2);
const turns = Number(turnsArg), scale = Number(scaleArg), budget = Number(budgetArg);
const root = pathToFileURL(resolve('packages/client/vendor/oar/95c6547') + '/');
const load = path => import(new URL(path, root));
const { createSessionKernel } = await load('shared/session-kernel.ts');
const kernel = createSessionKernel('measurement', undefined, budget);
let ingest, boundary;
if (runtime === 'claude') {
  const { initialClaudeProjection, foldClaudeStdout } = await load('runtimes/claude/projection.ts');
  let state = initialClaudeProjection;
  const emit = message => {
    const next = foldClaudeStdout(state, JSON.parse(JSON.stringify(message))); state = next.state;
    for (const command of next.commands) { assert.equal(command.kind, 'frame'); kernel.frame(command.body, command); }
  };
  boundary = (turn, start) => {
    if (start) emit({ type: 'stream_event', event: { type: 'message_start', message: { id: `m-${turn}` } } });
    else {
      emit({ type: 'stream_event', event: { type: 'message_stop' } });
      emit({ type: 'result', subtype: 'success', is_error: false });
    }
  };
  ingest = (text, reasoning) => emit({ type: 'stream_event', event: { type: 'content_block_delta', index: reasoning ? 0 : 1,
    delta: reasoning ? { type: 'thinking_delta', thinking: text } : { type: 'text_delta', text } } });
} else if (runtime === 'codex') {
  const { initialCodexProjection, foldCodexNotification } = await load('runtimes/codex/projection.ts');
  let state = initialCodexProjection('measurement'), turnId;
  const emit = (method, params) => {
    const next = foldCodexNotification(state, method, JSON.parse(JSON.stringify({ threadId: 'measurement', turnId, ...params }))); state = next.state;
    for (const command of next.commands) { assert.equal(command.kind, 'frame'); kernel.frame(command.body, command); }
  };
  boundary = (turn, start) => { turnId = `t-${turn}`; emit(start ? 'turn/started' : 'turn/completed', { turn: { id: turnId, status: 'completed' } }); };
  ingest = (text, reasoning, turn, chunk) => reasoning
    ? emit('rawResponseItem/completed', { item: { type: 'reasoning', id: `r-${turn}-${chunk}`, summary: [{ type: 'summary_text', text }] } })
    : emit('item/agentMessage/delta', { itemId: `m-${turn}`, delta: text });
} else if (runtime === 'dsh') {
  const { initialDshProjection, foldDsh } = await load('runtimes/dsh/projection.ts');
  let state = initialDshProjection('measurement');
  const emit = message => {
    const next = foldDsh(state, JSON.parse(JSON.stringify({ type: 'native', sessionId: 'measurement', ...message }))); state = next.state;
    kernel.frame(next.frame.body, next.frame);
  };
  boundary = (turn, start) => emit({ channel: 'session/event', event: { type: start ? 'turn/start' : 'turn/end', data: start ? {} : { reason: { kind: 'completed' } } } });
  ingest = (text, reasoning, turn) => emit({ channel: 'agent/assistant-stream', frame: { attemptId: `m-${turn}`, chunk: { type: reasoning ? 'reasoning-delta' : 'text-delta', text } } });
} else {
  assert.ok(['grok', 'antigravity', 'opencode'].includes(runtime));
  const { createAcpProjectionState, projectAcpUpdate } = await load('shared/acp/projection.ts');
  const state = createAcpProjectionState();
  boundary = (turn, start) => kernel.frame({ type: 'fixture/turn', native: { turn, start }, events: [start ? { kind: 'turn_active' } : { kind: 'turn_ended', outcome: { kind: 'completed' } }] });
  ingest = (text, reasoning) => {
    const native = JSON.parse(JSON.stringify({ sessionId: 'measurement', update: { sessionUpdate: reasoning ? 'agent_thought_chunk' : 'agent_message_chunk', content: { type: 'text', text } } }));
    kernel.frame({ type: native.update.sessionUpdate, native, events: projectAcpUpdate(state, native.update) });
  };
}
// A reproducible, non-interned ASCII payload. A fresh buffer/string per chunk;
// wire JSON round-trip prevents a single shared repeated string understating heap.
let seed = 2056;
function payload() {
  const bytes = Buffer.allocUnsafe(4096);
  for (let i = 0; i < bytes.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; bytes[i] = 97 + ((seed >>> 0) % 26); }
  return bytes.toString('ascii');
}
function measure(turn) {
  assert.equal(typeof global.gc, 'function');
  global.gc(); global.gc();
  // Sample RSS before scanning/stringifying retained data.
  const memory = process.memoryUsage(), peakRss = process.resourceUsage().maxRSS * 1024;
  let textBytes = 0, reasoningBytes = 0, nativeBytes = 0, elided = 0, ended = 0;
  const records = kernel.records();
  for (let i = 0; i < records.length; i++) {
    const record = records[i]; assert.equal(record.seq, i);
    if (record.kind !== 'frame') continue;
    if (record.body.elided) elided++;
    if (record.body.native !== null) nativeBytes += Buffer.byteLength(JSON.stringify(record.body.native));
    for (const event of record.body.events) {
      if (event.kind === 'text_delta') textBytes += Buffer.byteLength(event.text);
      if (event.kind === 'reasoning' && event.content.kind === 'text') reasoningBytes += Buffer.byteLength(event.content.text);
      if (event.kind === 'turn_ended') ended++;
    }
  }
  assert.equal(textBytes, turn * scale * 256 * 1024);
  assert.equal(reasoningBytes, turn * scale * 128 * 1024);
  assert.equal(ended, turn);
  assert.ok(nativeBytes <= budget || budget === 1);
  console.log(JSON.stringify({ runtime, turns, scale, budget, repeat, turn, textBytes, reasoningBytes, nativeBytes, elided, records: records.length, rss: memory.rss, heapUsed: memory.heapUsed, peakRss }));
}
measure(0);
for (let turn = 1; turn <= turns; turn++) {
  boundary(turn, true);
  for (let chunk = 0; chunk < 32 * scale; chunk++) ingest(payload(), true, turn, chunk);
  for (let chunk = 0; chunk < 64 * scale; chunk++) ingest(payload(), false, turn, chunk);
  boundary(turn, false);
  if ([1, 4, 16, 32, 64, 128].includes(turn) || turn === turns) measure(turn);
}
```

### run.py

```python
import json
import pathlib
import subprocess
import sys

scratch = pathlib.Path(__file__).parent
runtimes = sys.argv[1:] or ['claude', 'codex', 'grok', 'antigravity', 'opencode', 'dsh']
for runtime in runtimes:
    for scenario, turns, scale, budget, repeats in [
        ('many', 128, 1, 16777216, 3),
        ('long', 16, 8, 16777216, 1),
        ('tiny-budget', 128, 1, 1, 1),
    ]:
        for repeat in range(1, repeats + 1):
            output = scratch / f'{runtime}-{scenario}-{repeat}.jsonl'
            if output.exists() and output.stat().st_size:
                rows = [json.loads(line) for line in output.read_text().splitlines()]
                if rows[-1]['turn'] == turns:
                    continue
            command = ['node', '--expose-gc', '--import', './packages/client/src/__tests__/fixtures/ts-source-resolve-hook.mjs',
                       str(scratch / 'measure.mjs'), runtime, str(turns), str(scale), str(budget), str(repeat)]
            with output.open('w') as stream:
                subprocess.run(command, stdout=stream, check=True, timeout=55)
            print(output.name, flush=True)
```

## 原始采样数据

以下 CSV 保存 30 个进程的全部采样结果；数值未转换为 MiB或四舍五入。`scenario` 对应上面的定义，`repeat` 只在同一 runtime/scenario 内编号。`records` 包括无文本的边界帧；`elided` 是已 elide 的帧数。`textBytes`、`reasoningBytes`、`nativeBytes`、`rss`、`heapUsed`、`peakRss` 单位均为 bytes。RSS 是整个测量进程的值，不是 retained log 的独占内存。

```csv
runtime,scenario,repeat,turns,scale,budget,turn,textBytes,reasoningBytes,nativeBytes,elided,records,rss,heapUsed,peakRss
claude,many,1,128,1,16777216,0,0,0,0,0,0,80379904,8521288,80379904
claude,many,1,128,1,16777216,1,262144,131072,404412,0,99,75825152,9124864,84230144
claude,many,1,128,1,16777216,4,1048576,524288,1617648,0,396,72417280,10525376,84230144
claude,many,1,128,1,16777216,16,4194304,2097152,6470599,0,1584,78643200,16059576,84230144
claude,many,1,128,1,16777216,32,8388608,4194304,12941207,0,3168,103825408,23298032,103825408
claude,many,1,128,1,16777216,64,16777216,8388608,16774610,2229,6336,141672448,37484824,141672448
claude,many,1,128,1,16777216,128,33554432,16777216,16774639,8565,12672,203505664,65542560,204242944
claude,many,2,128,1,16777216,0,0,0,0,0,0,85606400,8521328,85655552
claude,many,2,128,1,16777216,1,262144,131072,404412,0,99,85983232,9130536,86573056
claude,many,2,128,1,16777216,4,1048576,524288,1617648,0,396,85213184,10511816,86753280
claude,many,2,128,1,16777216,16,4194304,2097152,6470599,0,1584,85901312,16054160,87736320
claude,many,2,128,1,16777216,32,8388608,4194304,12941207,0,3168,97943552,23328488,97943552
claude,many,2,128,1,16777216,64,16777216,8388608,16774610,2229,6336,130678784,37518944,131825664
claude,many,2,128,1,16777216,128,33554432,16777216,16774639,8565,12672,205062144,65522040,205062144
claude,many,3,128,1,16777216,0,0,0,0,0,0,74858496,8519864,74924032
claude,many,3,128,1,16777216,1,262144,131072,404412,0,99,76087296,9122168,77479936
claude,many,3,128,1,16777216,4,1048576,524288,1617648,0,396,65142784,10511664,77479936
claude,many,3,128,1,16777216,16,4194304,2097152,6470599,0,1584,80576512,16055768,80576512
claude,many,3,128,1,16777216,32,8388608,4194304,12941207,0,3168,103956480,23296856,103956480
claude,many,3,128,1,16777216,64,16777216,8388608,16774610,2229,6336,147161088,37485424,147161088
claude,many,3,128,1,16777216,128,33554432,16777216,16774639,8565,12672,236273664,65541408,236273664
claude,long,1,16,8,16777216,0,0,0,0,0,0,96862208,8519864,97026048
claude,long,1,16,8,16777216,1,2097152,1048576,3233980,0,771,107347968,12350176,107347968
claude,long,1,16,8,16777216,4,8388608,4194304,12935920,0,3084,132694016,23268896,135970816
claude,long,1,16,8,16777216,16,33554432,16777216,16775966,8335,12336,257769472,65149664,258015232
claude,tiny-budget,1,128,1,1,0,0,0,0,0,0,99713024,8519872,99860480
claude,tiny-budget,1,128,1,1,1,262144,131072,54,98,99,102776832,9105224,102776832
claude,tiny-budget,1,128,1,1,4,1048576,524288,54,395,396,102154240,10476720,102793216
claude,tiny-budget,1,128,1,1,16,4194304,2097152,54,1583,1584,113672192,15760256,113672192
claude,tiny-budget,1,128,1,1,32,8388608,4194304,54,3167,3168,122929152,22731264,125124608
claude,tiny-budget,1,128,1,1,64,16777216,8388608,54,6335,6336,131006464,36625296,152502272
claude,tiny-budget,1,128,1,1,128,33554432,16777216,54,12671,12672,219283456,64398416,219365376
codex,many,1,128,1,16777216,0,0,0,0,0,0,76529664,8676824,88948736
codex,many,1,128,1,16777216,1,262144,131072,401786,0,98,72155136,9275904,88948736
codex,many,1,128,1,16777216,4,1048576,524288,1607144,0,392,73236480,10683712,88948736
codex,many,1,128,1,16777216,16,4194304,2097152,6429948,0,1568,86065152,16299912,88948736
codex,many,1,128,1,16777216,32,8388608,4194304,12861660,0,3136,98648064,23583856,103137280
codex,many,1,128,1,16777216,64,16777216,8388608,16773268,2183,6272,134692864,37725960,136232960
codex,many,1,128,1,16777216,128,33554432,16777216,16774725,8456,12544,204046336,65343440,204046336
codex,many,2,128,1,16777216,0,0,0,0,0,0,71057408,8674432,81330176
codex,many,2,128,1,16777216,1,262144,131072,401786,0,98,71827456,9280848,81330176
codex,many,2,128,1,16777216,4,1048576,524288,1607144,0,392,77119488,10681320,81330176
codex,many,2,128,1,16777216,16,4194304,2097152,6429948,0,1568,92618752,16297616,92618752
codex,many,2,128,1,16777216,32,8388608,4194304,12861660,0,3136,94552064,23580632,110641152
codex,many,2,128,1,16777216,64,16777216,8388608,16773268,2183,6272,141705216,37719920,141721600
codex,many,2,128,1,16777216,128,33554432,16777216,16774725,8456,12544,178356224,65364776,184975360
codex,many,3,128,1,16777216,0,0,0,0,0,0,69091328,8674472,81461248
codex,many,3,128,1,16777216,1,262144,131072,401786,0,98,68894720,9280888,81461248
codex,many,3,128,1,16777216,4,1048576,524288,1607144,0,392,74317824,10681360,81461248
codex,many,3,128,1,16777216,16,4194304,2097152,6429948,0,1568,87064576,16283016,88948736
codex,many,3,128,1,16777216,32,8388608,4194304,12861660,0,3136,104333312,23640968,104562688
codex,many,3,128,1,16777216,64,16777216,8388608,16773268,2183,6272,138444800,37778888,139362304
codex,many,3,128,1,16777216,128,33554432,16777216,16774725,8456,12544,180731904,65336696,198688768
codex,long,1,16,8,16777216,0,0,0,0,0,0,94158848,8674600,94339072
codex,long,1,16,8,16777216,1,2097152,1048576,3213366,0,770,102924288,12546624,102924288
codex,long,1,16,8,16777216,4,8388608,4194304,12853464,0,3080,136200192,23603848,136200192
codex,long,1,16,8,16777216,16,33554432,16777216,16774334,8301,12320,264339456,65184400,264568832
codex,tiny-budget,1,128,1,1,0,0,0,0,0,0,93880320,8673688,96043008
codex,tiny-budget,1,128,1,1,1,262144,131072,82,97,98,95780864,9257936,96043008
codex,tiny-budget,1,128,1,1,4,1048576,524288,82,391,392,99549184,10604360,99598336
codex,tiny-budget,1,128,1,1,16,4194304,2097152,84,1567,1568,108838912,15880664,108838912
codex,tiny-budget,1,128,1,1,32,8388608,4194304,84,3135,3136,129597440,22717184,130498560
codex,tiny-budget,1,128,1,1,64,16777216,8388608,84,6271,6272,166150144,36515240,166150144
codex,tiny-budget,1,128,1,1,128,33554432,16777216,86,12543,12544,217219072,64138200,217317376
grok,many,1,128,1,16777216,0,0,0,0,0,0,92389376,8431168,93093888
grok,many,1,128,1,16777216,1,262144,131072,404015,0,98,95911936,8982416,96059392
grok,many,1,128,1,16777216,4,1048576,524288,1616060,0,392,100040704,10400632,100040704
grok,many,1,128,1,16777216,16,4194304,2097152,6464254,0,1568,102662144,15981544,111689728
grok,many,1,128,1,16777216,32,8388608,4194304,12928526,0,3136,115752960,23363760,116129792
grok,many,1,128,1,16777216,64,16777216,8388608,16775122,2203,6272,137216000,37593504,137216000
grok,many,1,128,1,16777216,128,33554432,16777216,16775180,8475,12544,227999744,65358280,227999744
grok,many,2,128,1,16777216,0,0,0,0,0,0,87162880,8429904,87326720
grok,many,2,128,1,16777216,1,262144,131072,404015,0,98,90800128,8982488,90947584
grok,many,2,128,1,16777216,4,1048576,524288,1616060,0,392,94994432,10400584,95141888
grok,many,2,128,1,16777216,16,4194304,2097152,6464254,0,1568,107970560,15980248,109232128
grok,many,2,128,1,16777216,32,8388608,4194304,12928526,0,3136,128352256,23356320,128647168
grok,many,2,128,1,16777216,64,16777216,8388608,16775122,2203,6272,152567808,37588672,152567808
grok,many,2,128,1,16777216,128,33554432,16777216,16775180,8475,12544,207831040,65360744,208568320
grok,many,3,128,1,16777216,0,0,0,0,0,0,91668480,8428928,91832320
grok,many,3,128,1,16777216,1,262144,131072,404015,0,98,91717632,8989784,95404032
grok,many,3,128,1,16777216,4,1048576,524288,1616060,0,392,89079808,10399760,95404032
grok,many,3,128,1,16777216,16,4194304,2097152,6464254,0,1568,99713024,15982616,99713024
grok,many,3,128,1,16777216,32,8388608,4194304,12928526,0,3136,123650048,23358440,123650048
grok,many,3,128,1,16777216,64,16777216,8388608,16775122,2203,6272,142065664,37589176,151961600
grok,many,3,128,1,16777216,128,33554432,16777216,16775180,8475,12544,216907776,65357088,221642752
grok,long,1,16,8,16777216,0,0,0,0,0,0,77316096,8430216,83378176
grok,long,1,16,8,16777216,1,2097152,1048576,3231791,0,770,86360064,12244184,89128960
grok,long,1,16,8,16777216,4,8388608,4194304,12927164,0,3080,111362048,23343144,111362048
grok,long,1,16,8,16777216,16,33554432,16777216,16773358,8323,12320,199835648,65286640,205029376
grok,tiny-budget,1,128,1,1,0,0,0,0,0,0,83984384,8421904,85344256
grok,tiny-budget,1,128,1,1,1,262144,131072,24,97,98,82722816,8968016,85917696
grok,tiny-budget,1,128,1,1,4,1048576,524288,24,391,392,86671360,10317376,86736896
grok,tiny-budget,1,128,1,1,16,4194304,2097152,25,1567,1568,92635136,15570144,95436800
grok,tiny-budget,1,128,1,1,32,8388608,4194304,25,3135,3136,99074048,22519768,101105664
grok,tiny-budget,1,128,1,1,64,16777216,8388608,25,6271,6272,140279808,36389392,140279808
grok,tiny-budget,1,128,1,1,128,33554432,16777216,26,12543,12544,233226240,64168296,233226240
antigravity,many,1,128,1,16777216,0,0,0,0,0,0,93601792,8429808,93847552
antigravity,many,1,128,1,16777216,1,262144,131072,404015,0,98,97681408,8981136,97697792
antigravity,many,1,128,1,16777216,4,1048576,524288,1616060,0,392,101859328,10399352,101859328
antigravity,many,1,128,1,16777216,16,4194304,2097152,6464254,0,1568,117309440,15982232,117309440
antigravity,many,1,128,1,16777216,32,8388608,4194304,12928526,0,3136,142016512,23360768,142016512
antigravity,many,1,128,1,16777216,64,16777216,8388608,16775122,2203,6272,177537024,37590952,177537024
antigravity,many,1,128,1,16777216,128,33554432,16777216,16775180,8475,12544,259227648,65356560,259538944
antigravity,many,2,128,1,16777216,0,0,0,0,0,0,92880896,8429912,92880896
antigravity,many,2,128,1,16777216,1,262144,131072,404015,0,98,96206848,8989232,96370688
antigravity,many,2,128,1,16777216,4,1048576,524288,1616060,0,392,100630528,10399456,100630528
antigravity,many,2,128,1,16777216,16,4194304,2097152,6464254,0,1568,116817920,15982336,116817920
antigravity,many,2,128,1,16777216,32,8388608,4194304,12928526,0,3136,135053312,23360872,135053312
antigravity,many,2,128,1,16777216,64,16777216,8388608,16775122,2203,6272,168869888,37591488,168869888
antigravity,many,2,128,1,16777216,128,33554432,16777216,16775180,8475,12544,255295488,65357048,255574016
antigravity,many,3,128,1,16777216,0,0,0,0,0,0,90144768,8428856,90210304
antigravity,many,3,128,1,16777216,1,262144,131072,404015,0,98,93929472,8989456,93929472
antigravity,many,3,128,1,16777216,4,1048576,524288,1616060,0,392,98091008,10399408,98238464
antigravity,many,3,128,1,16777216,16,4194304,2097152,6464254,0,1568,111607808,15982264,111607808
antigravity,many,3,128,1,16777216,32,8388608,4194304,12928526,0,3136,129417216,23358896,129417216
antigravity,many,3,128,1,16777216,64,16777216,8388608,16775122,2203,6272,158466048,37589480,159481856
antigravity,many,3,128,1,16777216,128,33554432,16777216,16775180,8475,12544,221396992,65362560,221429760
antigravity,long,1,16,8,16777216,0,0,0,0,0,0,84606976,8429968,84623360
antigravity,long,1,16,8,16777216,1,2097152,1048576,3231791,0,770,78741504,12267280,93192192
antigravity,long,1,16,8,16777216,4,8388608,4194304,12927164,0,3080,99532800,23342480,99532800
antigravity,long,1,16,8,16777216,16,33554432,16777216,16773358,8323,12320,236765184,65288248,236781568
antigravity,tiny-budget,1,128,1,1,0,0,0,0,0,0,94666752,8429912,94830592
antigravity,tiny-budget,1,128,1,1,1,262144,131072,24,97,98,98271232,8966536,98418688
antigravity,tiny-budget,1,128,1,1,4,1048576,524288,24,391,392,102465536,10323488,102465536
antigravity,tiny-budget,1,128,1,1,16,4194304,2097152,25,1567,1568,118013952,15572000,118013952
antigravity,tiny-budget,1,128,1,1,32,8388608,4194304,25,3135,3136,137953280,22527384,137953280
antigravity,tiny-budget,1,128,1,1,64,16777216,8388608,25,6271,6272,177078272,36393072,177078272
antigravity,tiny-budget,1,128,1,1,128,33554432,16777216,26,12543,12544,266108928,64175320,266108928
opencode,many,1,128,1,16777216,0,0,0,0,0,0,92422144,8430032,92585984
opencode,many,1,128,1,16777216,1,262144,131072,404015,0,98,96616448,8989528,96616448
opencode,many,1,128,1,16777216,4,1048576,524288,1616060,0,392,100679680,10399504,100679680
opencode,many,1,128,1,16777216,16,4194304,2097152,6464254,0,1568,116408320,15982360,116408320
opencode,many,1,128,1,16777216,32,8388608,4194304,12928526,0,3136,140984320,23360896,140984320
opencode,many,1,128,1,16777216,64,16777216,8388608,16775122,2203,6272,179781632,37591080,179781632
opencode,many,1,128,1,16777216,128,33554432,16777216,16775180,8475,12544,246562816,65356688,246857728
opencode,many,2,128,1,16777216,0,0,0,0,0,0,94175232,8429832,94339072
opencode,many,2,128,1,16777216,1,262144,131072,404015,0,98,98336768,8989152,98418688
opencode,many,2,128,1,16777216,4,1048576,524288,1616060,0,392,102465536,10399376,102465536
opencode,many,2,128,1,16777216,16,4194304,2097152,6464254,0,1568,118276096,15982256,118276096
opencode,many,2,128,1,16777216,32,8388608,4194304,12928526,0,3136,142409728,23357592,142409728
opencode,many,2,128,1,16777216,64,16777216,8388608,16775122,2203,6272,178061312,37590976,178405376
opencode,many,2,128,1,16777216,128,33554432,16777216,16775180,8475,12544,246874112,65356584,247250944
opencode,many,3,128,1,16777216,0,0,0,0,0,0,94240768,8430024,94388224
opencode,many,3,128,1,16777216,1,262144,131072,404015,0,98,96911360,8981328,96993280
opencode,many,3,128,1,16777216,4,1048576,524288,1616060,0,392,100909056,10399544,100909056
opencode,many,3,128,1,16777216,16,4194304,2097152,6464254,0,1568,116555776,15982328,116555776
opencode,many,3,128,1,16777216,32,8388608,4194304,12928526,0,3136,141344768,23360864,141344768
opencode,many,3,128,1,16777216,64,16777216,8388608,16775122,2203,6272,180305920,37591192,180322304
opencode,many,3,128,1,16777216,128,33554432,16777216,16775180,8475,12544,246169600,65356656,246349824
opencode,long,1,16,8,16777216,0,0,0,0,0,0,95453184,8430120,95682560
opencode,long,1,16,8,16777216,1,2097152,1048576,3231791,0,770,105545728,12273048,105545728
opencode,long,1,16,8,16777216,4,8388608,4194304,12927164,0,3080,138461184,23334168,138461184
opencode,long,1,16,8,16777216,16,33554432,16777216,16773358,8323,12320,242499584,65288480,242499584
opencode,tiny-budget,1,128,1,1,0,0,0,0,0,0,93257728,8428768,93421568
opencode,tiny-budget,1,128,1,1,1,262144,131072,24,97,98,97337344,8966240,97353728
opencode,tiny-budget,1,128,1,1,4,1048576,524288,24,391,392,101154816,10323192,101154816
opencode,tiny-budget,1,128,1,1,16,4194304,2097152,25,1567,1568,117063680,15571704,117063680
opencode,tiny-budget,1,128,1,1,32,8388608,4194304,25,3135,3136,116146176,22523888,118489088
opencode,tiny-budget,1,128,1,1,64,16777216,8388608,25,6271,6272,161415168,36411040,161415168
opencode,tiny-budget,1,128,1,1,128,33554432,16777216,26,12543,12544,258113536,64193432,258113536
dsh,many,1,128,1,16777216,0,0,0,0,0,0,95600640,8392256,95731712
dsh,many,1,128,1,16777216,1,262144,131072,399129,0,98,71581696,8933632,97206272
dsh,many,1,128,1,16777216,4,1048576,524288,1596516,0,392,75251712,10304752,97206272
dsh,many,1,128,1,16777216,16,4194304,2097152,6386736,0,1568,92028928,15715224,97206272
dsh,many,1,128,1,16777216,32,8388608,4194304,12774336,0,3136,118489088,22843144,118538240
dsh,many,1,128,1,16777216,64,16777216,8388608,16775820,2153,6272,155025408,36949368,155025408
dsh,many,1,128,1,16777216,128,33554432,16777216,16774448,8426,12544,235995136,65018248,235995136
dsh,many,2,128,1,16777216,0,0,0,0,0,0,93880320,8392104,94044160
dsh,many,2,128,1,16777216,1,262144,131072,399129,0,98,98172928,8941448,98271232
dsh,many,2,128,1,16777216,4,1048576,524288,1596516,0,392,102154240,10304624,102301696
dsh,many,2,128,1,16777216,16,4194304,2097152,6386736,0,1568,117866496,15715192,117866496
dsh,many,2,128,1,16777216,32,8388608,4194304,12774336,0,3136,142573568,22842472,142573568
dsh,many,2,128,1,16777216,64,16777216,8388608,16775820,2153,6272,160301056,36949192,167788544
dsh,many,2,128,1,16777216,128,33554432,16777216,16774448,8426,12544,245612544,65018216,245678080
dsh,many,3,128,1,16777216,0,0,0,0,0,0,93618176,8392400,93618176
dsh,many,3,128,1,16777216,1,262144,131072,399129,0,98,96878592,8933776,96878592
dsh,many,3,128,1,16777216,4,1048576,524288,1596516,0,392,101072896,10304896,101072896
dsh,many,3,128,1,16777216,16,4194304,2097152,6386736,0,1568,116441088,15715368,116441088
dsh,many,3,128,1,16777216,32,8388608,4194304,12774336,0,3136,135004160,22845848,135004160
dsh,many,3,128,1,16777216,64,16777216,8388608,16775820,2153,6272,175177728,36949512,175177728
dsh,many,3,128,1,16777216,128,33554432,16777216,16774448,8426,12544,263520256,65018392,263634944
dsh,long,1,16,8,16777216,0,0,0,0,0,0,93290496,8392256,93437952
dsh,long,1,16,8,16777216,1,2097152,1048576,3192409,0,770,104628224,12101608,104628224
dsh,long,1,16,8,16777216,4,8388608,4194304,12769636,0,3080,140083200,22801136,140083200
dsh,long,1,16,8,16777216,16,33554432,16777216,16776363,8274,12320,247922688,64685456,247922688
dsh,tiny-budget,1,128,1,1,0,0,0,0,0,0,92422144,8392080,92422144
dsh,tiny-budget,1,128,1,1,1,262144,131072,58,97,98,96649216,8926424,96747520
dsh,tiny-budget,1,128,1,1,4,1048576,524288,58,391,392,101040128,10292528,101040128
dsh,tiny-budget,1,128,1,1,16,4194304,2097152,58,1567,1568,116768768,15561000,116785152
dsh,tiny-budget,1,128,1,1,32,8388608,4194304,58,3135,3136,137166848,22524168,137166848
dsh,tiny-budget,1,128,1,1,64,16777216,8388608,58,6271,6272,177635328,36418416,177635328
dsh,tiny-budget,1,128,1,1,128,33554432,16777216,58,12543,12544,243466240,64259568,243466240
```
