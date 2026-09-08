# G1c receipt contract research

## Scope

固定 a06fbe6 的源码追踪、内部 store characterization 与恢复契约。研究见
docs/researches/2026-09-09-g1c-receipts/README.md。不修改生产实现、journal、公开 API 或版本。

## Task Breakdown

- [x] 追踪 façade/cloud/SQLite receipt authority 与公开入口
- [x] 实跑内部 store close/reopen probe，明确证据边界
- [x] 定义请求绑定、receipt lifetime、read/cancel/consumer 契约及反例
- [x] 保存 SDK 与产品 handoff
- [ ] 后续工作包：receipt durability/lifetime fence 与端到端反例（本研究不实施）

## Verification

`bun docs/researches/2026-09-09-g1c-receipts/store-probe.ts` 通过，JSON 同目录。
只验证内部 store 生命周期，不是产品 API 使用示例或端到端恢复验收。
