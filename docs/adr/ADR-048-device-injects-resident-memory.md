---
schemaVersion: archcontext.adr/v1
title: 设备在 fresh task 开头注入有上限的 MEMORY.md，不加第二个常驻文件，Host 不再拼记忆
status: accepted
decidedAt: 2026-11-04
appliesTo:
  - sdk-root
---

# ADR-048：设备在 fresh task 开头注入 `MEMORY.md`

> **来源**：issue [#1439](https://github.com/Ancienttwo/byok-sdk/issues/1439)。owner 决定见 [6639942055](https://github.com/Ancienttwo/byok-sdk/issues/1439#issuecomment-6639942055)（不加单独文件，由设备注入）和 [6637367812](https://github.com/Ancienttwo/byok-sdk/issues/1439#issuecomment-6637367812)（写超上限时只恢复这个文件）。设计裁定见 [6640052385](https://github.com/Ancienttwo/byok-sdk/issues/1439#issuecomment-6640052385)，[6642973099](https://github.com/Ancienttwo/byok-sdk/issues/1439#issuecomment-6642973099) 修订了注入条件和 guidance 布局说明。

状态：已决定（owner 2026-11-04）。

## 1. 背景

模型要先调用工具读 `MEMORY.md`，才看得到记忆，这一步可能被跳过。Host execution-core 另外把投影过的文本拼进 instruction，这样模型会看到两份不同来源的记忆，sealed 和 blob instruction 还因此被拒绝。

## 2. 决定

1. 不加 `ESSENTIAL.md`。`MEMORY.md` 是唯一的常驻文件，上限 8 KiB，只放长期偏好、关键事实和指向 `notes/` 的顶层指针。notes 的索引放在 `notes/index.md`。
2. 设备在 fresh task 开头读一次 `MEMORY.md`，原样作为一行 JSON 数据放在 guidance 和 instruction 之间。带数据块的是 `kind: 'instruction'`、没有 `sessionRef`、有效记忆模式为 `read` 或 `read-write`、daemon 接纳 memory MCP 的 task，writer 和 reader 都带。resumed session 和 prepared offer 不带。daemon 不接纳 memory MCP 时 SDK 写不了记忆，fresh task 和 resumed session 一样用先读 `MEMORY.md` 的 guidance，不带数据块，也不因超限失败。
3. 文件超限或读不了时，task 在 runtime 启动前失败，不重试，不截断，也不退回让模型自己读。
4. writer Attempt 把 `MEMORY.md` 写超上限时，结束时只把这个文件恢复成开始时的内容，`notes/` 不动。terminal 报告写超后的字节数。这是 SDK 自己写记忆的唯一情况。
5. Host execution-core 不再往 instruction 里拼记忆，`contextPack` 只是 Host 的读取接口。挡住队列的只有 restore 挂起和 placement 或 profile 失效；超限或未授权的投影不再挡队列。

## 3. 影响

- 本 ADR 本身不改 wire、不加 flag。[#1843](https://github.com/Ancienttwo/byok-sdk/issues/1843) 之后，§2 第 3 条的失败里，`MEMORY.md` 超限、有多个硬链接、不是普通文件或不是合法 UTF-8 时，task 在不 seal 输出的情况下带 `task.fail.failure.class`（`agent_memory_resident_over_limit`、`agent_memory_resident_multiple_links`、`agent_memory_resident_not_regular_file`、`agent_memory_resident_not_utf8`，开放 class 的新值，不加 flag）。文件缺失、home identity 变化和 I/O 错误仍是 `unknown`；seal 输出的 task 一律发 `unknown`；原因文本不变。`AGENT_MEMORY_START_REFUSALS` 里的三个 snapshot 码属于 commit-on-success 的开始副本，不属于本条。
- 这对用 core 的 Host 是 breaking 改动，见 upgrade manifest。Host 和设备一起升级；旧 Host core 配新设备时，模型会看到两份 `MEMORY.md`，最多多出 8 KiB，不会出错。
- `MEMORY.md` 超限后，接纳 memory MCP 的设备上，下一个 fresh task 不会启动，直到恢复成功或 Host 用 intent 修复。
- 恢复按原始字节比较，不受文件大小限制（[#1440](https://github.com/Ancienttwo/byok-sdk/issues/1440)）。开始副本在内存里：daemon 在恢复前崩溃时副本丢失，下一个 fresh task 会失败。这是已知限制，修复办法见 `docs/protocol.md` §2.2。

## 4. 不做

- 放进 system prompt，或者改 tool 列表。
- 截断、自动压缩，替模型读或摘要 `notes/`。
- resumed 或 prepared task 的注入。

## 5. 取代

本 ADR 部分取代 [ADR-039](ADR-039-bot-mode-product-prd.md) 的以下条款，这里是取代关系的唯一记录：

- §2.2 场景表 S2 行的 `agent.memory.projection` 进 ContextPack。
- §3「一条入口」里常驻档案由 Host 放进 ContextPack。
- §3「两层记忆」里常驻档案的投影每次执行都进 ContextPack，以及常驻层只能从 ContextPack 进。
- §5.3.1 记忆表“常驻档案”一行的读取方式。
- §5.3.1 里 `MEMORY.md` 超过 8 KiB 时由 Host 阻塞。
- §5.3.2 末段 P5a 交付里的“投影进 ContextPack”。
- §9 验收表“记忆页”一行的“8 KiB 上限阻塞”。
- §10 P5a 的标题和目标里“两层 ContextPack”“常驻档案每次进 ContextPack”，以及范围里的“投影进 ContextPack”“8 KiB 上限阻塞”。
- §12 Q10 的“超出显式阻塞”和“每次执行都进 ContextPack”。上限 8 KiB 不变。
