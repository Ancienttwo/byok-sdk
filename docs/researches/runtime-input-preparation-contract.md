# Runtime input preparation / consume boundary

Status: proposed SDK contract with provider-free feasibility evidence. This document adds no public SDK API and does not replace accepted C05.

Owner authorized an independent contract and minimal offline spike on 2026-09-14. Source base: f811634c8c9ac6a16891c354eaf0adcb869004a2. Downstream authority remains Salesko frozen draft-3 §4.2/§7.3/§7.4, SHA256 c7288bdbf399d71af6ec131fc86047ced363fb7541af5493c74cf990ae5c6678. Production numbers remain governed by S0.

## P1: ownership and gap

Host owns canonical source, ContextPack, admission readiness and atomic Execution creation. SDK owns exact runtime/provider selection, toolset authority and serialization. Provider owns token accounting. Current RuntimeAdapter.prepare receives a task offer and only validates runtime/profile constraints; Pi builds final provider input after claim/start. An ordinary SDK task cannot serve as a pre-Execution counting probe.

The new boundary must be independently callable before task submission. Preparation returns immutable input evidence, not an Execution, running task, tool grant, approval bypass or product result.

## P2: proposed data path

1. Host assembles one consistent ContextPack candidate, with exact owner, Agent, device, epoch, queue head, selection and revision.
2. SDK authenticates preparation through device/control authority and compiles complete runtime input under explicit disclosure/tool policy. No business tool or model execution occurs. Uncontrolled runtime startup code cannot participate.
3. Device-local credentials call the exact authorized counter endpoint. For the selected target it is https://api.z.ai/api/coding/paas/v4/tokenizer; general API endpoints are not interchangeable.
4. SDK returns an immutable artifact reference and evidence bound to full payload, counted projection, target, runtime closure, policies and coverage.
5. Host validates the input bound plus output/reasoning bound and uncounted overhead against the effective window, then performs the existing short CAS transaction. Network calls never hold PG row locks.
6. The committed Execution/offer binds that artifact. SDK launch consumes the same payload or refuses. Missing artifacts or identity/source/policy drift cannot trigger silent reassembly.

Wire names and versions remain unassigned. Production requires exact schema/capability/transport registration; experiment JSON is not a public protocol.

## Minimum semantic contract

| Part | Required evidence |
| --- | --- |
| Preparation request | Authenticated tenant/device/Agent ownership; exact selection/profile binding; source/ContextPack digest; disclosure/tool manifests; effective model identity |
| Prepared input | Immutable full request bytes/reference; compiler/runtime dependency fingerprint; endpoint and semantic options; authorized context/tool schemas; no credentials or nonce |
| Accounting | Exact counted projection and deterministic relation to full request; method/authority revision; count or proved bound; coverage gaps with independently proved bounds; output/reasoning enforcement and window evidence |
| Consumption | Expected artifact digest and exact target/source/policy; unchanged initial request at actual send boundary; later hooks cannot rewrite counted input |
| Lifecycle | No task/claim/business grant during preparation. Host commit remains the execution decision. Failed CAS leaves no dispatchable task. Post-commit artifact failure follows existing recovery and never substitutes new input |
| Authorization | Existing authenticated SDK/device authority; no caller-self-asserted identity or D2 task nonce before task existence. Digests prove content identity, not permission |
| Limits | Owner-frozen byte/call/retention limits before implementation. Experiment timeout/byte counts never become product defaults |

Receipt durability, retry availability, transport authentication, accounting equivalence, disclosure and cancellation during preparation must be specified before production activation. No mutable current-artifact authority or second Execution/job state machine.

## P3: falsifier and sufficient condition

Let D be the immutable full request, P(D) its counted projection, N the authoritative count, U a proved bound for omitted semantic/provider framing, O the enforced output/reasoning bound and W the effective window. Require N+U+O <= W and proof that launch sends D under the same exact target/policy. CAS closes source-to-commit races; immutable consumption closes count-to-launch races. Byte equality does not prove token-accounting equivalence.

The cheapest falsifier is native compilation before task submission, a separate consuming launch and actual transport-body inspection. Altered artifact, target or authorized context must refuse before transport. A hook-only comparison cannot detect later serializer changes.

## Offline spike and result

Entrypoint: node scripts/experiments/runtime-input-preparation-spike.mjs.

Subject: installed Pi 0.85.1 and its bundled JavaScript closure, with an explicit Node binary. Repository production packages/dependencies are unchanged.

The probe creates a temporary cwd/agent directory with a synthetic AGENTS marker. Native Pi supplies its built-in system prompt, user input and four native tools; only the explicit artifact extension loads. Prepare exits at before_provider_request before SDK task submission or provider transport. A second native process validates artifact/binding and supplies the frozen payload. An Undici mock captures the POST body after serialization and returns fixed synthetic SSE.

| Case | Result |
| --- | --- |
| Prepare | Immutable request saved; no transport |
| Consume | Actual transport body equals prepared payload byte-for-byte |
| Alter artifact | artifact_integrity; no transport |
| Change Profile revision | binding_drift; no transport |
| Change authorized context | context_drift; no transport |

Current fixture payload is 6265 bytes, not a production budget. One mock transport request; zero external connections, credential reads, SDK task submissions or model generations. Source-bound result: _ops/c07-runtime-input/result.json. Disposable artifacts/logs remain local.

The first dispatcher mock failed safely: Pi configureHttpDispatcher overwrote it at startup and the socket guard refused the connection. Installing the same Undici mock from the final request hook fixes timing while preserving the independent socket guard. first-consume-blocked.log retains the failure. A subsequent refinement bound the full bundled JavaScript closure instead of only the entrypoint; all five cases passed.

## Proven boundary and limits

The controlled native serializer can produce a complete initial request before any SDK task exists. Its existing final payload hook can feed exactly those bytes into a separate native launch. This establishes feasibility of the input preparation/consume seam.

It does not implement a pure SDK compiler: prepare still starts an isolated CLI and writes disposable runtime files. Synthetic digest/binding is an experiment oracle, not authentication. Real MCP schemas, arbitrary extensions/private homes, artifact durability, Host CAS integration, counter equivalence and later tool-result iterations remain uncovered. Production must own or forbid every later payload writer and prove disclosure/side-effect constraints; it cannot simply ship this extension.

## Bounded next implementation decision

Specify SDK-owned preparation/consume API and authenticated artifact lifecycle around this seam, then prove preparation purity and real toolset/context projection. Keep production unsupported until these and counter coverage suffice. No release, package change, C05 amendment or production budget follows from this spike's PASS.
