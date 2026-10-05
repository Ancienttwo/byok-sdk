# Clarification §9.6：新 preparation 的离线首请求 capture

基线 main `708ed45b`；仅新增两个 client 测试资产与任务/研究文档，生产源/API/wire/Pi/package/lock不改。

## 结论

**离线 native bytes 子命题成立，生产 admission 尚未证明。** 用户答案进入新的 source/message 后，真实 preparation service 持久化不同 receipt/reference、request/envelope digest 与 D。真实 Pi adapter/shipped prepared host/official native session 分别启动两个明确 taskId 的 prepared 操作；loopback HTTP 捕获首请求，第二个 body 逐字节等于第二个冻结 D、且不等于第一个 D。

这不是“non-ready receipt 可以通过 SDK 生产准入”的声明：counter 始终 `test_fixture`，两份 receipt 都 `ready=false`。为隔离 native 首请求边界，fixture **直接调用 adapter prepared operation**，没有 cloud offer、claim、pin、Agent enrollment、生产 accounting ruling 或 Host clarification HTTP lifecycle。本刀不伪造 provider authority、不改 store ready、不把这些环节合并成完整 SaaS 验收。

## P1/P2/P3 与证据

P1：真实 service/compiler/store 与 native prepared launcher；测试 authorityResolver 仅用于 fixture 的 offline scope 输入，不提供生产认证保证，MCP server 使用已有测试 fixture；HTTP endpoint 只绑定 `127.0.0.1`。不读真实 ~/.pi、不发送真实 provider 请求。

P2：新 source revision/digest + answer snapshot → service.prepare → durable artifact/receipt → direct Pi prepared launch → loopback SSE endpoint 记录 request bytes。

| 事实 | 文件:行号 |
|---|---|
| 两次 requestId/source/message；receipt ready=false/counter=test_fixture | `packages/client/src/__tests__/clarification-prepared-capture.test.ts:11-24` |
| 新 receipt/source/requestDigest/envelopeDigest/D 不同，旧 receipt仅历史lookup | 同文件 `:25-34` |
| 每次 native首请求等于自身D，第二次不是旧D | 同文件 `:35-46` |
| 把旧 artifact 混进新 reference/期待，被 record归属拒绝，零 transport | 同文件 `:49-58` |
| 真正的service.prepare与持久化artifact路径，不手造receipt/ready | `packages/client/src/__tests__/fixtures/clarification-prepared-capture.ts:214-251` |
| 真正的Pi adapter resolveRuntimeLaunch/start；无cloud准入 | 同文件 `:289-339` |

P3：保留原生产不变量，把byte correctness与production readiness拆开检验。现有 SDK无需为了这项离线 capture 改生产行为；fixture明确不提供计费/admission/真实provider计数证明。

record归属的生产校验入口：`packages/client/src/adapters/pi/pi-adapter.ts:731-735`；本刀只读、不修改。

## 验证条件与未证项

- packages/client 的既有 vitest config 设置 `BYOK_TEST_DEVICE_CREDENTIAL_STORE=1`；本测试直接用真实 Pi adapter（支持 mcpToolsets），没有新 stub daemon，更不借 stub 的零副作用证明 native transport。
- endpoint的SSE usage是离线响应 fixture，service counter是test_fixture。这两个“数字”都不是生产 provider counting evidence。Executor implementation无production attestation/accounting配置的局限继续存在。
- 不复用旧 receipt/D 是本 fixture 的新 request/source association与混合负控的证明，不是任何未知Host代码都会正确关联的保证。旧receipt完整自洽地重放、生产 pin/claim、tenant/stale answer、long-poll、native provider多轮tools、same Agent home全链仍分别依赖已有契约/另行验收。
- 两个native操作使用独立测试home/workspace；生产同Agent home顺序、权限策略和prep记录retention/restart不是本刀覆盖。没有自动compaction/steer。
- 非root Linux使用干净source snapshot、frozen install/build/typecheck/focused测试；详细命令与退出码在任务notes，未执行不写PASS。

Falsifier：第二次body!=第二个D，或两份source/receipt/D没有变；混合reference能发出请求；counter=test_fixture却ready=true，任一发生即失败，不修改生产来变绿。

停止条件：需要改生产源/API/wire/Pi、扩大packages路径、真实provider、architecture gate或daemon版本不匹配时停报。完全生产准入仍未证，不能以本测试替代这一项。
