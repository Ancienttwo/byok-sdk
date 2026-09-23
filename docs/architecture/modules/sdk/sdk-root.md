# sdk/sdk-root 架構文檔

<!-- BEGIN ARCHCONTEXT:generated target="projection_target.entity.capability-sdk-sdk-root" sourceDigest="sha256:b529778eefbc69b17bb089e832735ad1e7f2df5d56b635619f6d4b074941f00b" rendererVersion="archcontext.docs-renderer/v4" outputDigest="sha256:8222fcd9af4f9c98f517da7bef7d2e7d4598d5b86469f723f04a6d54ce6f0f53" -->
> **狀態**:`active`
> **Capability ID**:`capability.sdk.sdk-root`(kind `capability`)
> **Matched Prefixes**:`packages/**`
> **Local Contracts**:`packages/AGENTS.md`、`packages/CLAUDE.md`
> **事實優先級**:倉庫當前狀態 > 本文檔機器區 > 本文檔人工區。機器區(引言、§1、§2)由 ArchContext 從架構模型與源碼度量投影生成,手改會在下次投影被覆蓋。本文檔不記錄出處;本次投影所驗證的 commit 見 `docs/architecture/.projection-manifest.json`。

Owns the existing SDK packages and their public namespace documentation and tests.

## 1. P1:能力架構地圖

### 1.1 架構圖

```mermaid
flowchart LR
  p1_capability_sdk_sdk_root_17412274["SDK Root"]:::component
  p1_component_sdk_offer_validation_be71eed1["Offer identity and decline helpers"]:::component
  p1_module_sdk_runtime_start_b3d0d660["Owned runtime startup"]:::component
  p1_module_sdk_task_runner_ca53132d["Task offer orchestration"]:::component
  p1_module_sdk_task_runner_ca53132d -->|"Validate the offered AgentRef and build an explicit decline for invalid identity or unavailable required local capabilities."| p1_component_sdk_offer_validation_be71eed1
  p1_module_sdk_task_runner_ca53132d -->|"Await prepared operation startup with the remaining admission deadline and preserve cleanup ownership on cancellation or failure."| p1_module_sdk_runtime_start_b3d0d660
  classDef actor fill:#111827,color:#ffffff,stroke:#f9fafb,stroke-width:2px
  classDef component fill:#075985,color:#ffffff,stroke:#bae6fd,stroke-width:2px
  classDef datastore fill:#3f6212,color:#ffffff,stroke:#d9f99d,stroke-width:2px
  classDef external fill:#7c2d12,color:#ffffff,stroke:#fed7aa,stroke-width:2px
```

- Proof: `proven` (`sha256:30b54e202b5c6fed844ccf2cb53375674947246b514d7db9886000e60fb1d069`).
- Semantic nodes: `4`; declared relations: `2`.

### 1.2 模組職責表

- 未宣告 `source.entrypoints`,入口清單無法從架構模型推導。

### 1.3 規模信號

- 規模量級:`1000–2000` 個文件 / `200k–500k` 行
- 匹配前綴:`packages/**`
- 推導:掃描 `source.include` 減 `source.exclude`,跳過 `.git/` 與 `node_modules/`,再按 1–2–5 階梯分桶。精確計數不入本文檔:量級足以回答「這個能力有多大」,而逐行計數會讓覆蓋範圍內任何一次源碼改動都改寫本文檔。

### 1.4 依賴邊界

出向關係:

- 無。

入向關係:

- 無。

## 2. P2:端到端數據流

> **Proof**: `proven` (`sha256:30b54e202b5c6fed844ccf2cb53375674947246b514d7db9886000e60fb1d069`); selectors `3/3`.

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#0d1117","actorBkg":"#312e81","actorBorder":"#c4b5fd","actorTextColor":"#ffffff","signalColor":"#e5e7eb","signalTextColor":"#e5e7eb","labelBoxBkgColor":"#4c1d95","labelBoxBorderColor":"#c4b5fd","labelTextColor":"#ffffff","noteBkgColor":"#78350f","noteBorderColor":"#fcd34d","noteTextColor":"#ffffff","sequenceNumberColor":"#ffffff"}}}%%
sequenceDiagram
  autonumber
  participant p2_runner_4c5ce8b1 as Task offer orchestration
  participant p2_validation_56a509f1 as Offer identity and decline helpers
  participant p2_startup_a2789b63 as Owned runtime startup
  p2_runner_4c5ce8b1->>p2_validation_56a509f1: Read and validate the strict offer AgentRef
  alt Offer passes local admission， input resolution and preparation
  p2_runner_4c5ce8b1->>p2_startup_a2789b63: Await the owned startup wrapper with the prepared operation and resolved input
    Note over p2_runner_4c5ce8b1: Receive Session from the wrapper； later binding， pumping and terminal settlement remain separate steps
  else Invalid AgentRef or required local Agent-home capability unavailable
  p2_runner_4c5ce8b1->>p2_validation_56a509f1: Emit explicit task.decline and return before runtime startup
    Note over p2_runner_4c5ce8b1: Return from the offer handler without starting a runtime
  end
```
<!-- END ARCHCONTEXT:generated target="projection_target.entity.capability-sdk-sdk-root" -->

## 3. P3:設計決策與不變量

The existing `packages/**` capability is retained as repository-level SDK ownership. It is broader than the published `byok-sdk` umbrella package: `packages/sdk/src/index.ts` exports dispatch namespaces and deliberately excludes the independently scoped credential plane `@byok-sdk/keys`. Package and runtime responsibilities remain documented in [the SDK architecture](../../sdk-architecture.md) and [the authority ADRs](../../adr-2026-09-03-domain-model-and-authority.md); this adoption does not repartition public packages.

The generated map is a representative local execution slice, not an exhaustive diagram of every SDK subsystem. `TaskRunner.handleOffer` calls the same-file AgentRef/decline helpers and the owned runtime-start wrapper. The helper component shares its source file with the orchestrator; it is not another service or admission implementation. The three selectors prove those direct calls and their declared branches. Dynamic adapter preparation/start, network delivery, persistence and model generation require their separate tests and runtime evidence.

`handleOffer` deduplicates an already-owned task, checks strict Agent identity, prepares the selected adapter, seals its manifest before claim, resolves input, then awaits owned startup. Invalid Agent identity is declined before startup. A startup timeout withdraws admission and retains disposal responsibility; it is not a quiescence receipt. At higher concurrency the real constraints remain runtime ownership, workspace leases and bounded task resources, rather than an additional execution state machine.

C07's proposed pre-Execution full-request preparation API remains a separate unimplemented contract. This flow begins after an SDK offer exists. The offline preparation/consume spike proves its controlled native request seam only; it does not authorize production budget configuration.

## 4. 歷史決策記錄(append-only)

## Optimization Backlog
