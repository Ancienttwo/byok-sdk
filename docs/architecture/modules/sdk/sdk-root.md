# sdk/sdk-root 架構文檔

<!-- BEGIN ARCHCONTEXT:generated target="projection_target.entity.capability-sdk-sdk-root" rendererVersion="archcontext.docs-renderer/v6" outputDigest="sha256:0dba605b7e8f28d02b4dd49e281971555437e3df14541484209a89e17907430c" -->
> **狀態**:`active`
> **Capability ID**:`capability.sdk.sdk-root`(kind `capability`)
> **Matched Prefixes**:`packages/**`
> **Local Contracts**:`packages/AGENTS.md`、`packages/CLAUDE.md`
> **事實優先級**:倉庫當前狀態 > 本文檔機器區 > 本文檔人工區。機器區(引言、§1、§2)由 ArchContext 從架構模型與源碼度量投影生成,手改會在下次投影被覆蓋。本文檔不記錄出處;本次投影所驗證的 commit 見 `docs/architecture/.projection-manifest.json`。

Owns the BYOK SDK workspace packages: the wire and store contracts, the coordination kernel, the Host compositions, the device daemon, key custody, the Durable Object host and the private conformance suites.

## 1. P1:能力架構地圖

### 1.1 架構圖

```mermaid
flowchart LR
  p1_capability_sdk_sdk_root_17412274["SDK Root"]:::component
  p1_component_sdk_client_agent_home_a701862e["Agent home and local storage"]:::component
  p1_component_sdk_client_approvals_3bfdbfa7["Approvals and tool authorization"]:::component
  p1_component_sdk_client_execution_1c4de85e["Execution and runtime adapters"]:::component
  p1_component_sdk_client_service_615e61a6["Install#44; service and diagnostics"]:::component
  p1_component_sdk_client_session_a9c619b2["Device access and session"]:::component
  p1_module_sdk_client_0b7c484e["Device daemon"]:::component
  p1_module_sdk_cloud_b266d415["Coordination kernel"]:::component
  p1_module_sdk_cloud_dataplane_fe815f0d["Hosted data plane"]:::component
  p1_module_sdk_cloud_do_9a5ce26e["Durable Object agent host"]:::component
  p1_module_sdk_conformance_72ebd5f0["Composition conformance"]:::component
  p1_module_sdk_core_f2477339["Platform contracts"]:::component
  p1_module_sdk_keys_49b8a62f["Provider key custody"]:::component
  p1_module_sdk_protocol_2f521c76["Wire protocol"]:::component
  p1_module_sdk_server_37cdf8e2["Embedded server composition"]:::component
  p1_module_sdk_testkit_7339d0cf["Device simulator"]:::component
  p1_module_sdk_ui_runtime_630140bc["Timeline projection"]:::component
  p1_component_sdk_client_session_a9c619b2 -->|"Pair#44; renew tokens#44; long-poll the device mailbox and post device messages#59; this is the only channel between the device and the Host side."| p1_module_sdk_cloud_b266d415
  p1_module_sdk_client_0b7c484e -->|"Use device proof canonicalization and sealed payloads."| p1_module_sdk_core_f2477339
  p1_module_sdk_client_0b7c484e -->|"Hand accepted offers#44; cancels and steers to the TaskRunner."| p1_component_sdk_client_execution_1c4de85e
  p1_module_sdk_client_0b7c484e -->|"Decode offers and encode device messages."| p1_module_sdk_protocol_2f521c76
  p1_module_sdk_client_0b7c484e -->|"Start the authenticated connection and route received messages to their handlers."| p1_component_sdk_client_session_a9c619b2
  p1_module_sdk_cloud_dataplane_fe815f0d -->|"Drive kernel mailbox wake and truth transactions for the hosted composition."| p1_module_sdk_cloud_b266d415
  p1_module_sdk_cloud_dataplane_fe815f0d -->|"Implement the store ports on Postgres and R2."| p1_module_sdk_core_f2477339
  p1_module_sdk_cloud_dataplane_fe815f0d -->|"Encode and decode mailbox envelopes and apply wire limits in the stores."| p1_module_sdk_protocol_2f521c76
  p1_module_sdk_cloud_b266d415 -->|"Read and write coordination facts through the tenant-first store ports."| p1_module_sdk_core_f2477339
  p1_module_sdk_cloud_b266d415 -->|"Decode and encode wire messages and serve the HTTP paths."| p1_module_sdk_protocol_2f521c76
  p1_module_sdk_conformance_72ebd5f0 -->|"Run the kernel conformance suites against each composition."| p1_module_sdk_cloud_b266d415
  p1_module_sdk_conformance_72ebd5f0 -->|"Run the store port conformance suites."| p1_module_sdk_core_f2477339
  p1_module_sdk_conformance_72ebd5f0 -->|"Assert wire-level behavior."| p1_module_sdk_protocol_2f521c76
  p1_module_sdk_conformance_72ebd5f0 -->|"Drive the device simulator in the simulator suites."| p1_module_sdk_testkit_7339d0cf
  p1_component_sdk_client_execution_1c4de85e -->|"Reserve the Agent home and execution scratch before claim and release them after the terminal result."| p1_component_sdk_client_agent_home_a701862e
  p1_component_sdk_client_execution_1c4de85e -->|"Register every runtime approval and auto-mode tool authorization through TaskRunner.requestApproval."| p1_component_sdk_client_approvals_3bfdbfa7
  p1_module_sdk_keys_49b8a62f -->|"Use the provider provisioning operations and request digests of core."| p1_module_sdk_core_f2477339
  p1_module_sdk_server_37cdf8e2 -->|"Compose the kernel behind the embedded Node HTTP surface."| p1_module_sdk_cloud_b266d415
  p1_module_sdk_server_37cdf8e2 -->|"Provide memory or SQLite implementations of the store ports."| p1_module_sdk_core_f2477339
  p1_module_sdk_server_37cdf8e2 -->|"Use wire types and path constants at the HTTP boundary."| p1_module_sdk_protocol_2f521c76
  p1_component_sdk_client_service_615e61a6 -->|"Start the daemon from the byok-agent start command and the service definitions."| p1_module_sdk_client_0b7c484e
  p1_component_sdk_client_service_615e61a6 -->|"Detect#44; probe and launch runtime adapters from the CLI and the runtime host bins."| p1_component_sdk_client_execution_1c4de85e
  p1_module_sdk_testkit_7339d0cf -->|"Sign device proofs as a simulated device."| p1_module_sdk_core_f2477339
  p1_module_sdk_testkit_7339d0cf -->|"Speak the wire protocol as a simulated device."| p1_module_sdk_protocol_2f521c76
  p1_module_sdk_ui_runtime_630140bc -->|"Read the timeline event and approval observation schemas of the kernel."| p1_module_sdk_cloud_b266d415
  p1_module_sdk_ui_runtime_630140bc -->|"Use wire activity types in the projection."| p1_module_sdk_protocol_2f521c76
  classDef actor fill:#111827,color:#ffffff,stroke:#f9fafb,stroke-width:2px
  classDef component fill:#075985,color:#ffffff,stroke:#bae6fd,stroke-width:2px
  classDef datastore fill:#3f6212,color:#ffffff,stroke:#d9f99d,stroke-width:2px
  classDef external fill:#7c2d12,color:#ffffff,stroke:#fed7aa,stroke-width:2px
```

- Proof: `proven` (`sha256:802940b72d927499e32c950fcf8242cd2796ddf52ca2e7e55af285d2c29d8edd`).
- Semantic nodes: `17`; declared relations: `26`.

### 1.2 模組職責表

- 未宣告 `source.entrypoints`,入口清單無法從架構模型推導。

### 1.3 規模信號

- 規模量級:`2000–5000` 個文件 / `200k–500k` 行
- 匹配前綴:`packages/**`
- 推導:掃描 `source.include` 減 `source.exclude`,跳過 `.git/` 與 `node_modules/`,再按 1–2–5 階梯分桶。精確計數不入本文檔:量級足以回答「這個能力有多大」,而逐行計數會讓覆蓋範圍內任何一次源碼改動都改寫本文檔。

### 1.4 依賴邊界

出向關係:

- 無。

入向關係:

- 無。

## 2. P2:端到端數據流

> **Proof**: `proven` (`sha256:802940b72d927499e32c950fcf8242cd2796ddf52ca2e7e55af285d2c29d8edd`); selectors `4/4`.

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#0d1117","actorBkg":"#312e81","actorBorder":"#c4b5fd","actorTextColor":"#ffffff","signalColor":"#e5e7eb","signalTextColor":"#e5e7eb","labelBoxBkgColor":"#4c1d95","labelBoxBorderColor":"#c4b5fd","labelTextColor":"#ffffff","noteBkgColor":"#78350f","noteBorderColor":"#fcd34d","noteTextColor":"#ffffff","sequenceNumberColor":"#ffffff"}}}%%
sequenceDiagram
  autonumber
  participant p2_runner_4c5ce8b1 as Execution and runtime adapters
  participant p2_home_58695d27 as Agent home and local storage
  p2_runner_4c5ce8b1->>p2_home_58695d27: Validate the AgentRef that the offer names
  p2_runner_4c5ce8b1->>p2_home_58695d27: Derive the canonical Agent home without creating it
  alt The home has a free writer or reader slot
  p2_runner_4c5ce8b1->>p2_home_58695d27: Acquire the execution lease and bind the offer workspace to the home
    Note over p2_runner_4c5ce8b1: Continue to manifest sealing#44; claim and runtime start
  else The home is at its writer or reader limit
  p2_runner_4c5ce8b1->>p2_home_58695d27: Count the active Attempts of the home#59; at the limit decline the offer
    Note over p2_runner_4c5ce8b1: Send task.decline with agent_home_writer_busy or agent_home_reader_busy before claim
  end
```
<!-- END ARCHCONTEXT:generated target="projection_target.entity.capability-sdk-sdk-root" -->

## 3. P3:設計決策與不變量

The existing `packages/**` capability is retained as repository-level SDK ownership. It spans every workspace package under `packages/`: the nine published packages (the eight aligned train packages, including `@byok-sdk/cloud-do` and `@byok-sdk/ui-runtime`, and the credential plane `@byok-sdk/keys`, which uses the release train version from 0.28.2) and the private `@byok-sdk/conformance` and `@byok-sdk/testkit`. The `byok-sdk` umbrella package was retired in 0.21.0 (ADR-035). Package and runtime responsibilities remain documented in [the SDK architecture](../../sdk-architecture.md) and [the authority ADRs](../../adr-2026-09-03-domain-model-and-authority.md); this adoption does not repartition public packages.

The generated map is a representative local execution slice, not an exhaustive diagram of every SDK subsystem. `TaskRunner.handleOffer` calls the same-file AgentRef/decline helpers and the owned runtime-start wrapper. The helper component shares its source file with the orchestrator; it is not another service or admission implementation. The three selectors prove those direct calls and their declared branches. Dynamic adapter preparation/start, network delivery, persistence and model generation require their separate tests and runtime evidence.

`handleOffer` deduplicates an already-owned task, checks strict Agent identity, prepares the selected adapter, seals its manifest before claim, resolves input, then awaits owned startup. Invalid Agent identity is declined before startup. A startup timeout withdraws admission and retains disposal responsibility; it is not a quiescence receipt. At higher concurrency the real constraints remain runtime ownership, workspace leases and bounded task resources, rather than an additional execution state machine.

C07's proposed pre-Execution full-request preparation API remains a separate unimplemented contract. This flow begins after an SDK offer exists. The offline preparation/consume spike proves its controlled native request seam only; it does not authorize production budget configuration.

## 4. 歷史決策記錄(append-only)

### Cloud slice 4a (2026-10-03)

`packages/cloud-do` is a private Cloudflare deployment boundary under the existing
SDK root capability. ADR-035 preserves runtime boundaries and the nine published
artifacts: this host adds no published package or public client export. The client
retains its local replica admission/lock/reset/inspect path; only native pi Storage
construction is injectable. The DO adapter consumes portable pi SQLite and Harness
exports, with a type-only reference to the factory declaration; it does not import
the local client engine or environment. One named DO owns one Harness and creates
a new ownerless conversation for each execution. Its async SQL transaction queue
and pi-prefixed schema preserve native storage semantics. Configuration, tests,
runtime constraints and deferred 4b–4d responsibilities are documented in
[`packages/cloud-do/README.md`](../../../../packages/cloud-do/README.md).

The broader unmatched examples and ancestor capability coverage are intentional
repository ownership observations for separate architecture work; 4a does not
repartition them. Verification is the complete native pi conformance suite on
local SQLite and real workerd, execution isolation/restart and the root gates.

### cloud-do publication status note (2026-10-13)

The 4a entry above is stale on one point: `packages/cloud-do` is no longer a
private, unpublished boundary. Since the 0.24.0 train `@byok-sdk/cloud-do` is a
published package (`packages/cloud-do/package.json` has no `private` flag and sets
`publishConfig.access: public`; see `docs/releases/v0.24.0.md`). It stays
Cloudflare-only and platform-key-only (ADR-038 decision 4). The 4a description of
its runtime boundaries is otherwise unchanged.

## Optimization Backlog
