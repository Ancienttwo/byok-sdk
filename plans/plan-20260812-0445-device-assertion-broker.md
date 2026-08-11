# Plan: Daemon Local Device-Assertion Broker

> **Status**: Executing
> **Created**: 20260812-0445
> **Slug**: device-assertion-broker
> **Artifact Level**: work-package
> **Promotion Reason**: Sprint Row 5（salesko handoff 条目 10）：host 会把自家 CLI 与 daemon 同装，理想模型是「配对一次两者都授权、撤销一次两者同死」。需要 daemon 经既有 authenticated control socket 用自己的 device 私钥签发短期 assertion。安全敏感面，deep-reasoner 设计轮已完成（HIGH confidence），orchestrator 已批注定案；双轨验收。
> **Verification Boundary**: core + client 测试（12 类断言）、凭证隔离审计脚本、golden 冻结、对本分支基点（codex/result-document-channel）之外面零 diff、strict workflow；验收双轨：gatekeeper + codex exec（两败即 SKIPPED）。
> **Rollback Surface**: revert 本 slice commits；功能默认关闭（audiences 空 = off），零迁移。
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-08-12-salesko-integration-handoff.md` 条目 10；`docs/researches/2026-08-12-salesko-consumption-evidence.md` §5；设计轮结论（本 plan P1/P3 即其批注版）
> **Task Contract**: `tasks/contracts/20260812-0445-device-assertion-broker.contract.md`
> **Task Review**: `tasks/reviews/20260812-0445-device-assertion-broker.review.md`
> **Implementation Notes**: `tasks/notes/20260812-0445-device-assertion-broker.notes.md`

## Agentic Routing
- Selected route: 本 worktree（栈于 codex/result-document-channel @ fcbf2aa）内 deep-worker 执行，gatekeeper + codex 双轨验收。
- Routing reason: 新的本地认证面，历史上安全面单门被对抗二审多次推翻。
- Due diligence:
  - P1 map（设计轮实证，file:line 见其报告）: control socket NDJSON 单行帧 + 64 KiB 上限 + 双向 HMAC 握手（control-protocol.ts）；方法注册表在 create-daemon.ts 静态对象；域分隔先例两条（`byok-nonce-v1\n` device-keys / `byok-device-proof-v1\n` attestation.ts:40）；签名信封机制已冻结存在（canonicalizeJson、deviceProofSigningInput、golden 冻结，attestation.ts）；「每次签名重读 store」先例（StoredDeviceProofSigner.sign）；审计面 0600 + redact/reconstruct 成对（audit-log.ts）；unpair 活路径先 shutdown 后清 device.json；**缺口**：client index 未导出任何 control client 入口。
  - P2 trace（目标链路）: sibling CLI → `requestDeviceAssertion({productId, storeDir?, audience})`（client 唯一新公开导出）→ control socket `assertion.issue {audience}` → daemon 六道闸（disabled→params→audience→shutting_down→revoked→store.load）→ 每次现读私钥签 `byok-device-assertion-v1\n` + canonical claims → `{assertion, expiresAt}` → host 云端 exchange 时用 core 的 `verifyDeviceAssertion`（类型强制传入 device 行/撤销状态）复查后换产品 session。
  - P3 decision rationale（orchestrator 批注定案）: ① 自定义 JSON 签名信封而非 JWS——域前缀必须进被签字节，JWS 的 typ 标签默认不被校验是 fail-open 形状；克隆 attestation 机制（RFC 8785 子集 canonicalize + golden 冻结）。② claims：version/issuer(serverUrl origin)/productId/deviceId/audience(单值)/jti(128bit CSPRNG)/issuedAt/expiresAt，全必填 strictObject；**不带** devicePublicKey（校验方必须按 deviceId 查自己的设备目录）、**不带**调用方身份（同 UID 下不可认证=合成权威）、**不带** keyId（无轮换故事，假结构）。③ audience 精确白名单（禁前缀匹配——`salesko-api.evil.com` 是经典洞），默认空=功能关；TTL 默认 120s 硬上限 300s（=消费方 ≤5min 契约），不接受调用方指定。④ revoke 语义诚实二分：daemon 半边=每次签发 `store.load()` 现读 + `isRevoked()` + 新增 `shutting_down` 闸（封掉 shutdown ack 到 socket 关闭的 ~10s 铸币窗口）；服务端 revoke 的完整同步失效由 host exchange 复查兑现（verifyDeviceAssertion 的签名强制要求传入撤销状态，「忘记复查」类型层编译不过），文档不得宣称 daemon 独自满足。⑤ daemon 不做 jti 簿记（校验方烧毁 jti；daemon 义务=CSPRNG+短 exp+不复用）。⑥ 审计单一 kind `device-assertion`，签名/信封字节不进事件（结构性优于脱敏）；denied 路径 audience 转 byte size（自由文本惯例）。⑦ 公开面只有 `requestDeviceAssertion` 一个函数——绝不导出 connectControlClient/ControlClient（constraint test 钉死）。⑧ [unverified 假设，报晨会]：salesko apps/api 为 TS/Node 可依赖 @byok-sdk/core 做校验；若非，JWS 方案需重议。

## Approach
1. core：`src/device-assertion.ts`（常量/claims schema/签名输入/parse/verify）+ golden `device-assertion-v1.canonical.json` + 域分隔三常量互不为前缀测试。verify 签名：`verifyDeviceAssertion(envelope, {publicKeyJwkX, revoked, now?})` —— revoked 为必传参。
2. client：control-protocol 增 `assertion.issue` 严格 params/result + 六个 ControlError code；create-daemon 注册 handler（六道闸顺序固定）+ `DaemonConfig.deviceAssertion` 构造期校验 + `shuttingDown` 旗标（performControlShutdown 同步置位）；observer/audit 增 `device-assertion` kind（redact+reconstruct 成对）；新 `daemon/assertion-client.ts` + index 唯一导出 `requestDeviceAssertion`。
3. 测试 12 类（设计轮清单全收）：四契约类（audience 拒绝含前缀攻击/TTL 构造期越界+verify 过期/revoked 三分支+e2e unpair/审计不含本文含 substring 断言）+ golden 冻结 + 域分隔 + jti 唯一性 + 配置五负向 + params 严格性五负向 + 密钥卫生（结果 JSON 无 BEGIN、模块无级私钥缓存）+ 凭证隔离审计脚本纳入验收 + 并发双发。
4. 文档：docs/security.md 或 architecture 增 broker 节——两半 revoke 语义、威胁模型表、下游义务（exchange 复查+jti 烧毁+TLS+audience 相等断言）。

## Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| JWS compact | 跨语言生态 | 域前缀进不了被签字节,typ 默认不校验=fail-open | 拒绝 |
| 复用 DeviceProofEnvelope | 省一套 schema | claims 语义错配,跨域混淆风险 | 拒绝 |
| daemon jti 簿记+限流 | 表面更稳 | daemon 不在验证路径,拦不住真实重放;同 UID 攻击者本可离线伪造 | 拒绝 |
| 导出整个 control client | 省事 | shutdown/approvals 一并变公开 API,契约面失控 | 拒绝,单函数 |

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| shutdown 铸币窗口漏堵 | Medium | High | shutting_down 闸 must-have + 专项测试 |
| 「同步失效」被过度宣称 | Medium | High | verify 签名强制 revoked 参数 + 文档两半义务 |
| 公开面失控 | Low | High | constraint test 断言 index 不导出 control client |
| 域混淆 | Low | High | 三前缀两两非前缀测试 + 跨域验签失败测试 |

## Promotion Gate
- **Merge/PR unit**: 一个 PR（栈于 result-document PR 之上,合并顺序 Row3→Row5）。
- **Rollback surface**: revert;默认关闭零迁移。
- **Verification boundary**: 见 header;零 diff 基准是本分支基点 codex/result-document-channel。
- **Review/acceptance boundary**: 双轨 gatekeeper + codex;宣称面等 salesko Phase C 消费。
- **High-risk surface**: 六道闸顺序、shutting_down 旗标、审计结构性隔离、golden 正当性。
- **Why not checklist row**: 新本地认证面,独立威胁模型与回滚面。

## Evidence Contract
- **State/progress path**: 本 plan + contract + notes。
- **Verification evidence**: core/client 测试输出、审计脚本输出、双轨结论。
- **Evaluator rubric**: 六道闸每道有独立拒发测试且顺序被钉;audience 前缀攻击用例全拒;TTL>300s 构造期抛;revoked 三分支各自拒发;audit.jsonl 实读断言无签名/信封 substring 且含元数据;三域前缀两两非前缀;跨域签名互不通过;requestDeviceAssertion 是 index 唯一新增导出;凭证隔离审计零命中;对基点 packages/protocol packages/server packages/cloud packages/cloud-postgres deploy scripts 零 diff。
- **Stop condition**: 任何私钥缓存/导出、通用 credentials.get、audience 前缀匹配、或 daemon 单方宣称同步失效。
- **Rollback surface**: revert commits。

## Annotations

- 已解决:依据 owner 2026-08-12 /goal 指令授权推进;设计轮结论经 orchestrator 批注采纳(见 P3);apps/api TS 运行时为 [unverified] 假设,晨报向 salesko 确认。无遗留注释。

## Task Breakdown
- [x] core device-assertion 信封 + verify(强制 revoked 参数) + golden + 域分隔测试
- [x] client control 方法 + 六道闸 + shutting_down 旗标 + 配置校验
- [x] 审计 kind(redact/reconstruct 成对) + 密钥卫生
- [x] requestDeviceAssertion 唯一公开导出 + constraint test
- [x] 12 类测试 + 凭证隔离审计(darwin 上 linux-credential-audit 报 UNSUPPORTED,可移植的 credential-audit-core 已随 client 套件通过)
- [x] 文档:两半 revoke 语义 + 威胁模型 + 下游义务
- [ ] 双轨验收
