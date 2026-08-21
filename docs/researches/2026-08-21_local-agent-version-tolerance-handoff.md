# Handoff: Local Agent 版本容忍与 release 可观测性

- Date: 2026-08-21
- 来源：`RAFT-study` 对“本机版本落后 Latest 仍可运行”的 artifact-bound 研究，以及本仓当前 Local Agent / protocol / release 实现复核
- 目标仓库：`/Users/kito/Projects/byok-sdk`
- 交付类型：下一 session 的 decision-complete implementation handoff；本文不授权 publish、deploy、自动更新或生产 minimum-version gate
- 建议 release：新的 additive public behavior 应进入下一 aligned MINOR；不得把它塞进 PATCH。具体版本号以实现时 `docs/spec.md` 与 registry 实时状态为准

---

## 一分钟结论

byok-sdk 已经具备这项能力的核心：运行时是否可用由 **wire protocol 交集 + advertised capabilities + runtime/toolset contract** 决定，不由 `@byok-sdk/client` 是否等于 npm `latest` 决定。

当前缺口不是“增加一个忽略版本检查的 fallback”，而是：

1. Local Agent 没有单一、可读回的 application release identity；`status()`、`conn.hello`、self-hosted `MachineInfo` 与 hosted presence 都不知道正在运行哪个 Local Agent release。
2. `byok-agent` 没有 `--version`；现有 runtime `version` 只表示 Pi/Claude/Codex executable 版本，不是 Local Agent 版本。
3. “Latest 只用于提示，不是启动/连接门禁”尚未成为明确产品 contract 和回归矩阵。
4. 文档写了 N/N-1 / highest-common negotiation，但当前 server 实现实际是“hello 列表必须包含 server 当前唯一 `PROTOCOL_VERSION`”。本刀必须消除这处双重权威，不能继续让文档声称比实现更多。

因此第一刀应实现 **release identity + transport-parity observability + compatibility contract/tests**。不要同时实现 RAFT 式 self-updater。

---

## P1 — 真实架构与 authority map

### 1. 四个版本轴必须分开

| 版本轴 | 当前 authority | 用途 | 是否决定连接 |
|---|---|---|---|
| Local Agent application release | **缺失**；不得拿 runtime version、owner schema version 或 SDK package graph代替 | 告诉 operator/host 当前运行的产品 release | 本刀明确：否 |
| BYOK wire protocol | `packages/protocol/src/version.ts` 的 `PROTOCOL_VERSION` | 决定 envelope/message 是否可互通 | 是，必须有交集 |
| Connection capabilities | `CAPABILITY_FLAGS` + `conn.hello` / `conn.ack` / long-poll response | 对 additive behavior 做逐能力 gating | 是，按具体动作 fail closed |
| Runtime executable version | adapter `detect()` 返回的 Pi/Claude/Codex version | runtime readiness/诊断 | 否；不能冒充 Local Agent release |

另有两个容易混淆但不得复用的字段：

- `daemon-owner.ts` 的 owner-record `version=2` 是本机 owner-file schema version。
- connector MCP `serverInfo.version` 是 MCP server implementation version。

二者都不是 Local Agent release。

### 2. 当前 source of truth

- Product truth：`docs/spec.md`
- Wire version/capability：`packages/protocol/src/version.ts`
- Handshake schema：`packages/protocol/src/messages.ts` 的 `ConnHelloPayloadSchema` / `ConnAckPayloadSchema`
- WS acceptance gate：`packages/server/src/ws-server.ts`
- Long-poll capability projection：`packages/server/src/http.ts`、`packages/client/src/daemon/long-poll-transport.ts`
- Daemon composition：`packages/client/src/daemon/create-daemon.ts`
- CLI：`packages/client/src/bin/byok-agent.ts`
- Self-hosted live read model：`packages/server/src/types.ts` 的 `MachineInfo` 与 `packages/server/src/hub.ts`
- Hosted presence：`packages/cloud/src/handlers/presence.ts` 与 daemon presence producer
- Package release authority：`scripts/release/{check-package-graph,pack-and-smoke,registry-readback,publish}.mjs`

Package release scripts只证明 source/package/registry graph；它们不证明已运行 daemon 的 release identity、兼容性或升级成功。

---

## P2 — 当前实际路径

### 1. 正常启动与连接

```text
byok-agent start
  -> runStartCommand
  -> createDaemon(...).start()
  -> acquire daemon owner lease
  -> detect local runtimes
  -> ConnectionManager
  -> WS conn.hello, or long-poll fallback
```

WS `conn.hello` 当前发送：

- `protocolVersions: [PROTOCOL_VERSION]`
- connection capabilities
- `deviceId` / `productId`
- detected runtimes及其 executable versions
- configured toolset ids
- redelivery cursor

它没有 Local Agent release。

### 2. 为什么旧 application release 现在就可能工作

Server 当前不比较 npm/package semver。它只检查 hello 的 `protocolVersions` 是否包含 server 当前 `PROTOCOL_VERSION`，然后校验 product/device identity，注册 runtimes/capabilities/toolsets。

因此：

- 旧 Local Agent 仍讲 protocol v1，且本次动作需要的 capability/runtime/toolset 都满足：继续工作。
- 旧 Local Agent 不具备某个 additive capability：对应动作在 capability boundary fail closed，不能降级成另一种产品语义。
- protocol set 完全不相交：WS 以 code `1002`、`unsupported protocol version` 明确拒绝。
- `latest` 或 package semver 落后本身：不参与此判定。

现有真实测试已覆盖“hello 同时声明当前版与未来版仍可连接”以及“完全不相交时及时拒绝”，入口是 `packages/server/src/__tests__/version-negotiation.test.ts`。

### 3. Long-poll 边界

Long-poll 没有 `conn.hello`。它按单个 envelope 校验，并通过 `EventsPollResponse.capabilities` 公布 server capability。未知 message type 可作为 forward-compatible entry 跳过；已知 type 但 payload malformed 必须 stall，不能假装成功。

因此 release 可观测性不能只加在 WS hello，否则一开始就落入 long-poll 的设备永远没有 release readback。Hosted 模式应复用现有 presence producer，把同一份 process-immutable release identity 投影到 presence；不得再从 User-Agent、runtime version、package lockfile或路径猜测。

---

## P3 — 设计裁决

### 核心不变量

> Local Agent release identity 负责观测；wire protocol 与 capability 负责兼容性；host distribution authority 负责 Latest。三者不得互相替代。

### 1. 新增唯一 Local Agent release authority

在 daemon composition boundary 增加一个 process-immutable、非 secret 的 release identity：

```ts
interface LocalAgentReleaseIdentity {
  version: string;      // strict semver, distribution-owned
  buildId?: string;     // bounded opaque/content-addressed build identity
}
```

裁决：

- `version` 表示最终 Local Agent distribution 的版本，不表示 `@byok-sdk/client` dependency version，也不表示 runtime version。
- embedding host 必须显式注入该 identity；SDK 不读取 npm registry、不根据 lockfile或安装路径推断。
- official `byok-agent` CLI build 可由 package build step 从唯一 manifest 生成注入值，但 runtime 只消费生成后的常量，不维护第二份手写版本。
- identity 在一个 daemon process 生命周期内不可变；变更必须通过新 process/restart 生效。
- 不接受 `latest`、range、channel 或无法规范化的 semver。

这是 application identity cut，不是 protocol compatibility fallback。若实现会改变 public `DaemonConfig`，按 pre-1.0 MINOR 一次迁移所有仓内 consumer，不保留旧 config alias、双字段或推断路径。

### 2. Wire 与 read-model projection

从同一 identity 做以下 deterministic projection：

1. `conn.hello.localAgentRelease?: LocalAgentReleaseIdentity`
2. self-hosted `ConnectionState` / `MachineInfo.localAgentRelease?`
3. hosted presence body/read model的 `localAgentRelease?`
4. `DaemonStatus.localAgentRelease` 与 `byok-agent --version` / `status` 输出

Wire 字段必须是 optional，因为已发布的旧 daemon 不会发送它；missing 的唯一语义是 `unknown`。Server 不推断、不补默认值，也不因为 missing 而把旧 daemon标成 Latest。

这不是 steady-state product fallback：旧 peer 仍按已冻结的 additive-wire 规则连接；新功能只增加 observability，不改变任务语义。新代码内部必须只有一个 release identity authority，所有输出均是它的 projection。

### 3. Latest 与 minimum supported version

本刀不在 SDK daemon 内新增 Latest fetch。

- `latestVersion` 由最终 distribution host 掌握，例如 Salesko Local Agent 的 signed release manifest；它不等于 npm `@byok-sdk/client@latest`。
- host/UI 可以把 `MachineInfo`/presence 中的 current version 与自己的 Latest 比较，显示 `current | update_available | unknown`。
- `update_available` 仅是观测状态，不能阻止 daemon 启动、pair、connect 或处理本来就有能力处理的 task。
- 当前不引入 `minimumSupportedVersion`。未来若真实安全/协议淘汰需要它，必须单独建立显式 server policy、typed rejection、operator diagnostics 和有限支持窗口；不得把 `latest` 偷换成 minimum。

### 4. Capability 仍是行为 authority

不得写以下逻辑：

```ts
if (agentVersion >= 'x.y.z') assumeCapability('result-document');
```

必须继续检查对端实际 advertised capability。Release version只用于 operator/read model；缺 capability 时，沿现有 typed failure 拒绝具体动作。这样旧 release 可以继续执行它确实支持的工作，又不会因为 semver 猜测而误执行新语义。

### 5. 文档/实现漂移裁决

当前实现只有一个 server `PROTOCOL_VERSION`，握手逻辑是 membership check，不是通用 highest-common resolver。

本刀采用最小真实 contract：

- 文档改为“当前 server 接受 hello 中包含其唯一 supported protocol version 的 daemon”。
- 保留现有 `[v, v+1] -> v` 与 disjoint -> 1002 行为。
- 不为了满足旧文档而凭空增加多版本 codec/dispatcher；只有第二套真实 protocol codec 出现时，才实现真正的 highest-common negotiation。

---

## 实现工作包

### Slice A — release identity authority

建议 ownership：`packages/client` + 最小 shared schema。

1. 在一个 authoritative module 中定义/校验 `LocalAgentReleaseIdentity`。
2. 将 identity 接入 daemon construction，并在仓内所有 production/example/test consumer一次迁移完成。
3. 给 `Daemon.status()` 与 CLI 增加明确 readback；`byok-agent --version` 必须无网络、无 user-state access。
4. Build/pack smoke 验证 packed CLI 输出与 packed manifest一致，禁止手写漂移。

### Slice B — WS/self-hosted projection

建议 ownership：`packages/protocol` + `packages/client` transport + `packages/server`。

1. 给 `ConnHelloPayloadSchema` 增加 bounded optional release identity。
2. WS transport从 daemon authority发送它。
3. Server注册并在 `MachineInfo` 精确读回；disconnect 后沿现有 live-state convention处理，不伪装成当前连接事实。
4. 更新 protocol additive golden与 justification；不 bump protocol v1。

### Slice C — Hosted long-poll/presence parity

建议 ownership：`packages/client` presence producer + `packages/cloud` presence schema/store/read model。

1. 将同一 release identity 放入 presence heartbeat。
2. Cloud store/list/read保持 tenant/device binding，不接受 host request替设备伪造另一个 identity。
3. WS 不可用、从第一跳起长期 long-poll 时，presence仍能读到 release identity。
4. Missing保持 `unknown`；不得从 runtime inventory或HTTP header猜测。

### Slice D — compatibility matrix与规范同步

1. 修正 `docs/protocol.md` 对当前 negotiation implementation 的过度声明。
2. 在 `docs/spec.md` 写入“Latest不是运行门禁；protocol/capability才是运行 authority”。
3. 建立下列真实矩阵，至少覆盖 WS 与 long-poll：

| 场景 | 预期 |
|---|---|
| 旧 daemon，不发送 release identity，protocol v1有交集 | 连接成功；release=`unknown` |
| 新 daemon发送较旧 semver，protocol/capability满足 | 连接和任务成功；host可显示 update available |
| 新 daemon对旧 server发送 additive release field | 旧 server按 frozen additive规则忽略字段，现有任务语义不变 |
| required capability缺失 | 对应 dispatch/action typed reject；不得看 semver放行 |
| protocol集合不相交 | WS 1002 typed close；不 hang、不 long-poll改写语义 |
| WS从第一跳不可用 | long-poll仍工作；presence可观察 release |
| `byok-agent --version` | zero network、zero store read、输出与 packed manifest一致 |

---

## 明确不做

- 不实现自动下载、binary swap、rollback、channel、background auto-update。
- 不把 npm `latest` 当 Local Agent distribution Latest。
- 不把 package semver当 capability、protocol或security policy。
- 不因旧 release而自动切换成低能力 task shape。
- 不增加 alias、双写版本字段、User-Agent/parser fallback或基于路径的版本猜测。
- 不修改 provider secret、device credential、pairing或runtime executable version authority。
- 不 publish、不 deploy、不迁移生产数据。

如果后续要做 self-update，应另开高风险 work-package，至少具备独立签名 trust anchor、manifest/hash/size验证、live owner单写、OS supervisor交接、原子 promote/rollback、运行版本 readback 与 terminal receipt。RAFT 的 same-origin manifest SHA 不能原样照搬成 release authenticity。

---

## 验证与完成门

实现者至少运行：

```bash
bun run build
bun run typecheck
bun run test
repo-harness run check-task-workflow --strict
```

还需要 subject-specific evidence：

1. protocol/server version-negotiation tests通过。
2. client WS + first-hop long-poll compatibility tests通过。
3. self-hosted `machines.list()` 与 hosted presence均能读回同一 release identity。
4. old/missing identity fixture继续连接，且 read model明确为 unknown。
5. pack-and-smoke证明 `byok-agent --version` 与 packed manifest一致。
6. network audit证明正常 `start` 不查询 Latest，`--version` 不访问网络或 user state。
7. release graph仍是单一 aligned version set；本地测试不等于 publish/registry/live distribution证据。

完成定义：以上行为与负向矩阵全部有自动化证据，`docs/spec.md` / `docs/protocol.md` 与实现一致，并且没有引入 updater或 semver-based capability推断。

---

## 下一 session 起手

1. `repo-harness state resolve --json`
2. 读取本文、`docs/spec.md`、`docs/protocol.md`、`tasks/current.md`、`.ai/context/{capabilities,context-map}.json`
3. 用新 plan/contract 承接 Slice A–D；这是跨 `protocol/client/server/cloud` 的 public-contract change，应由 contract worktree执行
4. 先写 red tests锁定“旧 semver仍工作、缺 capability仍拒绝、Latest零启动依赖”，再改 production code
5. 代码冻结后再跑一次完整 required checks；不要在实现中途反复重跑全矩阵

首个 pressure point 是 release identity 的单一 authority。只有它先确定，WS、presence、CLI和host update提示才能成为同一事实的投影，而不是四份会漂移的版本字符串。
