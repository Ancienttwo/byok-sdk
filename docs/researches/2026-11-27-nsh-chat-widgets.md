# NSH chat dynamic widgets: research for the spec, rendering and contract

- **Date**: 2026-11-27
- **Baseline**: `main@18b963e8a`
- **NSH pin**: `2964346c285f57004f2531fb768cc9840b8d7ff5` (`examples/desktop-bot-app/scripts/nsh-pin.json`), read from the cargo git checkout of that rev. NSH paths below are written `nsh:<path>:<line>`.
- **Tracking**: research slice [#2553](https://github.com/Ancienttwo/byok-sdk/issues/2553) of parent [#2552](https://github.com/Ancienttwo/byok-sdk/issues/2552). Decision record: [ADR-053](../adr/ADR-053-chat-dynamic-widgets.md).
- **Inputs**: the parent's fixed constraints, the mock brief `_ops/widget-mock/handoff.md` (ignored local file), [ADR-052](../adr/ADR-052-desktop-native-ui-nsh-mixed.md).
- **Missing input**: the owner's artifact export (`_ops/widget-mock/artifact/`: types, fixtures, open questions) was not present when this was written. Question 6 is answered only where `handoff.md` states the shape verbatim (section 6).

Every claim cites a file and line at the baseline or at the NSH pin. Nothing here was rendered on a device. The platform coverage in section 1 rests on the source, not on a run.

## 1. NSH rendering primitives at 2964346 (question 1)

NSH has two native vector layers. A TSX app can use both under the D2 capability set (`{ application, openUrl: https }`).

**`Canvas` (core, no feature gate).** `Canvas` from `nsh` takes `draw(cx, { width, height })` and records a subset of the HTML Canvas 2D API (`nsh:crates/nsh-js/src/canvas.rs:1487`, declarations `:1545-1598`). The subset covers:

- paths: `moveTo`, `lineTo`, curves, `arc`, `rect`, `roundRect`, and `Path2D` from SVG path data (`nsh:website/docs/canvas.md:146`, `:200-202`);
- `fill`, `stroke` and `fillRect`;
- `setLineDash` and `lineDashOffset` (`nsh:website/docs/canvas.md:136`; `nsh:crates/nsh-js/src/canvas.rs:1563`);
- `fillText` and `measureText` (`nsh:website/docs/canvas.md:150`);
- `fontVariantNumeric: "tabular-nums"` (`:141`);
- gradients (`:192`).

`canvas` is a plain module of `nsh-core` (`nsh:crates/nsh-core/src/lib.rs:17`). Only `svg` is a cargo feature there (`nsh:crates/nsh-core/Cargo.toml:52`).

The recording is replayed by each desktop platform's own 2D engine:

| Platform | Engine | Dashes | Tabular figures |
|---|---|---|---|
| macOS | Core Graphics (`nsh:crates/nsh-platform-macos/src/canvas.rs:1-2`) | `CGContext::set_line_dash` (`:1267`) | `:986` |
| Windows | Direct2D (`nsh:crates/nsh-platform-windows/src/canvas.rs:1`) | `D2D1_DASH_STYLE_CUSTOM` stroke style (`:2239-2262`) | `:1389`, `:3050` |
| Linux | Cairo (`nsh:crates/nsh-platform-linux/src/canvas.rs:1`) | `set_dash` (`:1170`) | `:652`, `:919` |

Drawing needs no capability. The only capability gate on a canvas is the source of an image it draws (`nsh:crates/nsh-core/src/core/mod.rs:5208-5223`).

**`nsh/base/plot` (charts built on the canvas).** `nsh:crates/nsh-base/src/plot/mod.rs:1-27` describes `Plot` with these marks:

- `Line`, `Area`, `Bar`, `Rule`, `Dot`, `Cell`, `Grid`;
- `Pie`, `Arc`, `RadialLine`, `RadialGrid`;
- `Sankey`, `Treemap`;
- `PlotAxis` and `PlotLabel`.

Each mark is a canvas filling the plot. Rows are scaled and drawn in Rust, so no JS runs per point. Line, area and grid take `stroke`, `strokeWidth` and `strokeDasharray` (`nsh:website/elements/plot.md:210-212`), so a dashed benchmark line is a prop. A plot has `accessibilityLabel` and `accessibilityValue` (`plot.md:109-110`). The upstream gallery imports the whole set from TSX (`nsh:examples/gallery/demos/Charts.tsx:3`).

`plot` is a cargo feature of `nsh-base` and is in its default set (`nsh:crates/nsh-base/Cargo.toml:15`, `:23`; `nsh:crates/nsh-base/src/lib.rs:54-55`). It is also in the default set of the three desktop app crates (`nsh:crates/nsh-macos-app/Cargo.toml:16`; the same line in the Windows and Linux app crates). `nsh package` keeps a runner feature only when the bundle imports it. `plot` is kept by the `nsh_part_plot` gate (`nsh:crates/nsh-cli/src/native_features.rs:16-21`). nsh-app imports `nsh/base` today but not `nsh/base/plot` (`examples/desktop-bot-app/nsh-app/src/ui/*.tsx`), so the first chart widget adds the feature to the release runner. Its size delta has to be measured when that happens.

**Text.** Text style `fontVariant` takes `["tabular-nums"]` (`nsh:crates/nsh-core/src/style.rs:1947`). Tailwind `tabular-nums` maps to it (`nsh:crates/nsh-core/src/tailwind/utilities.rs:1736`).

**What else exists.** NSH has no standalone `Svg`, `Polyline` or `Shape` element. `Image` and canvas `drawImage` accept `data:image/svg+xml` and rasterize it with resvg (`nsh:website/docs/canvas.md:320`). `data:` URIs are not capability-gated (`nsh:crates/nsh-core/src/access.rs:2233-2238`).

**Conclusion.** Line, area, bars, a dashed line and text labels all render natively on the three desktop platforms through `nsh/base/plot`. A Canvas `draw` function can draw whatever Plot does not cover, such as a fixed-size sparkline. Box-only Views (bars as Views, lines dropped) are not needed. The last fallback is the Data table that every widget has (section 6).

## 2. Transcript integration (question 2)

**Current shape.**

- `ConversationItem` is a closed union of six kinds (`examples/desktop-bot-app/src/host/conversation/view.ts:37-43`).
- Keys are `e<seq>` for input, reply and clear (`view.ts:112-114`), `t<turnId>` for working and ended, and `q<questionId>` (`view.ts:123-135`).
- `seq` is an `AUTOINCREMENT` column, so keys never collide across kinds (`src/host/store/store.ts:10`).
- Rows sort by a float anchor. Entries sit at their own `seq`. A Turn's status row (working or ended) sits at its input `seq + 0.5`, through `after(seq) = seq + 0.5` (`view.ts:117`, `:123`, `:128`). A question sits at `after(seq) + 0.25`, that is `seq + 0.75` (`view.ts:134`). The reply is a later entry with its own integer `seq`.
- No item carries a revision today. A change arrives as the same key with new fields.
- The Host returns the whole snapshot on every `k8.view` (`src/host/conversation/service.ts:61-90`). A payload-free state hint tells the UI to read it again (`src/host/supervise.ts:37-39`, `src/main/state-hint.ts:9-17`).

**nsh-app List** (`nsh-app/src/features/conversation/Transcript.tsx:209-230`):

- `keyExtractor={(item) => item.key}`;
- `estimatedItemSize={64}`;
- `alignment="bottom"`, `initialScrollAtEnd`;
- `maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 48 }}`.

Each cell mounts an `Each` keyed `${key}:${kind}` (`:226`). A rev replacement keeps the key and the kind, so the row keeps its instance and gets the new item. Local state in a row is lost when the cell recycles. `QuestionRow` keeps its draft answer in a row-local signal (`Transcript.tsx:105-106`). That is exactly the pattern #2552 rules out for widgets.

**NSH List semantics.**

- Unmeasured rows assume `estimatedItemSize` (default 50); rows are measured as they render (`nsh:website/docs/lists.md:141`).
- In TSX, a list matches rows by `keyExtractor` and keeps a row's cell and measured size while its key stays (`lists.md:147-149`).
- A changed item must be a new object (`lists.md:152`).
- Rows inserted above the visible rows never move them (`lists.md:149`, `:502`).
- A row that changes height while entirely above the viewport makes the list scroll by the same delta, so the visible content stays put. A row inside the viewport that changes height is not anchored. See `nsh:crates/nsh-core/src/core/list.rs:1558-1581` (`measured`, `before_viewport_changed`) and the test at `:2283-2292`, where row 0 above the viewport anchors by +30 and row 30 in view anchors by 0.

**Consequences for widgets.**

- A widget is one more `ConversationItem` kind with key `w<widgetId>`. The `w` prefix keeps it disjoint from `e`, `t` and `q`.
- `rev` is an integer stamped by the Host. A newer rev arrives as a new item object under the same key, and the List replaces it in place.
- A widget above the viewport may change height without moving the reader. One in view pushes the rows below it. A rev replacement moves the reading position only if the body height changes, so each component state has a fixed body height. `loading` takes the height of `ready`, and `partial`, `degraded` and `failed` add one notice line of fixed height. The ADR states this as a restriction (ADR-053 §3).
- `estimatedItemSize` stays one number per list (`nsh:crates/nsh-js/src/list.rs:721`; there is no per-item size prop). 64 stays. Widgets are taller, but a wrong estimate only affects the scroll bar and jumps to far rows before measurement.
- A widget's sort anchor is its Turn's input `seq + 0.625`: after the Turn's status row (`+0.5`), before its question (`+0.75`) and before its reply (a later `seq`). While the Turn works, the order is input, working row, widgets. Once it has replied, the order is input, widgets, reply. Several widgets of one Turn keep the order of their `widgetId`.
- Draft state (form values, choice selection, a pending action key) lives in `nsh-app/src/store.ts`, keyed by `widgetId`. This follows `pendingClears`, which keeps an action id per Bot until the Host confirms it (`store.ts:278-290`).

## 3. Spec home (question 3)

| Option | API surface | Consumers | Boundary fit |
|---|---|---|---|
| `@byok-sdk/ui-runtime` | Public and published. Golden `api-surface/ui-runtime.d.ts`, exact `budgetBytes: 625485` (`api-surface/entries.json:3011-3015`). Every spec type grows the budget, and later spec changes become semver changes of an SDK package. | The desktop Host and nsh-app only. | ADR-052 D3 runs ui-runtime only in the Node Host and lets TSX import its types only (ADR-052 §3 table, row 4). ADR-052 §4 keeps desktop UI material out of `packages/*`. |
| New package `packages/widget-spec` | A new public package, a release-graph entry, version authority and an api-surface golden. | Same single consumer. The Electron renderer is deleted at the #2462 cutover. A gpui-kit renderer exists only as the ADR-052 D1 fallback. | Fails the rule that a shared package needs a second independently released consumer. |
| **Desktop app `examples/desktop-bot-app/src/widgets/`** | None. The example is private. | The Host validates. nsh-app and the Electron renderer import types with `import type`, the way nsh-app already imports Host types (`nsh-app/src/store.ts:4-7`). | Keeps the Host/UI split of ADR-052 D3. QuickJS loads no validator code. |

The desktop app wins. The validator runs only in the Host. The Host writes its parameter checks by hand today (`src/host/conversation/service.ts:15-19`, `src/host/activity/domain.ts:14-16`). For a 22-component discriminated union, a zod schema is better, because it is one source for both the validator and the JSON Schema of the tool's advertised input (`z.toJSONSchema`). zod `^4.6.6` is already in the workspace (`packages/client/package.json:120`) and already in the Host bundle through `@byok-sdk/client`. The desktop app would list it directly; it has no `zod` entry today.

The renderer-agnostic rule means the spec names no NSH type, class or Plot prop. Semantic `variant` values are mapped to tokens in `nsh-app/src/ui`.

## 4. Bridge contract (question 4)

`bridge-contract.json` is generated from `src/bridge/domains/*.ts` through `buildBridgeContract()` (`src/bridge/protocol.ts:120-139`, `scripts/generate-bridge-contract.mjs:4-20`). The drift gate is `src/bridge/bridge.test.ts:588-598`. The file lists method names only:

- `schemaVersion: 2`, `bridgeVersion: 2` (`bridge-contract.json:2-3`);
- `k8.view` and `k8.answer` under both `rendererMethods` and `hostMethods` (`:13`, `:19`, `:46`, `:52`).

**The widget item kind is not a contract-file change.** It is a type change in `view.ts` (the union) and nothing else. `k8.view`'s result type already points at that union through `ConversationSnapshot` (`src/bridge/domains/k8.ts:12`).

**Today's interaction path.**

- `k8.answer {questionId, answer} → null` carries no client key (`k8.ts:21`).
- The Host passes it to K8 (`service.ts:137-142`).
- K8 dedupes by `questionId`. The same answer again is a no-op, a different answer throws `Answer identity conflict`, an unknown question throws (`packages/bot-collaboration/src/rules/commands.ts:297-311`).
- `k8.send` and `k8.clear` already carry a client `actionId` that is reused on retry (`k8.ts:16-18`). The Host store dedupes a send by that id before K8 sees it (`src/host/k8/conversation.ts:112-118`).
- A send while the Bot's Turn is still open is not refused. K8 queues it, and inputs that arrive while the Bot is busy coalesce into its next Turn in arrival order (`packages/bot-collaboration/src/rules/coalesce.ts:72-96`).

**Change.** One method, `k8.act`, replaces `k8.answer` in `K8Methods` and in `K8_DOMAIN.renderer`. The JSON diff is one name in `rendererMethods` and one in `hostMethods`. The full shape is in ADR-053 D4. Both renderers call `k8.answer` today (`nsh-app/src/store.ts:299-301`, `src/renderer/conversation/transcript.tsx:19`). Both move to `k8.act` in the PR that deletes `k8.answer`.

**Versions.**

- `schemaVersion` versions the file's shape. It went 1 → 2 when #2465 added the `shellToHostMethods` key. That same commit added a method without touching `bridgeVersion` (`git show a85fde7bc -- examples/desktop-bot-app/src/bridge/bridge-contract.json`).
- Renaming one method name changes neither key, so `schemaVersion` stays 2.
- `bridgeVersion` (`BRIDGE_VERSION = 2`, `src/bridge/protocol.ts:22`) also stays. The shell embeds the contract at compile time (`native/byok-shell/src/contract.rs:9`), and the Host and both shells ship in one package with no version negotiation (ADR-052 S2).

## 5. Host resolution (question 5)

### 5.1 Declaring `render_widget` for every engine

The desktop Host configures no MCP toolset today (no `toolset`/`mcpServers` reference under `examples/desktop-bot-app/src`). The SDK has one documented mechanism for a host-integrated tool, "Task-scoped host MCP toolsets" (`docs/spec.md:2715-2734`):

- `DaemonConfig.mcpToolsets` names stdio servers by toolset id (`packages/client/src/daemon/create-daemon.ts:355`).
- An offer names ids in `requiredToolsets` (`packages/server/src/types.ts:159`). The embedded server forwards it (`packages/server/src/index.ts:616`).
- The daemon resolves the ids before claim (`packages/client/src/daemon/task-runner/offer-admission.ts:168-174`) and mounts the servers for the adapter (`task-runner/offer-runtime.ts:135-163`).

Every adapter advertises `mcpToolsets: true`: claude, codex, pi, antigravity, opencode, dsh, grok (`packages/client/src/adapters/*/*-capabilities.ts`, for example `claude/claude-capabilities.ts:13`, `grok/grok-capabilities.ts:12`). The daemon then advertises `toolset-selection` (`packages/client/src/daemon/create-daemon/support.ts:189-191`). One toolset therefore reaches every engine with no per-adapter code. An engine without `mcpToolsets` is declined at admission, with no tool-less fallback (`docs/spec.md:2733-2734`). Antigravity refuses only entries with `env` or `headers` (`adapters/antigravity/agy-capabilities.ts:9-18`), and a desktop toolset needs neither.

K8 lets a Bot execution name only toolsets the Host declared read-only. That is `BotCollaborationHostOptions.readOnlyToolsets`, enforced by `admitBotToolsets` (`packages/bot-collaboration/src/host.ts:63-64`, `:265-267`; `rules/team.ts:13-18`). `render_widget` writes only the Host's own transcript and reaches no external system, so it meets that contract.

### 5.2 Binding a call to its task (the pressure point)

The parent requires an invalid spec to fail closed *with an error to the model*. So the tool's answer must come from the validator, synchronously. It also must know which task (Turn and Bot) the call belongs to, to resolve `snapshotRef` and to place the widget.

A host toolset server is a child process that the runtime starts. It learns its task only through the task-context lane: the daemon appends a context file, the child exchanges it for a short-lived task assertion through `requestTaskAssertion`, and the Host verifies it (`docs/spec.md:2575-2618`; `packages/client/src/daemon/task-runner/mcp-contexts.ts:116-175`). The daemon mints a nonce only when the deployment declares `host-mcp-task-context` (`docs/spec.md:2609-2618`). The embedded `@byok-sdk/server` builds its declaration with `capabilityDeclarationForPorts(ports)` (`packages/server/src/index.ts:455`). That function never includes `host-mcp-task-context` (`packages/cloud/src/capabilities.ts:191-196`). Cloud can declare it (`includeHostMcpTaskContext`, `capabilities.ts:149`, `:222-223`) and ships the verification (`packages/cloud/src/auth/device-assertion.ts:95`). So in the desktop Host today a widget child would get no nonce, and `requestTaskAssertion` would refuse with `context_token_invalid` (`docs/spec.md:2615-2618`).

| Path | What changes | Cost |
|---|---|---|
| **A. Host toolset plus the task-context lane** | `@byok-sdk/server` gains an opt-in to declare `host-mcp-task-context` and to verify a task assertion with the composition cloud already ships. The desktop Host adds the `render_widget` toolset: the Host binary in an argv mode as the stdio server, a loopback route that verifies the assertion and answers. | A public `packages/server` change (api-surface golden and budget) on an authentication path. The widget semantics stay in the desktop app. Any embedded host gains the lane. |
| B. SDK-reserved helper on the `submit_result` model | A fifth reserved server in `packages/client/src/sdk-reserved-mcp.ts:30-48`, a helper bin like `bin/agent-result-mcp-server.ts:39-67` that forwards raw arguments over the daemon's control socket, and a `DaemonConfig` port through which the Host validates and resolves. | Needs no capability, because the daemon-local token is enough. But it puts a desktop product tool into the SDK's reserved protocol set, grows the `@byok-sdk/client` surface (`DaemonConfig`, the reserved-name tuple) and adds a second way to declare host tools next to the documented one. |
| C. Host toolset without binding | The child validates locally and the Host projects from the observed `tool_use`. | Cannot resolve `snapshotRef` synchronously. The Host must validate again at projection because a runtime-reported `tool_use` is not proof the child saw it. Rejected. |

The research recommends path A. It reuses the lane the SDK documents for exactly this case and keeps the widget catalog out of `packages/*`. It touches assertion verification, so it went to the owner. The owner chose path A on 2026-11-27 ([decision record](https://github.com/Ancienttwo/byok-sdk/issues/2553#issuecomment-7219557886)). The `@byok-sdk/server` slice is its own High-tier child, [#2559](https://github.com/Ancienttwo/byok-sdk/issues/2559), and it blocks #2554.

### 5.3 Where `snapshotRef` resolves

**The model cannot fill the mock's `{ turnId, toolCallId }`.**

- The model never sees a K8 `turnId`. It is a Host-side id (`src/host/conversation/service.ts:72`).
- `toolCallId` is optional on both `tool_use` and `tool_result` (`packages/protocol/src/agent-event.ts:86`, `:97`).
- Every bundled adapter sets it today: claude (`adapters/claude/projection.ts:214`, `:300`), codex (`codex/projection.ts:24`), pi (`pi/mcp-tools.ts:29`), and grok, antigravity, dsh and opencode through the shared `adapters/acp-turn-buffer.ts:45-56`. So the Host can pair a `tool_use` with its `tool_result`.
- The id is runtime metadata, though. No engine contract puts it in front of the model as something to copy.

**What the model can name** is the tool it called and the arguments it passed. v1 shape (ADR-053 D5; the owner accepted it as O2):

```ts
snapshotRef: { server: string; tool: string; input: Record<string, unknown>; pointer?: string }
```

The Host resolves it inside the same task:

1. Take the task's `tool_use` events whose `mcp` is `{server, tool}` (`agent-event.ts:79-89`) and whose `input` deep-equals `input`.
2. There must be exactly one such event. Zero is `snapshot_ref_unresolved`; more than one is `snapshot_ref_ambiguous`.
3. Pair it with its `tool_result` by `toolCallId`. A missing id, an `isError` result or a spilled output is `snapshot_ref_unavailable`. On an engine whose events lacked the id, finance widgets would fail closed this way. Base widgets have no `snapshotRef` and are unaffected.
4. Parse the output as JSON. Take the value at `pointer` (RFC 6901, root by default) and validate it against the component's snapshot schema. Any failure is `snapshot_invalid`.

Only host toolset (MCP) results qualify, so figures come only from Host-declared data tools, never from a native tool such as a shell command.

**The record.** The SDK already keeps each task's events. `server.tasks.activity(taskId)` returns the retained activity tail (`packages/server/src/index.ts:263-269`). The Host's activity cards already read it (`src/host/activity/domain.ts:64`). Its bounds are 1000 entries and 4 MiB, kept 10 minutes after the task ends (`packages/cloud/src/activity.ts:8-10`). An event above the inline limit is replaced by a spill preview (`packages/client/src/daemon/event-spill.ts:238`). The limit defaults to 64 KiB (`event-spill.ts:15`), capped by the server's activity budget (`packages/client/src/daemon/task-runner.ts:663`). A data-tool result above it can never be a snapshot source. This is part of the data-tool contract (O4).

**Ordering.** The daemon sends progress in batches flushed every 250 ms (`packages/client/src/daemon/progress-batcher.ts:65`). The runtime may call `render_widget` before the data tool's `tool_result` reaches the server. So the Host waits on `server.tasks.events(taskId)` for the matching pair, bounded at 5 s, before it answers `snapshot_ref_unresolved`. Commits in the instance wake that feed (`packages/server/src/index.ts:275-280`).

`render_widget` runs inside the Turn that called the data tool, so the result is still retained when it resolves. The Host therefore adds no tool-result table: it resolves from that one source. It copies only the validated snapshot into the widget record, which is the authority for the widget item (Host store, one row per `widgetId` with its current `rev`). The tail expires 10 minutes after the task, and the widget must outlive it.

A reference to an earlier Turn's result would read a tail that may already be gone. v1 resolves within the calling task only (O3, accepted by the owner).

### 5.4 Size limits and error codes

The precedent is `submit_result`. A rejection is a tool *result* with `isError: true` and a bounded issue list, so the model can correct itself. A transport or authentication fault is a JSON-RPC error (`packages/client/src/bin/agent-result-mcp-server.ts:39-67`). Its outcome ceiling is 64 KiB (`docs/spec.md:4262`). ADR-053 D6 fixes the values, codes and issue format.

## 6. Spec v1 (question 6), pending the artifact export

The export was not present. The following is taken from `handoff.md` verbatim and is not new design:

- **Model arguments**: `render_widget { component, props, snapshotRef? }`. Finance widgets pass `snapshotRef` and no figures. Section 5.3 proposes a different `snapshotRef` shape.
- **Host item**: `{ kind: "widget", id: "w<id>", rev, component, props, snapshot, state, notice?, source?: { label, asOf } }`. A newer `rev` with the same `id` replaces the item in place.
- **States**: `loading`, `ready`, `partial` ("showing N of M"), `empty`, `unavailable`, `degraded`, `failed` (falls back to a plain data table when possible), `upgrade_required` (unknown component or newer spec version).
- **`specVersion: 1`** on the spec.
- **Catalogs**: the component names listed in #2552. Finance snapshot shapes for `statement_chart`, `price_chart`, `price_trend`, `relative_trend`, `financial_trend` and `shareholding` are given in `handoff.md`.
- **Shared shell**: header, meta strip, body, notice, audit footer, and Expand with Chart and Data tabs, where the Data tab is always a real table.

The per-component TypeScript types, the golden fixtures and the open-question list come from the export. They are not reproduced or guessed here. ADR-053 D7 keeps them as a pending section.

## 7. Security (question 7)

| Threat | Where it could enter | What stops it |
|---|---|---|
| Secret input | A `form` field | The field type enum is `text \| number \| select \| toggle \| date` (`handoff.md`, Catalog). The schema has no `masked`, `password` or `secret` member and no free-form field type. The validator rejects unknown members. nsh-app's `ui/Input` `masked` variant stays reachable only from the keys screens (ADR-052 D2, Plan A). The widget catalog never passes it. |
| Non-allowlisted link | A link prop, or a link inside `text` markdown | Links render through `MarkdownView`, which sets `links="report"` (`nsh-app/src/ui/MarkdownView.tsx:29`), and through `LinkText`. A press goes to `openAllowedExternalUrl`, which allows only `https:` URLs whose origin is in `brand.externalOrigins` (`nsh-app/src/links.ts:10-38`). The list is empty by default (`brand.config.ts:16`). `nsh.json` grants `openUrl` for `https` only (`nsh-app/nsh.json:9-11`). The spec adds no other way to open a URL. |
| Script | Any string | QuickJS evaluates nothing from data. The catalog is fixed code that switches on `component` (#2552). The spec has no expression, template or code member. |
| Markup and images | `text` markdown, or any image-like prop | `TextView` reads raw HTML and images by default: `html: true` and `images: true` (`nsh:website/elements/text-view.md:648`, `:651`). Markdown images become `Inline::Image` with the model's `src` (`nsh:crates/nsh-base/src/text_view/markdown/mod.rs:930-935`). A `data:image/svg+xml` source is not capability-gated (`nsh:crates/nsh-core/src/access.rs:2233-2238`) and would be rasterized by resvg inside the process that holds spawn and custody. So the spec has no image member. The catalog's `text` renderer passes `options={{ html: false, images: false }}`, which shows HTML as text and images as their alt text. The Host does not parse markdown. A second markdown parser would be a shadow parser. |
| Colours, fonts and styles | Any prop | The spec carries only `variant` (`default \| muted \| positive \| negative \| warning`), `size` and a layout hint (`handoff.md`, Hard rules). Literals are rejected by the schema. |

Pre-existing, not changed here: the conversation `MarkdownView` renders Bot replies with `TextView`'s default `html` and `images` (`nsh-app/src/ui/MarkdownView.tsx:24-39`). A reply can carry a `data:` image today. ADR-052 D2 accepted the parser attack surface. Whether replies should also turn the two options off is a separate decision for the NSH UI owner.

## 8. Order against the #2462 Electron cutover

The cutover PR deletes `src/main/**`, `src/preload/**` and `src/renderer/**`. It waits for four conditions: #2458 PASS, #2461 S6 evidence, three-OS Mixed release CI and #2479 closed. Until then no desktop release artifact is produced (#2462 body, "Cutover PR"). CI packages Electron only as a smoke test with a throwaway certificate, and it uploads nothing (`.github/workflows/ci.yml:2454-2469`). The widget children do not need to wait for it.

- **#2554 touches Electron.** The Electron `Row` switches on `item.kind` with no default (`src/renderer/conversation/transcript.tsx:38-55`) and imports the Host union directly (`:2`). The root tsconfig is `strict` without `noImplicitReturns` (`tsconfig.json:9`), so a new `widget` kind compiles and renders *nothing*. That is a silent drop, which #2552 forbids. #2554 adds one `case 'widget'` that renders the explicit unsupported text, the same meaning as the NSH `upgrade_required` card. The cutover deletes it with the rest of `src/renderer/**`.
- **#2557 needs no stub**, but it migrates one Electron call. Deleting `k8.answer` breaks the Electron `QuestionCard`, which calls it (`transcript.tsx:19`). #2557 changes that call to `k8.act` in the same PR. Electron never sends a widget action, because it shows no widget controls.
- The merge order from the plan (2553, 2554, 2557, 2555, 2556) holds. A cutover that lands before #2554 or #2557 only removes their Electron lines.

## 9. Owner questions and decisions

The owner decided O1–O4 on 2026-11-27 ([decision record](https://github.com/Ancienttwo/byok-sdk/issues/2553#issuecomment-7219557886)).

1. **O1, task binding (decided: path A).** `@byok-sdk/server` gets an explicit switch that declares `host-mcp-task-context` and verifies task assertions with the existing cloud verifier. The widget toolset child proves its task to the Host over loopback. The slice is [#2559](https://github.com/Ancienttwo/byok-sdk/issues/2559), which blocks #2554.
2. **O2, `snapshotRef` shape (accepted).** `{server, tool, input, pointer?}` replaces the mock's `{turnId, toolCallId}` (section 5.3).
3. **O3, cross-Turn references (accepted).** v1 resolves a `snapshotRef` only inside the calling task.
4. **O4, data-tool output contract (decided).** The downstream finance data tools will be adapted to return snapshot-shaped JSON under the 64 KiB inline limit. The Host copies and never maps.
5. **O5 (open), updating a widget in place.** `handoff.md` has the Host stamp `rev` but names no model argument that targets an existing widget. ADR-053 proposes `replaces: <widgetId>`, to be checked against the export.
6. **Q6 (open)** stays open until the artifact export lands in `_ops/widget-mock/artifact/`.
