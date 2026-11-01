# ADR-041: K8b Cross-Bot: Bot↔Bot delegation in Bot mode

> **Origin**: PR [#542](https://github.com/Ancienttwo/byok-sdk/pull/542), issue [#540](https://github.com/Ancienttwo/byok-sdk/issues/540); X5/X6 in PR [#578](https://github.com/Ancienttwo/byok-sdk/pull/578) and PR [#579](https://github.com/Ancienttwo/byok-sdk/pull/579). The decisions are §13 Q1–Q12 and §13.1. The other sections are their context.
> **Moved**: #1291 moved this file here from the retired plans directory (`2026-10-19-k8b-cross-bot.md`, title "K8b Cross-Bot: Bot↔Bot delegation in Bot mode (plan)"). The text is unchanged, except links to moved or removed files, which now point to the new path or to the PR that merged the removed file.

Issue: [#540](https://github.com/Ancienttwo/byok-sdk/issues/540).
Execution note (2026-10-20): X1–X4 and X2M are in the X5 base.
Draft [#578](https://github.com/Ancienttwo/byok-sdk/pull/578) adds X5 and the
X6 example/Host documentation. Draft
[#579](https://github.com/Ancienttwo/byok-sdk/pull/579) aligns the PRD text.
See the [acceptance record](../../examples/bot-collaboration/VALIDATION.md) for
terminal checks and open hosted/relay rows. The original plan follows.

Status at plan approval: docs only. Aimpact decided Q1–Q11 as
recommended on 2026-10-19 14:59 HKT (§13). A Codex read-only review
(`_ops/bot-wo/REV-K8B-cross-bot-plan-codex.md`: 7 P1, 4 P2, no P0) found
gaps. This revision fixes the technical findings. Aimpact reopened and
decided Q7, Q8 and Q10 on 2026-10-19 ~15:07 HKT (§13.1). §13.2 lists each
finding and its state. Aimpact set the `cancel_delegation` item cap and
approved this plan on 2026-10-19 16:01 HKT (§13, Q12).
Implementation waits for the dependencies in §11.
Baseline: `origin/main@5b988a6e`. In-flight inputs: #532
(`codex/bot-k4-host-execution-core@260570ae`; the first draft read
`e5afad26`), #530 (`codex/k8a-bot-collaboration@c9dabb9e`), #531
(`codex/k8b-group-chat@23132486`), #524 (`docs/bot-mode-prd-v3@312df43a`).
Authority: [docs/spec.md](../spec.md) is product truth. The platform PRD
([2026-10-13_bot-platform-prd.md](../researches/2026-10-13_bot-platform-prd.md),
"platform PRD") and the Bot-mode product PRD v3 (#524, "product PRD") define
the contract. This plan refines that contract. It does not edit either PRD.
Section numbers below use the v3 text on #524 unless marked "main".

## 1. Summary

Cross-Bot lets one persistent Bot (A) hand a request to another Bot (B) in the
same team. B runs one fresh execution in its own canonical conversation. B's
accepted reply comes back to A as a new Turn, and A continues. This is the
platform PRD §9.4 delegation, restricted to `to != self`. K8a (#530) ships only
the `to == self` case (continuation).

The flow is the platform PRD §6 「委派」 diagram without change:

```text
A execution ── messageEgress: short ack ("I asked B")
            └─ submit_result: { delegate: [{ to: "<B botId>", request }] }
                 │ A device terminal (task.complete + document)
                 ▼
Host tx (applyOutcome, once per A.taskId):
  delegation row  id = H(A.taskId, 'delegate', index)
  checks: target active, hop ≤ 4, root budget (prepaid reply), not a room seat
  B Turn source=bot_request  →  K4 enqueue(key = Turn id, source 'bot')
                 │ B FIFO head, one writer per home
                 ▼
executions.submit (frozen input, taskId = H(intentKey, generation))
                 │ B device terminal + accepted messageEgress reply
                 ▼
Host tx: settle B Turn → verdict → A Turn source=bot_reply → K4 enqueue for A
```

### 1.1 What the PRD already fixes, and what this plan adds

Already fixed (platform PRD §6, §9.3, §9.4, §9.6; product PRD §5.2; spec
"Bot turn outcome fragments and routine time points", `docs/spec.md:397`):

- The `delegate` action: `to` is a Host-filled enum, `request` is at most
  1 000 code points, at most 2 items per outcome
  (`BOT_TURN_OUTCOME_LIMITS.delegateMaxItems`,
  `delegateRequestMaxLength`, `packages/protocol/src/bot-turn-outcome.ts:9-11`).
  The fragment is `botTurnOutcomeFragments.delegate({ to })`
  (`bot-turn-outcome.ts:107-108`). These limits are frozen public API since
  #525 (Aimpact, 2026-10-19).
- Delegation key `H(A.taskId, 'delegate', index)`, hop limit 4, per-root Bot
  budget 12, `bot_request` and `bot_reply` Turn sources, reply Turn key
  `H(delegationId)`.
- Verdicts `answered`, `failed`, `cancelled`, `refused`, `expired`,
  `abandoned`, and the open state "uncertain" with no verdict.
- Async delegation. A's execution ends when it hands off. A does not wait.
- Fixed apply order in one transaction: management actions → routine
  actions → `confirmable_action` → `ask_user` → `delegate` (product PRD §5.2
  and platform PRD §9.3, both on #524). #531 does not follow this order yet
  (§3.1).

This plan adds the parts the PRD leaves open:

1. Addressing rules: which ids go into the `to` enum, and when (§2).
2. Exact reply capture: how the Host gets B's accepted reply body (§3.3).
3. A fan-in join for the PM pattern: one A execution per fan-out (§3.5, Q2).
4. Budget accounting that never strands a reply: the worst case, late reports
   included, is prepaid when the delegation is accepted, and unused units are
   released (§6.2, Q10).
5. A durable authority field: work that another Bot requests never gets
   management actions, also through continuations and nested replies (§6.1,
   Q5).
6. A verdict mapping from K4 conclusions (§8.1).
7. A delegation stays open across B's own continuations, along created
   successor Turns only (§3.6).
8. A reply reconcile state of its own in the example (§3.3, §3.10).
9. One delivery of every verdict to A, separate from starting A's model
   (§8.2).
10. Projection events with a revision per status change (§7, §9).
11. An instruction size bound that is proven after encoding (§3.7, Q8).
12. Main Bot cancel through a new `cancel_delegation` outcome fragment
    (§8.8, Q7). This is the only SDK change in K8b (slice XS).

### 1.2 "Message" versus "delegate"

Decision: there is one action, `delegate`. A plain Bot↔Bot message is a
delegation. B always runs, and B's accepted reply always returns to A.

Reasons:

- A separate `message` kind needs a new fragment in `@byok-sdk/protocol`. That
  changes `BotTurnOutcomeKind` and the api-surface golden. K8 rules say SDK gaps
  get their own issue (platform PRD §13.1, K8 row).
- A fire-and-forget message still makes B run. B's reply then has no place to
  go, or it goes to A and A runs anyway. Both break I8: each delegation has one
  verdict, and the Host reports it to the initiator.
- If B only needs to acknowledge, B replies with one short line. The A turn
  that follows can return `{}` and say nothing new.

See Q1.

### 1.3 The PM pattern

Aimpact asked for a flow where one Bot acts as a PM between Bots. It addresses
other Bots, hands each a request, and gets the answers back into its own
conversation. This plan maps that flow onto the PRD primitives. It does not
copy Grok Bot code and makes no claim about Grok Bot internals.

| PM step | Bot-mode primitive |
|---|---|
| User asks the PM Bot for something | `user` Turn in the PM's canonical conversation |
| PM tells the user what it will do | PM `messageEgress` reply (the ack) |
| PM hands parts to other Bots | `delegate` items in the PM outcome, one per target, at most 2 |
| Other Bots work | One `bot_request` Turn and one fresh execution per target, in each target's FIFO |
| PM collects answers | One `bot_reply` Turn on the PM that carries all verdicts from that fan-out (join, §3.5) |
| PM answers the user | PM `messageEgress` reply on the `bot_reply` execution |
| PM needs a second round | A new `delegate` from the `bot_reply` execution. Hop and budget bound the rounds |

Any Bot can be the PM. A Main Bot is a natural PM, but delegation needs no
Main Bot privilege (platform PRD §9.3: `delegate` is for all Bots).

## 2. Addressability

### 2.1 Identity

- The address is the Host `botId`. In the reference Host, `BotProfile.id` is
  also the `agentId` of the Bot's `AgentRef`
  (`examples/bot-collaboration/src/team.ts:37` on #531).
- The `to` enum holds `botId` values only. Display names never enter the
  schema. Names can change and can collide.
- The ContextPack roster maps names to ids. #531 already sends
  `roster: [{ id, name, role, mainBot }]` for active Bots
  (`examples/bot-collaboration/src/schema.ts:58` on #531). The model reads the
  roster and picks an id from the enum.
- At apply time the Host resolves `botId` to the current `AgentRef`
  (`agentId`, `profileRevision`) and that Bot's `deviceId`. The frozen B input
  keeps that revision. A later profile change applies to the next B execution
  (platform PRD §14.2, row "Main Bot changes B's profile").

### 2.2 Enum contents

For a 1:1 (non-room) Turn of Bot X, the Host builds
`delegate({ to: [X, ...others] })`:

- `X` comes first. `to == X` is a continuation (K8a; fragment doc comment on
  `bot-turn-outcome.ts:106`).
- `others` is every active, non-archived Bot in X's team, except X, whose
  persona was applied at least once (`readyRevision` is set on #531), in
  roster order. A target with a newer pending profile stays in the enum. Its
  Turn waits without a K4 intent until the persona is ready
  (`host.ts:262-264` on #531). §8.8 covers cancel in that state.
- Room-seat Turns get no `delegate` fragment (§5).
- A team has at most 24 active Bots (`team.ts:31` on #531). The enum then has
  at most 24 ids. The Host still runs `composeBotTurnOutcomeSchema`. On
  `schema-over-budget` it does not cut the enum without notice (product PRD
  §5.2). It blocks the Turn with a visible reason. Slice X1 measures the bound
  with 24 ids.

### 2.3 Scope and visibility

- Same team only. One reference ledger holds one team and one owner
  (`examples/bot-collaboration/README.md:97-99` on #531). Cross-team and
  cross-owner delegation are out of scope.
- A Main Bot sees the same roster as other Bots. It has no extra address scope.
- No per-Bot allowlist in v1. Every active team Bot can address every other
  active team Bot (Q4).

### 2.4 Archived and deleted targets

- Archived Bots leave the enum on the next schema build.
- An offer frozen before the archive can still name the archived Bot. At apply
  time the Host rechecks (platform PRD §9.2 item 7). The delegation gets the
  verdict `refused` (reason `target_archived`). No B Turn is created.
- Archive after acceptance is in §8.4.

## 3. Delivery

### 3.1 Apply transaction (A's terminal)

K4 calls `applyOutcome(document, tx)` inside the ledger transaction, once per
`taskId` (`examples/host-execution-core/src/core.ts:340-358` on #532).
#531 applies management first (`examples/bot-collaboration/src/host.ts:93`),
then `delegate` (`:99`), `ask_user` (`:109`), `confirmable_action` (`:116`)
and the routine actions (`:122`). X1 first changes this to the fixed order
of §1.1, so `delegate` runs last. Cross-Bot then replaces the
`Target is not this Bot` refusal with this branch, per item `i`:

1. `delegationId = H(A.taskId, 'delegate', i)`. If the row exists, stop. This
   makes a re-applied terminal a no-op.
2. `to == A`: keep the K8a continuation path, with three changes. The new
   Turn inherits the origin hop (§6.2), the origin authority (§6.1) and the
   origin `delegationId` (§3.6). #530 and #531 now write `hop: 0` in
   `addTurn` (`host.ts:67` on #530, `host.ts:70` on #531). X1 makes `addTurn`
   take the hop and the authority as inputs.
3. Duplicate `to` in the same outcome: refuse the second item
   (`duplicate_target`). #531 already does this.
4. Target check: active, not archived, same team. Otherwise `refused`.
5. Hop: `hop = A.turn.hop + 1`. If `hop > 4`, `refused` (`hop_limit`).
6. Fan-out: until X3 ships the join, X1 accepts one cross-Bot item per
   outcome. A second cross-Bot item gets `refused` (`fan_out_not_enabled`).
7. Budget: reserve the worst case from `budgets[root]` (§3.5, §6.2). If the
   reserve fails, `refused` (`budget_exhausted`).
8. Insert the delegation row (§4.1) and the B Turn:
   `id = delegationId`, `botId = B`, `source = 'bot_request'`,
   `authority = 'bot'`, `root = A.turn.root`, `hop`, `delegationId`, and
   `request` = the action's `request` text.
9. Publish the projection event `delegation:<delegationId>:<revision>` with
   status `queued` (§7).

A refusal is a verdict. It is written into the delegation row and a projection
event. A receives it exactly once (§8.2).

### 3.2 B's Turn to B's execution

The existing `sync` loop turns a Turn without an intent into a K4 intent
(`host.ts:280-291` on #531). Cross-Bot reuses it with three changes:

- `source` maps to K4 `IntentInput.source = 'bot'`
  (`examples/host-execution-core/src/model.ts:13` on #532). No K4 change.
- B's ContextPack is B's own context: B's recent turns (truncated per §3.7),
  roster, team notes, B's rejected actions, and one `delegation` block:
  `{ delegationId, from: { botId, name }, hop, request }`. A's history never
  enters B's ContextPack.
- B's frozen input sets `messageEgress.maxBytes` to `BOT_REPLY_MAX_BYTES`
  (8 192, Q8). The Host owns this offer field. `consumeMessage` also refuses
  a body over 8 192 UTF-8 bytes, so the bound in §3.7 does not depend on how
  the SDK counts. The `agentMessageContext.destinationBinding` is B's
  conversation id. `freshnessCursor` is B's Turn id (platform PRD §9.1).

`executions.submit` is called by K4 `core.submit` with the persisted input
(`core.ts:248-261` on #532). A crash between the ledger write and the submit
recovers by `tasks.offer` readback and the same input. This is the §14.2 row
"Host crashes after the delegation write and before submit".

### 3.3 B's reply capture

`answered` needs B's accepted reply (platform PRD §9.4 item 4). The reference
Host does not store reply bodies today. Its tests accept every message
(`examples/bot-collaboration/src/team.test-support.ts:21` on #531). X1 adds:

- `BotCollaboration.consumeMessage(message)`. The Host wires it as the
  server's `agentMessage` consumer (`createByokServer({ agentMessage })`,
  `packages/server/src/index.ts:364`). In one ledger transaction it checks the
  exact binding (taskId, AgentRef, `destinationBinding`, I9), runs first
  acceptance versus cancel arbitration (conversation PRD §5), and stores the
  accepted body by `taskId`.
- The Host acceptance record from `consumeMessage` is the body authority.
  SDK readback is transport evidence only
  (`packages/cloud/src/task-agent-message.ts:10`).
- The example's server port type adds `tasks.agentMessage`. The #532
  `ExecutionServer` type does not include it yet (`core.ts:11` on #532).
- At B's success terminal, K4 settles the intent and removes its outbox row
  (`core.ts:348-350`, `transitions.ts:26` on #532). K4 then arms no scan for
  it (`core.ts:216-220`). So the example does not wait for a K4 scan. It
  sets `delegation.status = 'reply_pending'` in the same transaction and
  reconciles on its own (§3.10).
- Reconcile rule for a `reply_pending` delegation:
  - A Host acceptance record exists for B's `taskId`: verdict `answered`.
    This also holds when the SDK disposition is not committed yet.
  - No Host record: read `server.tasks.agentMessage(taskId, deviceId,
    agentRef)` (`packages/server/src/index.ts:216`; protocol "Host discovery
    of the first Agent message", `docs/protocol.md:2780`).
  - Pending: stay `reply_pending` and check again at the next retry time.
  - No message: verdict `failed` (`no_reply`).
  - Held: status `reply_held`. There is no automatic verdict. A read does not
    release held (`packages/cloud/src/inbound.ts:252`; conversation
    reliability addendum,
    `docs/researches/2026-09-09_conversation-turn-mode-host-reliability-addendum.md:129`).
    The UI shows the held state with "End". When the owner ends it, the
    verdict is `abandoned` (`reply_held`). An operator can use the existing
    held exit path from the addendum.

The Host never derives the reply from the outcome document or from model text
(I10).

### 3.4 Reply to A (single delegation)

At B's verdict, in one transaction:

- Set the delegation verdict once (compare-and-set from empty).
- Insert A's Turn: `id = H('bot_reply', delegationId)`, `botId = A`,
  `source = 'bot_reply'`, `authority` = the origin Turn's authority,
  `root = A.turn.root`, `hop = A.turn.hop` (the origin hop, not `hop + 1`),
  and the reply list
  `[{ delegationId, from, request, verdict, reason?, reply? }]`. §3.7 gives
  the encoding into A's instruction and its size bound.
- Set `delegation.replyTurnId`. This field is written once, so A receives at
  most one report per delegation.
- Skip the Turn if A is archived (§8.5).

The reply hop is the origin hop because the chain returns to A. It does not go
deeper. A PM that runs many rounds is bounded by the root budget (§6.2).

### 3.5 Fan-in join (PM fan-out)

One outcome can hold two cross-Bot `delegate` items. Without a join, A runs
twice and may answer the user twice. With a join, the Host enqueues one A Turn
per fan-out:

- Batch = all accepted cross-Bot delegations from one A outcome. X1 allows
  one per outcome. X3 allows two and ships the join.
- The batch reply Turn id is `H('bot_reply', A.taskId)`. The Host creates it
  when every delegation in the batch has a verdict or is uncertain, and at
  least one has a verdict.
- No empty batch. If every delegation in the batch is uncertain, the Host
  creates no batch Turn. Each delegation then reports later in its own Turn.
- The batch Turn carries every verdict in the batch, including apply-time
  refusals from the same outcome.
- A delegation that is uncertain at batch release reports later in its own
  Turn `H('bot_reply', delegationId)`.
- `delegation.replyTurnId` stays the one-report guard. Each delegation is in
  exactly one reply Turn.
- Worst case: a batch of `n` accepted delegations makes at most `n` A reply
  Turns (one batch Turn and `n − 1` late reports, or `n` late reports). An
  outcome with no accepted item makes one refusal report Turn (§8.2). So one
  A outcome makes at most `max(n, 1)` A reply Turns.
- The budget reserve covers this worst case (Q10, §6.2):
  `reserve(n) = n + max(n, 1)` units. Root admission also counts every open
  reservation of other batches on the same root (§6.2). The first draft's `n + 1` did not cover
  a late report: with 9 units used, accepting 2 reserved 3 (total 12), and
  one late report made 13 executions.

This refines platform PRD §9.4 item 3 ("reply Turn key `H(delegationId)`").
A batch of one keeps that key. A batch of two uses the batch key. Aimpact
decided Q2 (§13). The PRD text changes in a separate follow-up docs PR, not in
this PR.

### 3.6 B's continuation keeps the delegation open

B may answer a long request with an ack and a self `delegate` (K8a long-task
rule, product PRD §5.6). The ack is then not the answer. Rule:

- A continuation Turn created from a Turn with `delegationId` inherits that
  `delegationId`, the origin hop and the origin authority.
- The chain moves only along a created successor. The apply transaction that
  inserts the continuation Turn also appends its id to
  `delegation.chainTurnIds`. A self `delegate` in the outcome is only a
  proposal until that insert commits.
- The chain ends at a Turn whose apply created no successor. That is the case
  when the outcome has no self `delegate`, or when the Host refused it: the
  continuation budget is used up, a cancel is recorded (§8.8), or a recheck
  failed.
- At the chain end, the verdict comes from that Turn. Its accepted reply gives
  `answered`. No accepted reply gives `failed` (`no_reply`). A refused
  continuation is visible: the reply entry carries `continuation_refused`, and
  the refusal is in B's `rejectedActions`.
- Continuations use the root continuation budget (4 per root, Q11 in the
  product PRD). They do not use the Bot budget, and hop does not change.
- A failed, cancelled or missing-outcome successor gives `failed` or
  `cancelled` for the delegation.

### 3.7 Context budget

The 2026-10-19 rulings apply to `bot_request` and `bot_reply` Turns the same
way as to group and 1:1 history:

- History is recent-N, truncated by the token budget, with an explicit
  truncation notice. The Host never blocks on history.
- The Host blocks only when the current request alone exceeds the budget.
- Q8 requires a size bound on the final encoded instruction, so that the
  "block only if the current request alone exceeds the budget" rule never
  blocks a Cross-Bot Turn because of encoding growth. The first draft said two
  8 KiB replies always fit the 32 KiB default (`DEFAULT_CONTEXT_MAX_BYTES`,
  `examples/bot-collaboration/src/schema.ts:33` on #530). Codex P1-4 showed
  that this is false: JSON escaping made two 8 192-byte newline replies a
  32 945-byte request and a 49 395-byte minimal ContextPack.
- Means: no second JSON string encoding. The instruction has three parts:
  the system prompt (`P` bytes), the `Request:` section, and the ContextPack
  JSON. The reply bodies and the `bot_request` text go into the `Request:`
  section once, as raw UTF-8 text in length-framed blocks
  (`--- reply <i> (<bytes> bytes) ---`). They are not put into the
  ContextPack again. The ContextPack entry for the current Turn holds
  metadata only. Each metadata line is canonical JSON, bounded at 6 bytes per
  code point (the K8-S rule, product PRD §5.2).
- Budget unit: `instructionMaxBytes`, the UTF-8 byte length of the final
  instruction string that goes into `executions.submit`.
- Current request bounds, from these caps:

  | Part | Cap | Encoded bound |
  |---|---|---|
  | Reply body | 8 192 UTF-8 bytes (Q8, checked in `consumeMessage`) | 8 192 bytes, raw |
  | Reply metadata line | two 64-hex ids, target name ≤ 40 code points, verdict, reason, flags, request excerpt ≤ 200 code points | ≤ 2 048 bytes (`REPLY_META_MAX_BYTES`, asserted when the line is built) |
  | Framing | one header and one end line | ≤ 96 bytes |
  | Entries per reply Turn | at most 2 (`delegateMaxItems`; an entry is an accepted or a refused item of one outcome) | — |
  | `bot_reply` request `R_reply` | 2 × (8 192 + 2 048 + 96) | ≤ 20 672 bytes |
  | `bot_request` request `R_req` | text ≤ 1 000 code points (≤ 4 000 UTF-8 bytes) + metadata ≤ 2 048 + framing ≤ 96 | ≤ 6 144 bytes |

- Fixed ContextPack part `F`: the roster (≤ 24 Bots; id 64 bytes, name ≤ 40
  and role ≤ 80 code points at 6 bytes each, plus keys) and the truncation
  notice. `F_max` ≤ 24 × 848 + 256 = 20 608 bytes. Every other ContextPack
  field is history or background: turns, team notes, rooms, routines, cards,
  questions and `rejectedActions`. It is truncated recent-N, oldest first,
  with an explicit notice.
- Construction check: the Host computes `P` and refuses an
  `instructionMaxBytes` below `P + max(R_reply, R_req) + F_max`. The
  reference default is 65 536 bytes, the same as the #531 ContextPack cap
  (`ROOM_CONTEXT_BYTES`).
- Proof: instruction = `P` + request + `F` + history. The request is at most
  `max(R_reply, R_req)`, `F` is at most `F_max`, and history truncates to fit
  the rest, which is never negative. So a Cross-Bot Turn never blocks because
  of encoding. The block rule can still apply to user input, as the ruling
  says.
- Acceptance (X1): a generator builds worst-case Turns (control characters
  and quotes in every text field, maximum names, 24 Bots, two 8 192-byte
  replies, full history). Each encoded instruction is at most
  `instructionMaxBytes`, no Cross-Bot Turn blocks, and `executions.submit`
  accepts the input.
- B sees only its own conversation and the `delegation` block. This matches
  the late-join rule: a Bot never sees history it was not part of.

Cross-Bot uses the truncation that #530 and #531 must ship for these rulings.
#531 still blocks when history is full (`rooms.ts:138`, `schema.ts:65` on
#531). Cross-Bot does not start until that is fixed (§11).

### 3.8 Wakes, routines, busy targets

- Messages and callbacks never enter the wake queue (platform PRD §4, §9.2
  item 9). Cross-Bot adds no wake key family.
- K4 keeps its own wait limit and scan wake `host-scan:<hash(tenant)>:<n>`
  for open intents (`core.ts:216-235` on #532). Delegation timers do not use
  it, because K4 cancels that wake when no intent is open (`core.ts:216-220`).
  Delegation timers use the collaboration Host timer and restart scan
  (§3.10).
- A routine-triggered A Turn can delegate. Its root is the routine Turn. The
  routine occurrence settles at A's terminal, as before. The reply arrives as
  a `bot_reply` Turn, not as a routine Turn.
- B busy in its own conversation: the `bot_request` intent waits in B's FIFO.
  K4 changes generation only after a device terminal with
  `agent_home_writer_busy` or `agent_home_reader_busy`
  (`core.ts:340-358` on #532). This is the §14.2 row "B is running in its own
  conversation".
- FIFO order is plain enqueue order. Cross-Bot adds no priority policy
  (platform PRD §9.2 item 1).

### 3.9 Topology L and H, cross-device

- One reference ledger runs the K4 core for the whole team. The K4 FIFO key is
  `(tenant, deviceId, agentId)` (`transitions.ts:14` on #532). Bots on two
  devices already have separate FIFOs in one ledger.
- Same-device delegation (Topology L): one embedded server, one daemon.
- B on another device: X5 runs B on a second enrolled `deviceId` whose daemon
  has no Host code. This covers the §14.2 row "A delegates to B on another
  device (Topology H); B's device has no Host code". The embedded server must
  accept two devices for this test. Server tests already pair more than one
  device per tenant (`packages/server/src/__tests__/tenant-pairing-isolation.test.ts`),
  but X5 must prove the exact path (inferred, not run).
- The K4 reference covers device-local Topology L only
  (`docs/host-execution-core.md:312-313` on #532). A Host-service K4 adapter
  over `submitAgentExecution` is not in K8b. The real Topology H service rows
  belong to the downstream Host, as K4 rows do (product PRD Q19).
- Two device-local Host processes (Topology L on two devices) sync through
  the Host service, with one sync interval per hop at most (platform PRD §9.4
  item 7). K8b documents that relay contract only (Q11): an outbox row
  `delegation.request` keyed by `delegationId`, and an outbox row
  `delegation.verdict` keyed by `delegationId`. The receiver inserts each row
  idempotently. The delegation row's authority is the initiator's ledger. The
  B Turn's authority is the target's ledger.
- Acceptance gap. X5 proves only the two-device embedded-server path. The
  §14.2 cross-device row stays not covered for the hosted
  `submitAgentExecution` path and for two Topology L Host processes. Product
  PRD Q19 covers K4 rows only. It does not waive §14.2. The validation record
  must keep these rows open until a ruling or evidence closes them.

### 3.10 Example reconcile loop

The collaboration Host owns a reconcile loop for delegation state that K4 does
not track. #531 uses the same shape for seats and persona projections: state in
the ledger, an in-process timer, and a full scan at start.

- Persisted work items: `reply_pending` checks (§3.3), uncertain thresholds
  (§8.3), undelivered cancels (§8.8), and refusal reports not yet inserted
  (§8.2).
- Each item stores its next check time in the delegation row. At start, the
  Host scans every unresolved delegation and rebuilds the timer.
- `reply_pending` retries back off from 1 s, doubling to 60 s. #531 uses the
  same backoff for persona projections. After 30 min without convergence the
  delegation shows `uncertain` (§8.3). It gets no verdict by timeout.
- Each step runs in one ledger transaction under the Host's `exclusive()`
  chain.

## 4. Persistence

### 4.1 Delegation row

New map `CollaborationState.delegations: Record<string, Delegation>` in
`examples/bot-collaboration/src/model.ts`:

| Field | Meaning |
|---|---|
| `id` | `H(A.taskId, 'delegate', index)` |
| `root` | Root Turn id (user input, answer, or routine Turn) |
| `fromBotId`, `fromTurnId`, `fromTaskId`, `index` | Initiator identity |
| `toBotId`, `toAgentRef`, `toDeviceId` | Target, resolved at apply |
| `request` | The action text |
| `hop` | `fromTurn.hop + 1` |
| `requestTurnId` | B's Turn id (equals `id`) |
| `chainTurnIds` | B's Turn ids in this delegation, in order. Appended only when a successor Turn is inserted (§3.6) |
| `batch` | `fromTaskId` (join group, §3.5) |
| `status` | `queued` · `waiting_device` · `running` · `reply_pending` · `reply_held` · `uncertain` · `resolved` |
| `revision` | Counter for projection events. It increases on each status or verdict change (§7) |
| `cancel` | `{ requestedAt, targetTurnId, delivered }`, frozen in the arbitration transaction (§8.8) |
| `nextCheckAt` | Next reconcile time (§3.10) |
| `verdict` | `answered` · `failed` · `cancelled` · `refused` · `expired` · `abandoned`; set once |
| `reason` | Code: `target_archived`, `hop_limit`, `budget_exhausted`, `duplicate_target`, `no_reply`, `busy`, `user_cancelled`, `claim_raced_deadline`, `initiator_archived`, `room_seat`, `fan_out_not_enabled`, `continuation_refused`, `reply_held` |
| `reply` | Accepted reply body reference (B's `taskId`) when `answered` or `cancelled` after acceptance |
| `replyTurnId` | A's reply Turn id; set once |
| `uncertainSince`, `resolvedAt` | Timers and audit |

### 4.2 Turn changes

- `Turn.source` adds `'bot_request' | 'bot_reply'` to the #531 union
  (`model.ts:5-9` on #531).
- `Turn.delegationId?` on `bot_request` Turns and their continuations.
- `Turn.authority: 'owner' | 'bot'`, set at insert and never changed (§6.1).
- `addTurn` takes `hop` and `authority` as inputs. It no longer writes
  `hop: 0` (`host.ts:67` on #530, `host.ts:70` on #531).
- `bot_reply` Turns keep the reply list as Turn data, not as a JSON string in
  `request`. The instruction encoding is in §3.7.
- `budgets[root]` keeps `{ continuation, delegation }`. Cross-Bot starts to
  use `delegation`, which #530 and #531 never increment (`model.ts:36` on
  #530).

### 4.3 Accepted replies and audit

- `replies: Record<taskId, { body, contentType, acceptedAt }>` holds accepted
  bodies written by `consumeMessage`.
- A terminal or message that arrives after the verdict goes to
  `state.audit` with the delegation id and the task id. It goes into B's
  conversation as an audit note only. It is never forwarded to A (platform
  PRD §9.4 item 5).

## 5. Group versus 1:1

- Cross-Bot delegation starts only from 1:1 Turns: `user`, `answer`,
  `action_result`, `routine`, `continuation`, `bot_request`, `bot_reply`.
- Room-seat Turns (`room_slot`) get no `delegate` fragment. #531 already
  builds room seats with `speech` and `room_call` only, and its room prompt
  says the seat "cannot ... request a continuation" (`schema.ts` on #531).
  Cross-Bot keeps this.
- Bot-to-Bot addressing inside a room stays `room_call`: public, in-room,
  inside the round budget (platform PRD §9.5).
- A room member cannot delegate privately from a room seat in v1 (Q6). A
  private hand-off would take room content into B's 1:1 conversation, and the
  reply would land in the member's 1:1 conversation, not in the room. The user
  then sees an answer in a place that does not match the question.
- An offer frozen with an older schema can still carry `delegate` on a room
  seat. Apply rejects it (`room_seat`), as #531 rejects management on seats
  (`host.ts:93-97` on #531).
- Non-@ room messages stay background only. They never create a
  `bot_request`.
- Room membership does not limit 1:1 delegation. Any active team Bot is a
  target.

## 6. Auth, ACL and limits

### 6.1 Who may message whom

- Schema gate: the `to` enum (§2.2). The model cannot name a Bot outside the
  team.
- Apply gate: the Host rechecks target state and team at apply time.
- Authority gate (Q5). A check on `source === 'bot_request'` is not enough.
  B can continue itself, and the continuation has source `continuation`. In
  #531 every non-room Main Bot Turn gets management fragments
  (`schema.ts:44`), and apply checks only the role (`host.ts:93`,
  `team.ts:70`). So each Turn stores a durable `authority`:
  - `owner` for `user` and `answer` Turns.
  - `bot` for `bot_request` Turns.
  - A continuation inherits the authority of the Turn that created it.
  - A `bot_reply` Turn inherits the authority of its origin Turn.
  - An `action_result` Turn inherits the authority of the Turn that created
    the card.
  - A routine records the authority of the Turn that created it. Its routine
    Turns inherit that value.
- Management fragments and `create_routine.target` are offered only when the
  Bot is a Main Bot and `authority = owner`. Apply checks the same stored
  field, so an offer frozen before a change cannot bypass it.
- Another Bot's request text therefore never drives `create_bot`,
  `delete_bot`, `update_room` or `create_routine.target`, at any depth. The
  Main Bot keeps management on its owner-rooted Turns, including the
  `bot_reply` Turns of its own fan-out.
- `confirmable_action` and `ask_user` stay available on `bot_request` Turns.
  Cards and questions appear in B's conversation, and the owner decides (A1).
  The delegation verdict still comes from B's terminal.
- No user opt-in per pair and no per-Bot allowlist in v1 (Q4). One owner owns
  every Bot in the ledger.

### 6.2 Budgets and loop prevention

- Every Bot-triggered Turn has a root: a user input, an answer, or a routine
  Turn. Every limit counts per root. No chain exists without a root.
- Hop: `bot_request.hop = origin hop + 1`, at most 4. A continuation keeps the
  hop of the Turn that created it, through `addTurn` (§4.2). A `bot_reply`
  Turn has the origin hop. So a Bot at hop 4 that continues itself and then
  delegates out gets `refused` (`hop_limit`, hop 5).
- Root Bot budget, default 12 executions (platform PRD §9.4). Cross-Bot counts
  each B execution and each A reply execution. Generations of the same intent
  do not count.
- Prepaid worst case (Q10). When an A outcome is applied, `n` is the number
  of accepted cross-Bot items (0, 1 or 2). The batch needs
  `reserve(n) = n + max(n, 1)` units: `n` B units and `max(n, 1)` A reply
  slots. The A slots cover late reports after an uncertain sibling and the
  refusal report when `n = 0`.
- Units. Each unit has a stable id and moves once from `reserved` to `spent`
  or to `released`. B unit: `H(delegationId, 'B')`. A slot:
  `H(batch, 'A', k)` for `k < max(n, 1)`. `budgets[root]` keeps
  `spent` and `reserved` counts. Each change to them runs in the same ledger
  transaction as the unit change. A replayed event finds the unit already
  moved and changes nothing.
- Root admission. The check counts every open reservation on the root, from
  every batch: `spent[root] + reserved[root] + reserve(n) ≤ 12`. If it fails,
  the Host refuses accepted items from the last index (`budget_exhausted`)
  and checks again. Those refusals ride in the reply Turn of the same
  outcome. The first draft checked only `used + reserve(n)`. Two interleaved
  batches could then commit 13 units (Codex round 2).
- Invariant. `spent[root] + reserved[root] ≤ 12` at all times. Admission is
  the only step that adds units. A claim moves one unit from `reserved` to
  `spent`, so the sum does not change. A release lowers the sum.
- Claim rule. Every B execution and every A reply execution holds exactly one
  unit before K4 submits it. The first transaction that sees the intent
  claimed (K4 `started`) spends that unit. Later generations of the same
  intent reuse the spent unit. Continuations use the continuation budget, not
  units. User input Turns use no units.
- Release timing:
  - B unit: released when the delegation gets a verdict and its first B Turn
    was never claimed: refused after acceptance, cancelled before a claim, or
    expired without a claim.
  - A slot: a reply Turn takes one free slot when the Host inserts it. A
    batch always keeps free slots for each of its delegations that is not yet
    reported. After each report, the Host releases free slots above that
    count. So a join that reports both delegations in one Turn releases one
    slot, and a batch with an uncertain item keeps its slot for the late
    report.
  - A taken slot whose reply Turn ends without a claim is released.
  - Initiator archived: the Host releases every free A slot of A's batches.
- Refusal report rule. At `n = 0` the reserve is one A slot, from the same
  free balance `12 − spent[root] − reserved[root]`. If the balance is 0, the
  refusal report Turn is delivery only: it is recorded in A's conversation,
  it does not start A's model, and it enters A's next ContextPack (§8.2).
- Examples with no other open reservation: spent 8, fan-out 2 → reserve 4 →
  12; with a late report the A Turns are 2, as reserved. Spent 9, fan-out 2
  → 13 → refuse index 1 → reserve 2 → 11. Spent 11, fan-out 1 → 13 → refuse
  → refusal report slot → 12. Free balance 0 → refusal report is delivery
  only.
- Interleaved example (Codex round 2): spent 5, old fan-out 2 reserves 4
  (committed 9). Both old targets are claimed (spent 7, reserved 2). One old
  target answers and one is uncertain. A's batch reply is claimed (spent 8,
  reserved 1 for the late report). A fans out 2 again: `8 + 1 + 4 = 13`, so
  index 1 is refused and `8 + 1 + 2 = 11` is accepted. The committed total
  never exceeds 11, and the old late report still starts.
- Continuation budget, 4 per root, is separate (product PRD Q11).
- A↔B ping-pong is bounded by the budget. A→B→A is allowed, because a Bot can
  ask back, and it counts hop.
- Rate limits: the root budget is the rate limit for Bot-triggered work.
  The K4 single writer per home (I11) bounds concurrency. Cross-Bot adds no
  time-window limit.

## 7. Idempotency

| Fact | Key | Duplicate behavior |
|---|---|---|
| Delegation row | `H(A.taskId, 'delegate', index)` | Second apply of A's terminal finds the row and does nothing. K4 also applies once per `taskId` (`state.applied`) |
| B request Turn | `delegationId` | `turns[id] ??=` keeps the first Turn |
| B intent | `intentKey = Turn id`; `taskId = H(intentKey, generation)` | K4 `enqueue` is idempotent by canonical equality; a different payload throws (`transitions.ts:4-20` on #532) |
| B submit | frozen input | Crash or lost response: `tasks.offer` readback, same input, no second B execution |
| Accepted reply | B `taskId` with exact binding | Same body returns the stored result. A different body or a stale generation is refused |
| Verdict | compare-and-set on `delegation.verdict` | A replayed terminal or message after the verdict goes to audit |
| Reply Turn | `H('bot_reply', delegationId)` or batch `H('bot_reply', A.taskId)` | `replyTurnId` is set once; at most one report per delegation |
| Projection event | `delegation:<id>:<revision>` | K4 `project()` has no upsert. A different value under a pending id throws `Projection identity conflict` (`model.ts:92-96` on #532). So each status change is a new event with the next `revision`. `card:<id>:<state>` on #530 uses the same idea. The receiver dedups by the full event id and keeps the highest revision per delegation id |

Retries come only from K4 rules: busy decline after a terminal, or a failure
the retry policy allows (`DEFAULT_RETRY`, `model.ts:10` on #532). The Host
never resubmits a delegation on its own.

## 8. Failure modes

### 8.1 K4 conclusion to verdict

| B side evidence | Verdict | Reason |
|---|---|---|
| `succeeded` and the accepted reply is read back | `answered` | — |
| `succeeded`, no message | `failed` | `no_reply` |
| `succeeded`, message pending | none yet | `reply_pending`; the example reconcile loop retries (§3.3, §3.10) |
| `succeeded`, message held | none yet | `reply_held`; the owner can end it → `abandoned` (§3.3) |
| `failed`, or no `submit_result` (K7 `task.fail`) | `failed` | B's actions are not applied |
| `declined` after K4 retries | `failed` | `busy` or decline code |
| `expired` (cancelled, no claim at deadline) | `expired` | — |
| `cancelled` with Host cancel reason `expired` (claim raced the deadline; WO-05 ruling) | `expired` | `claim_raced_deadline` |
| `cancelled` after a user cancel | `cancelled` | `user_cancelled` |
| Target archived after acceptance | `refused` | `target_archived` (§8.4) |

Execution settlement (SDK evidence) and the verdict (Host) stay separate
records (I8).

### 8.2 Refusal at apply time

The platform PRD requires that A receives each verdict once (I8; §14.2 row
"hop limit → `refused`, A receives it once"). A future ContextPack alone does
not meet that: if no user input follows, A never reads it. The plan therefore
separates delivery from model start.

- Delivery. Every verdict, including an apply-time refusal, is delivered once
  as an entry in a `bot_reply` Turn. `delegation.replyTurnId` is set once.
  Refusals with accepted siblings go into that outcome's reply Turn: the
  single reply Turn in X1, the batch Turn in X3.
- If no item of an outcome was accepted, the Host inserts one refusal report
  Turn `H('bot_reply', A.taskId)` with all refusals of that outcome. Delivery
  never waits for budget.
- Model start. A refusal report Turn starts A's model at most once per A
  outcome. Its schema has no `delegate` fragment, so it cannot make a new
  refusal. This bounds the loop: each refusal report comes from one earlier A
  execution and cannot make another report.
- Budget (Q10): the refusal report Turn uses one prepaid unit when it starts.
  If no unit is free, it is delivery only. It stays as a delivered record in
  A's conversation and enters A's next ContextPack (§6.2).
- Refusals also stay in `rejectedActions`, which #531 filters per Bot.

This meets the §14.2 rows "hop limit → `refused`, A receives it once" and
"over budget → later delegations `refused`, reason shown".

### 8.3 Uncertain and abandoned

- Uncertain when either: a cancel was requested and no terminal arrived in
  `cancelGraceMs` (default 60 s), or B's attempt is claimed and no terminal
  arrived in `uncertainAfterMs` (default 30 min) (Q9).
- Both conversations show "uncertain". The Host does not resubmit. No new
  generation.
- A batch releases without the uncertain item (§3.5).
- A later terminal gives the normal verdict and its own reply Turn.
- The user can end it: `abandonDelegation(id)` sets `abandoned`. It also
  writes a K4 cancel if the attempt can still run. A terminal that arrives
  later goes to audit only.

### 8.4 Target archived (`delete_bot`) after acceptance

| B state | Host action | Verdict |
|---|---|---|
| Turn queued, intent not submitted | The K4 intent gets `cancelReason = 'cancelled'` (#531 already does this for archived Bots) | `refused`, `target_archived` |
| Submitted, not claimed | `tasks.cancel`, then `tasks.attempt` readback | `refused` when the attempt reads back cancelled |
| Claimed or running | `tasks.cancel`; wait for the terminal | `refused` at the terminal; the body goes to audit only |
| No terminal | Uncertain rules (§8.3) | `abandoned` if the user ends it |

The PRD gives `refused` for delegations that point to a deleted Bot (platform
PRD §9.6 item 3). The Host does not delete B's home.

### 8.5 Initiator archived

- B's work continues, unless the owner cancels it in B's conversation.
- The verdict is still written. No reply Turn is created (platform PRD §9.4
  item 6). The projection shows `initiator_archived`.

### 8.6 Device offline

- B's device is offline before the claim: the status is `waiting_device`.
  After the wait limit (K4 `waitUntil`, 300 s in #531), K4 cancels and reads
  back. Without a claim the verdict is `expired`, and A receives one reply.
  This is the §14.2 row "B's device is offline".
- B's device drops after the claim: §8.3.
- A's device is offline when the reply Turn is ready: the reply intent waits
  in A's FIFO and follows A's own wait limit. If it expires, A's reply Turn
  shows the expiry. The delegation verdict does not change.

### 8.7 Over-budget context

Per §3.7. History never blocks. The encoded bound and the construction check
keep every `bot_request` and `bot_reply` request inside the budget, so no
Cross-Bot Turn blocks because of its size.

### 8.8 Cancellation arbitration

- The user can cancel from A's delegation chip or from B's `bot_request` Turn.
  Both call `cancelDelegation(id)`.
- One Host arbitration transaction persists the cancel fact:
  `cancel = { requestedAt, targetTurnId, delivered }`. `targetTurnId` is the
  chain Turn that is current at that moment, and it stays frozen. The same
  transaction closes first acceptance for that Turn and blocks new
  successors: a later continuation apply is refused.
- No K4 intent yet: the Turn is queued, or its target waits for persona
  readback (`host.ts:262-264` on #531). The transaction closes the Turn's
  queue eligibility, so `sync` never enqueues it, and sets the verdict
  `cancelled`. The Host does not call `core.cancel`, which throws when the
  intent is missing (`core.ts:78-84` on #532).
- K4 intent exists: the transaction sets `delivered = false`. After the
  commit, the Host calls `core.cancel(targetTurnId)` and then sets
  `delivered = true`. A crash between the two leaves `delivered = false`.
  At start, the reconcile loop (§3.10) delivers every undelivered cancel to
  its frozen target. It never selects a new current Turn.
- Cancel and B's first message acceptance meet in one Host transaction
  boundary (conversation PRD §5, "取消与首次接受"):
  - Cancel commits first: a later B message is refused. Verdict `cancelled`
    with no reply.
  - Acceptance commits first: the cancel stops only the rest of the
    execution. The verdict is `cancelled`. The reply Turn carries the accepted
    body and marks it partial.
- Main Bot cancel (Q7; platform PRD §9.4 "user or Main Bot"). The path is a
  new outcome fragment `cancel_delegation` in `@byok-sdk/protocol` (slice XS):
  items `{ delegationId }`, where `delegationId` is a Host-filled enum.
  - Only a Main Bot schema with `authority = owner` gets it, and only outside
    room seats. Apply checks the same facts (§6.1).
  - The enum lists the team's open delegations, newest first, at most 24. If
    more are open, the ContextPack says how many are not listed. The enum is
    never cut without notice (product PRD §5.2). The user can cancel the
    others in the UI.
  - Apply order: after the management actions and before the routine actions.
    The follow-up PRD docs PR adds this to the fixed order.
  - Apply runs the same arbitration transaction as `cancelDelegation`, with
    reason `main_bot_cancelled`. A delegation that is already resolved gives
    a rejected action (`already_resolved`) in the Main Bot's next
    ContextPack.
  - Item cap: at most 2 items per outcome, the same as `delegateMaxItems`
    (Q12, Aimpact 2026-10-19 16:01 HKT). The XS PR adds it to
    `BOT_TURN_OUTCOME_LIMITS` as `cancelDelegationMaxItems = 2`.
- B's staged outcome is never applied after a cancel. K7 sends no document
  with a cancelled terminal.

## 9. Host UI surface

The reference Host has no UI. It publishes projections through K4 `project()`,
like `question:<id>`, `card:<id>:<state>` and `blocked:<id>`. Cross-Bot adds
the events `delegation:<id>:<revision>` with `{ id, revision, fromBotId,
toBotId, request, status, verdict?, reason?, replyTurnId? }` (§7), and two
owner APIs: `cancelDelegation(id)` and `abandonDelegation(id)`.

A product Host renders at minimum:

| Where | What the user sees |
|---|---|
| A's conversation, after A's ack | One chip per delegation: target name, first line of the request, status. Status text: queued, waiting for device, running, uncertain, then the verdict. Refusals show the reason. |
| Chip controls | "Cancel" while queued, waiting, running or reply pending. "End" while uncertain or reply held (this sets `abandoned`). No control after a verdict. A Main Bot cancel shows "cancelled by <Main Bot name>". |
| A's conversation, reply Turn | One card per reply Turn: each target's name, verdict and accepted reply. Then A's own new message. |
| B's conversation | A "Request from A" Turn with the request text and a link to A's conversation. Then B's reply. A partial or late result shows as an audit note. |
| Both | "Uncertain" on both sides while uncertain (platform PRD §9.4 item 5). |

B's reply has no draft lane in A's conversation. Drafts (#500) show only in B's
conversation, for B's own execution.

## 10. Reuse

| Reused | How |
|---|---|
| K4 core (#532): per-Agent FIFO, `enqueue`, `HostLedger`, `applyOutcome` transaction, `cancel`, expiry by `tasks.cancel` and `tasks.attempt`, `armScan`, projections | Unchanged. `bot_request` and `bot_reply` are `source: 'bot'` intents |
| `executions.submit` (K5) | Via `core.submit`, with the frozen input |
| K6 busy `code` | Via the K4 retry rule |
| K7 `submit_result` and `bot-turn-outcome.v1` | `delegate` fragment with a wider `to` enum; `composeBotTurnOutcomeSchema`; `validateResultOutcome` at apply |
| `messageEgress` and `send_agent_message` | B's reply channel, with a Host-set `maxBytes` |
| `createByokServer({ agentMessage })` and `tasks.agentMessage` | Reply acceptance and exact readback (§3.3) |
| `enqueueAgentHomeProjection` and `readAgentHomeProjection` | Not used directly by Cross-Bot. #531 already gates new Bots on persona readback (`home-projections.ts` on #531). A target enters the enum after its first persona readback (§2.2) |
| K2 wake queue | Only through the K4 scan wake for open intents. Delegation timers use the example reconcile loop (§3.10). No new wake keys |
| #530 continuation, budgets, `rejectedActions`, ContextPack truncation | Extended, not replaced |
| #531 roster, team archive, room seat schema | Roster feeds the enum. Archive feeds refusals |

Coding-agent messaging (Session mode) is not reused. `LocalTeamWorkspace` is
local-only and has no cloud protocol, so platform PRD §9.7 rejects it as a
base. Cross-Bot does not carry intent in `agent.message.publish` bodies either:
the intent goes through `submit_result`, and the body is only B's reply text.
One pattern is borrowed. `send_agent_message` takes no routing parameter
(`packages/client/src/bin/agent-message-mcp-server.ts:17-33`): the Host owns
the destination binding. Cross-Bot keeps the same split. The model picks an id
from a Host enum, and the Host owns where the request and the reply go.

## 11. Slices

Slices X1–X6 and X2M are `examples/bot-collaboration/` code, tests and docs.
Slice XS is the only SDK change. It gets its own SDK issue, like K8-S, and
does not depend on #530 or #531.

Prerequisite for every example slice (X1–X6, X2M): #532 lands. Then #530 and
#531 restack onto it and land (ruling 2026-10-19, "K4 sequencing" and "Cross-Bot delegation").
Before that, #531 must implement the history rulings: recent-N truncation with
a notice, no block on history, and the post-join cutoff. Cross-Bot relies on
them (§3.7).

| Slice | Scope | Depends on | Acceptance (platform PRD §14.2 unless noted) |
|---|---|---|---|
| X1 Core delegation | Action order fix (§1.1, §3.1); `Delegation` row; `bot_request`/`bot_reply` sources; `Turn.authority` and the authority gate (§6.1); `addTurn` with hop and authority (§4.2); `to` enum (§2.2); apply checks (archived, duplicate, hop, room seat, one cross-Bot item per outcome, root admission `spent + reserved + reserve(1) ≤ 12` with the unit ledger (§6.2)); B ContextPack `delegation` block; `BOT_REPLY_MAX_BYTES` with the `consumeMessage` byte check; instruction encoding and construction check (§3.7); `consumeMessage`, `tasks.agentMessage` in the port type, `reply_pending`/`reply_held` and the reconcile loop (§3.3, §3.10); single reply Turn; refusal report Turn (§8.2); continuation chain on created successors (§3.6); projection events with revisions (§7) | #530, #531 | "A delegates to B on the same device"; "Host crashes after the delegation write and before submit"; "B's terminal or message is delivered twice"; "B fails or is interrupted, or no `submit_result`"; "outcome does not match the schema"; "chain exceeds the hop limit"; "over budget"; "B runs in its own conversation"; "Main Bot changes B's profile during a delegation"; "security: normal Bot schema". Added: (a) normal A → Main Bot B → B continues itself → no management fragments, and apply refuses management from an older offer; (b) hop 4 → self continuation → external delegate → `refused` (hop 5); (c) every refused item of an outcome → one refusal report Turn, whose schema has no `delegate`; (d) the last allowed continuation proposes another one → refused → verdict from this Turn's accepted reply; (e) B success terminal with no other open work → `reply_pending` → `answered` without a K4 scan; held → `reply_held`, End → `abandoned`; (f) queued → running → answered publishes three events with no identity conflict; (g) a second cross-Bot item → `fan_out_not_enabled`; (h) the §3.7 worst-case generator: every encoded instruction ≤ `instructionMaxBytes`, no Cross-Bot Turn blocks, `executions.submit` accepts it; a budget below the computed minimum is refused at construction; (i) spent 11 with no open reservation → refusal report starts with the last unit; free balance 0 → refusal report is delivery only; (j) unit ledger: replayed apply, claim and verdict events change no unit twice; `spent + reserved ≤ 12` after every transaction |
| XS SDK fragment | `@byok-sdk/protocol`: `botTurnOutcomeFragments.cancelDelegation({ delegationIds })`, `'cancel_delegation'` in `BotTurnOutcomeKind`, `CancelDelegationAction { delegationId }`, `BotTurnOutcome.cancel_delegation?`, `cancelDelegationMaxItems = 2` in `BOT_TURN_OUTCOME_LIMITS` (Q12); composition bound tests (≤ 65 536 bytes); api-surface golden; spec section "Bot turn outcome fragments and routine time points"; `bun run check:release-pack` | none | The fragment passes the K7 subset check. Composed schemas with the fragment stay within the outcome bound. The fragment rejects a third item. The api-surface diff shows only the additions |
| X2 Wait, cancel, uncertain | Verdict mapping (§8.1); `cancelDelegation`, `abandonDelegation`; cancel fact in the arbitration transaction, cancel without an intent, cancel redelivery after a crash (§8.8); cancel versus acceptance; `cancelGraceMs`, `uncertainAfterMs`; late terminals to audit | X1 | "B drops while running; cancel finds no terminal → uncertain, no resubmit; user ends it → `abandoned`; later terminal → audit only"; cancel before acceptance → `cancelled`, no reply; acceptance before cancel → `cancelled` with a partial reply. Added: cancel while the target waits for persona readback → `cancelled`, no `core.cancel` call; crash after the arbitration commit and before `core.cancel` → restart delivers the cancel to the frozen target |
| X2M Main Bot cancel | Apply `cancel_delegation` (§8.8): enum of open delegations with the hidden-count notice, authority and room-seat checks, `main_bot_cancelled`, `already_resolved` | XS, X2 | A Main Bot with `authority = owner` cancels a running delegation → one `cancelled` verdict, A receives one report. A normal Bot schema and a Main Bot `bot_request` schema have no `cancel_delegation`. A resolved target → rejected action, no second verdict |
| X3 Fan-in join | Two cross-Bot items per outcome; batch reply Turn; no empty batch; uncertain release; late single report; `reserve(n) = n + max(n, 1)`, root admission over all open reservations, A slot release after each report (§6.2) | X2 | Fan-out of 2 gives one A execution with both verdicts. One uncertain sibling releases the batch; its later verdict gives exactly one extra A Turn. Both uncertain → no batch Turn. Spent 8 + fan-out 2 with no open reservation → reserve 4; with one late report the total is 12, never 13. Spent 9 + fan-out 2 → index 1 refused, total ≤ 11. After a join with no late report, one A slot is released. Interleaved batches (§6.2 example): the second fan-out is cut to 1, the committed total stays ≤ 11, and the old late report starts. A randomized interleaving test of two batches with verdicts, uncertain items, late reports, claims and replays keeps `spent + reserved ≤ 12` after every transaction, and every reserved report can start |
| X4 Lifecycle | Target archived in each state (§8.4); initiator archived (§8.5); enum refresh | X2 | Each row of §8.4 gives one `refused` verdict, and A receives one report. Initiator archived: verdict written, no reply Turn |
| X5 Second device | B on a second `deviceId` with a daemon that has no Host code; `waiting_device` status; offline expiry; relay contract doc for two-process Topology L | X2 | "A delegates to B on another device; B's device has no Host code" on the embedded-server path only; "B's device is offline → waiting for device → `expired` → A receives one report". The hosted path and the two-process relay stay open (§3.9) |
| X6 Docs | `examples/bot-collaboration/README.md` and VALIDATION; Host guide section; a follow-up docs PR for the PRD text (§9.4 item 3 reply key per Q2; `cancel_delegation` in the fixed apply order per Q7; product PRD §5.2, §9, §10 P4 scope) | X1–X5, X2M | Required checks pass. No PRD edit in the code slices |


XS has no prerequisite. It also runs `bun run check:release-pack`, and it
updates the protocol api-surface golden and the spec section in the same PR.

Each slice runs the five required checks from `CLAUDE.md`: `bun run build`,
`bun run typecheck`, `bun run test`, `bun run check:api-surface`,
`bun run check:version-authority`. Tests use the synthetic fake runtime (product
PRD §5.8). A real Pi run of Cross-Bot is a paid call and needs separate
approval. The `submit_result` success rate on Pi stays a launch gate (platform
PRD §16).

Rollback: the example slices are example code, tests and docs. Revert the PR
(platform PRD §13.1, K8 rollback). XS is a public protocol change. Revert it
before a release. After a release there is no compatibility layer (O10); the
release notes give the steps, as for K8-S (platform PRD §13.1 on #524).
Offers that already froze a schema are not affected.

## 12. Non-goals

- External-bot beta Cross-Bot: beta v1 does not add `byok_agent_message` or
  Cross-Bot for external Bots (#536, #539; ruling 2026-10-19 ~14:15 HKT).
- Coding-agent messaging: `send_agent_message` as a Session-mode team helper,
  `team`, `LocalTeamWorkspace`, and `agent.message.publish` bodies as intent
  carriers. Platform PRD §9.7 rejects the last two as a base, and this plan
  keeps that ruling.
- herdr on the execution path. Delivery is Host ledger → K4 →
  `executions.submit` → daemon.
- Main Bot routine `target` (`create_routine.target` for another Bot). It does
  not use delegation. It stays a later K8b work order (PRD-revisions
  2026-10-19).
- New SDK API other than `cancel_delegation` (XS): a `message` outcome kind
  or a higher `delegateMaxItems`. Q1 and Q3 exclude them from v1. A later
  change needs its own SDK issue.
- A run-time action channel to the Host (K9). Synchronous delegation (platform
  PRD §9.7).
- Cross-team or cross-owner delegation. Moving a Bot to another device.
  Reading another Bot's memory.
- A Host-service (Topology H) K4 adapter and the two-process Topology L relay
  code. These belong downstream (§3.9).
- Claude or Codex as the Bot runtime. Bot mode stays Pi-only (product PRD Q8,
  2026-10-18 meaning).

## 13. Decided questions

Aimpact decided Q1–Q11 on 2026-10-19 14:59 HKT. Each decision is the
recommended default of the first draft of this plan. Slices implement these
decisions. A change to a decision needs a new Aimpact ruling. After the Codex
review, Aimpact reopened Q7, Q8 and Q10 and decided them again on 2026-10-19
~15:07 HKT. Their rows show the 15:07 decisions (§13.1).

| # | Question | Decision | Status | Rationale |
|---|---|---|---|---|
| Q1 | Do we need a separate "message, no reply" action? | No. One action, `delegate`; a plain message is a delegation with a short reply | Decided (Aimpact, 2026-10-19 14:59 HKT) | A new kind is an SDK change and a fire-and-forget message breaks the one-verdict rule (I8) |
| Q2 | Should the Host join a fan-out into one reply Turn? | Yes. One `bot_reply` Turn per A outcome; uncertain items report later on their own | Decided (Aimpact, 2026-10-19 14:59 HKT) | The PM answers the user once with all results, and the fan-out uses one A execution, not two |
| Q3 | Is a fan-out of 2 per outcome enough? | Yes for v1. Keep the frozen `delegateMaxItems = 2`; more targets take another round | Decided (Aimpact, 2026-10-19 14:59 HKT) | The cap is frozen public API since #525; raising it is an SDK change with no data yet |
| Q4 | Who can a Bot address? | Any active Bot in the same team. No per-Bot allowlist, no cross-team | Decided (Aimpact, 2026-10-19 14:59 HKT) | One owner owns every Bot in a ledger; the enum and the apply-time recheck already bound the scope |
| Q5 | May a Main Bot use management actions on a `bot_request` Turn? | No. `bot_request` Turns never get management fragments | Decided (Aimpact, 2026-10-19 14:59 HKT) | Another Bot's request text must not be able to create, delete or rewire Bots |
| Q6 | May a group member delegate privately from a room seat? | No. In-room addressing stays `room_call` | Decided (Aimpact, 2026-10-19 14:59 HKT) | A private hand-off moves room content into 1:1 conversations and puts the answer where the user did not ask |
| Q7 | Who can cancel a delegation? | The user or a Main Bot. The user cancels from A's chip or B's Turn. A Main Bot cancels through the new `cancel_delegation` outcome fragment (slice XS, an SDK change in K8b) | Decided (Aimpact, 2026-10-19 ~15:07 HKT reopen) | It matches platform PRD §9.4 ("user or Main Bot"); the 14:59 user-only decision is withdrawn |
| Q8 | What is the reply size cap, and how is the context bound proven? | `BOT_REPLY_MAX_BYTES = 8 192`. The size bound is proven on the final encoded instruction: raw framed request text with no second JSON encoding, metadata at 6 bytes per code point, `R_reply ≤ 20 672` and `R_req ≤ 6 144` bytes, and a construction check `instructionMaxBytes ≥ P + max(R_reply, R_req) + F_max` (§3.7) | Decided (Aimpact, 2026-10-19 ~15:07 HKT reopen) | Encoding growth can then never trip the "block only if the current request alone exceeds the budget" rule (Codex P1-4) |
| Q9 | When does a delegation become uncertain? | Cancel requested with no terminal for 60 s, or claimed with no terminal for 30 min | Decided (Aimpact, 2026-10-19 14:59 HKT) | It is display-only and enables "End"; 30 min avoids marking normal long runs as uncertain |
| Q10 | How does a delegation count against the per-root budget of 12? | Prepay the worst case at acceptance: `reserve(n) = n + max(n, 1)` for `n` accepted cross-Bot items, which covers late reports after an uncertain sibling. Admission is root-level: `spent + all unreleased reserves + reserve(n) ≤ 12`; a claim moves a unit from reserved to spent. Release a unit only when it can no longer be needed. A refusal report Turn uses one unit; with no free unit it is delivery only (§6.2) | Decided (Aimpact, 2026-10-19 ~15:07 HKT reopen) | `n + 1` did not cover a late report (Codex P1-3); this formula keeps every report deliverable within 12 |
| Q11 | Is two-process Topology L sync in K8b? | No. K8b documents the relay contract; the Host service implements it downstream | Decided (Aimpact, 2026-10-19 14:59 HKT) | The §14.2 rows run in one ledger; the sync transport is Host-service work, as for K4 (Q19) |
| Q12 | What is the `cancel_delegation` item cap per outcome? | 2, the same as `delegateMaxItems` (`cancelDelegationMaxItems = 2`) | Decided (Aimpact, 2026-10-19 16:01 HKT) | It matches the fan-out cap, so one Main Bot outcome can cancel a full fan-out |

Follow-up: Q2 needs a separate PRD docs PR for platform PRD §9.4 item 3. The
reply Turn key becomes `H('bot_reply', A.taskId)` for a fan-out batch. A
single delegation or a late uncertain report keeps the PRD key `H(delegationId)`,
written here with a domain tag as `H('bot_reply', delegationId)` (§3.4, §3.5).
This PR does not edit the PRD.

### 13.1 Reopened and decided (Aimpact, 2026-10-19 ~15:07 HKT)

- Q7: the user or a Main Bot can cancel a delegation. The 14:59 user-only
  decision is withdrawn. A Main Bot cancels through the new
  `cancel_delegation` fragment (slice XS, then X2M; §8.8).
- Q8: the reply cap stays 8 192 bytes. The bound is proven on the final
  encoded instruction (§3.7). The acceptance criterion is that this encoded
  bound holds, tested with a worst-case generator in X1.
- Q10: prepay the worst case, `reserve(n) = n + max(n, 1)`, late reports
  included. Admission is root-level: `spent + reserved + reserve(n) ≤ 12`,
  counting every open reservation on the root. A unit is released only when
  it can no longer be needed. A
  refusal report uses one unit, or is delivery only when no unit is free
  (§6.2).
- Q12 (Aimpact, 2026-10-19 16:01 HKT): `cancel_delegation` allows at most 2
  items per outcome, the same as `delegateMaxItems`. Aimpact also approved
  this plan at that time.

### 13.2 Codex review findings

| Finding | State | Where |
|---|---|---|
| P1-1 Management denial only by source | Fixed: durable `authority` field, checked by schema and apply | §6.1, §4.2, X1 (a) |
| P1-2 Same projection id for each status | Fixed: `delegation:<id>:<revision>` events | §7, §9, X1 (f) |
| P1-3 `n + 1`, root admission and slice order | Fixed: worst case and no empty batch defined; `reserve(n) = n + max(n, 1)` (Q10, 15:07); root admission over all open reservations with a unit ledger, claim invariant and release timing (Codex round 2); X1 limited to one item; X3 after X2 | §3.5, §6.2, §11, X1 (i), (j), X3 |
| P1-4 8 KiB does not bound the encoded request | Fixed: bound proven on the final encoded instruction, plus a construction check (Q8, 15:07) | §3.2, §3.7, X1 (h) |
| P1-5 All refused: A never receives it | Fixed: delivery separate from model start; one refusal report, no `delegate` in its schema; one unit, or delivery only (Q10, 15:07) | §8.2, §6.2, X1 (c), (i) |
| P1-6 Chain end on a refused continuation | Fixed: chain moves only along created successors | §3.6, X1 (d) |
| P1-7 No scan after K4 settles; held | Fixed: `reply_pending`/`reply_held` and the example reconcile loop | §3.3, §3.10, X1 (e) |
| P2-1 Cancel without an intent; crash between transactions | Fixed: cancel fact in the arbitration transaction, frozen target, redelivery | §8.8, X2 |
| P2-2 Wrong #531 apply-order citation | Fixed: citation corrected; reorder in X1 | §1.1, §3.1 |
| P2-3 Continuation resets hop to 0 | Fixed: `addTurn` takes hop and authority | §3.1, §4.2, §6.2, X1 (b) |
| P2-4 Q7 narrows the PRD | Fixed: user or Main Bot cancel; `cancel_delegation` fragment (Q7, 15:07) | §8.8, XS, X2M |
| Q11 note: §14.2 cross-device row | Recorded as an open acceptance gap. Q11 is unchanged | §3.9, X5 |
