# K8b Cross-Bot: Bot↔Bot delegation in Bot mode (plan)

Issue: [#540](https://github.com/Ancienttwo/byok-sdk/issues/540).
Status: plan only. No implementation code. Aimpact decided Q1–Q11 as
recommended on 2026-10-19 14:59 HKT (§13). Implementation waits for the
dependencies in §11.
Baseline: `origin/main@5b988a6e`. In-flight inputs: #532
(`codex/bot-k4-host-execution-core@e5afad26`), #530
(`codex/k8a-bot-collaboration@c9dabb9e`), #531
(`codex/k8b-group-chat@23132486`), #524 (`docs/bot-mode-prd-v3@caac794a`).
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
- Fixed apply order. `delegate` is applied last in the outcome transaction
  (platform PRD §9.3).

This plan adds the parts the PRD leaves open:

1. Addressing rules: which ids go into the `to` enum, and when (§2).
2. Exact reply capture: how the Host gets B's accepted reply body (§3.3).
3. A fan-in join for the PM pattern: one A execution per fan-out (§3.5, Q2).
4. Budget accounting that never strands a reply: the reply execution is
   prepaid when the delegation is accepted (§6.2, Q10).
5. Schema variant rules: a `bot_request` Turn never gets management actions,
   even on a Main Bot (§6.1, Q5).
6. A verdict mapping from K4 conclusions (§8.1).
7. A delegation stays open across B's own continuations (§3.6).

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
- `others` is every active, non-archived Bot in X's team, except X, in roster
  order.
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
`taskId` (`examples/host-execution-core/src/core.ts:340-358` on #532). The
collaboration Host's `applyOutcome` already applies `delegate` last
(`examples/bot-collaboration/src/host.ts:99-107` on #531). Cross-Bot replaces
the `Target is not this Bot` refusal with this branch, per item `i`:

1. `delegationId = H(A.taskId, 'delegate', i)`. If the row exists, stop. This
   makes a re-applied terminal a no-op.
2. `to == A`: keep the K8a continuation path unchanged.
3. Duplicate `to` in the same outcome: refuse the second item
   (`duplicate_target`). #531 already does this.
4. Target check: active, not archived, same team. Otherwise `refused`.
5. Hop: `hop = A.turn.hop + 1`. If `hop > 4`, `refused` (`hop_limit`).
6. Budget: reserve from `budgets[root]` (§6.2). If the reserve fails,
   `refused` (`budget_exhausted`).
7. Insert the delegation row (§4.1) and the B Turn:
   `id = delegationId`, `botId = B`, `source = 'bot_request'`,
   `root = A.turn.root`, `hop`, `delegationId`, and `request` = the action's
   `request` text.
8. Publish projection `delegation:<delegationId>` with status `queued`.

A refusal is a verdict. It is written into the delegation row and the
projection. It is not a new A Turn (§8.2 explains why).

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
  (default 8 192). The Host owns this offer field. The reply then always fits
  A's ContextPack (Q8). The `agentMessageContext.destinationBinding` is B's
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
- At B's success terminal, the Host reads
  `server.tasks.agentMessage(taskId, deviceId, agentRef)`
  (`packages/server/src/index.ts:216`; protocol "Host discovery of the first
  Agent message", `docs/protocol.md:2780`). Accepted: verdict `answered`.
  Pending or held: no verdict yet; the K4 reconcile scan retries. No message:
  verdict `failed` (`no_reply`).

The Host never derives the reply from the outcome document or from model text
(I10).

### 3.4 Reply to A (single delegation)

At B's verdict, in one transaction:

- Set the delegation verdict once (compare-and-set from empty).
- Insert A's Turn: `id = H('bot_reply', delegationId)`, `botId = A`,
  `source = 'bot_reply'`, `root = A.turn.root`, `hop = A.turn.hop` (the origin
  hop, not `hop + 1`), and `request` = JSON
  `{ replies: [{ delegationId, from, request, verdict, reason?, reply? }] }`.
- Set `delegation.replyTurnId`. This field is written once, so A receives at
  most one report per delegation.
- Skip the Turn if A is archived (§8.5).

The reply hop is the origin hop because the chain returns to A. It does not go
deeper. A PM that runs many rounds is bounded by the root budget (§6.2).

### 3.5 Fan-in join (PM fan-out)

One outcome can hold two cross-Bot `delegate` items. Without a join, A runs
twice and may answer the user twice. With a join, the Host enqueues one A Turn
per fan-out:

- Batch = all accepted cross-Bot delegations from one A outcome.
- The batch reply Turn id is `H('bot_reply', A.taskId)`. It is created when
  every delegation in the batch has a verdict or is uncertain.
- It carries every verdict in the batch, including apply-time refusals from
  the same outcome.
- A delegation that is uncertain at batch release reports later in its own
  Turn `H('bot_reply', delegationId)`.
- `delegation.replyTurnId` stays the one-report guard. Each delegation is in
  exactly one reply Turn.

This refines platform PRD §9.4 item 3 ("reply Turn key `H(delegationId)`").
A batch of one keeps that key. A batch of two uses the batch key. Aimpact
decided Q2 (§13). The PRD text changes in a separate follow-up docs PR, not in
this PR.

### 3.6 B's continuation keeps the delegation open

B may answer a long request with an ack and a self `delegate` (K8a long-task
rule, product PRD §5.6). The ack is then not the answer. Rule:

- A continuation Turn created from a Turn with `delegationId` inherits that
  `delegationId`.
- The delegation verdict comes from the terminal of the last Turn in that
  chain, that is, a terminal whose outcome makes no further continuation.
- The reply is that last Turn's accepted message.
- Continuations use the root continuation budget (4 per root, Q11 in the
  product PRD). They do not use the Bot budget, and hop does not change.
- A failed, cancelled or missing-outcome continuation gives `failed` or
  `cancelled` for the delegation.

### 3.7 Context budget

The 2026-10-19 rulings apply to `bot_request` and `bot_reply` Turns the same
way as to group and 1:1 history:

- History is recent-N, truncated by the token budget, with an explicit
  truncation notice. The Host never blocks on history.
- The Host blocks only when the current request alone exceeds the budget.
- The current request of a `bot_request` Turn is at most 1 000 code points.
  It cannot exceed the budget.
- The current request of a `bot_reply` Turn is at most two replies of
  `BOT_REPLY_MAX_BYTES` plus metadata. With the 8 KiB default this is far
  below the 32 KiB default (`DEFAULT_CONTEXT_MAX_BYTES`,
  `examples/bot-collaboration/src/schema.ts` on #530). If a Host lowers its
  budget below that size, the `bot_reply` Turn blocks with a visible reason.
  The delegation verdict stays as it is. B's full reply stays visible in B's
  conversation.
- B sees only its own conversation and the `delegation` block. This matches
  the late-join rule: a Bot never sees history it was not part of.

Cross-Bot uses the truncation that #530 and #531 must ship for these rulings.
#531 still blocks when history is full (`rooms.ts:138`, `schema.ts:65` on
#531). Cross-Bot does not start until that is fixed (§11).

### 3.8 Wakes, routines, busy targets

- Messages and callbacks never enter the wake queue (platform PRD §4, §9.2
  item 9). Cross-Bot adds no wake key family.
- Host timers (wait limit, uncertain thresholds) use the existing K4 scan wake
  `host-scan:<hash(tenant)>:<n>` (`core.ts:216-235` on #532). X3 adds the
  delegation deadlines to the next-scan time that `process()` computes
  (`host.ts` timer on #531).
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
| `chainTurnIds` | B's Turn ids in this delegation, in order (§3.6) |
| `batch` | `fromTaskId` (join group, §3.5) |
| `status` | `queued` · `waiting_device` · `running` · `uncertain` · `resolved` |
| `verdict` | `answered` · `failed` · `cancelled` · `refused` · `expired` · `abandoned`; set once |
| `reason` | Code: `target_archived`, `hop_limit`, `budget_exhausted`, `duplicate_target`, `no_reply`, `busy`, `user_cancelled`, `claim_raced_deadline`, `initiator_archived`, `room_seat` |
| `reply` | Accepted reply body reference (B's `taskId`) when `answered` or `cancelled` after acceptance |
| `replyTurnId` | A's reply Turn id; set once |
| `cancelRequestedAt`, `uncertainSince`, `resolvedAt` | Timers and audit |

### 4.2 Turn changes

- `Turn.source` adds `'bot_request' | 'bot_reply'` to the #531 union
  (`model.ts:5-9` on #531).
- `Turn.delegationId?` on `bot_request` Turns and their continuations.
- `bot_reply` Turns keep the reply list in `request` as JSON. The `answer`
  source already uses JSON this way (`host.ts:116-132` on #530).
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
- Role gate: a `bot_request` Turn never gets management fragments, even when
  B is a Main Bot (Q5). Another Bot's request text must not drive
  `create_bot`, `delete_bot`, `update_room`, or `create_routine.target`. The
  Main Bot keeps management on its user-rooted Turns, including `bot_reply`
  Turns of its own fan-out.
- `confirmable_action` and `ask_user` stay available on `bot_request` Turns.
  Cards and questions appear in B's conversation, and the owner decides (A1).
  The delegation verdict still comes from B's terminal.
- No user opt-in per pair and no per-Bot allowlist in v1 (Q4). One owner owns
  every Bot in the ledger.

### 6.2 Budgets and loop prevention

- Every Bot-triggered Turn has a root: a user input, an answer, or a routine
  Turn. Every limit counts per root. No chain exists without a root.
- Hop: `bot_request.hop = origin hop + 1`, at most 4. A continuation keeps the
  hop. A `bot_reply` Turn has the origin hop.
- Root Bot budget, default 12 executions (platform PRD §9.4). Cross-Bot counts
  each B execution and each A reply execution. Generations of the same intent
  do not count.
- Prepaid reply (Q10). Accepting a fan-out of `n` cross-Bot items reserves
  `n + 1` units: `n` B executions and one A reply execution. If the reserve
  does not fit, the Host refuses items from the last index until it fits. A
  reply Turn therefore never fails for lack of budget. This keeps I8.
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
| Projection | `delegation:<id>` | Stable id. The receiver dedups (K4 projection rule) |

Retries come only from K4 rules: busy decline after a terminal, or a failure
the retry policy allows (`DEFAULT_RETRY`, `model.ts:10` on #532). The Host
never resubmits a delegation on its own.

## 8. Failure modes

### 8.1 K4 conclusion to verdict

| B side evidence | Verdict | Reason |
|---|---|---|
| `succeeded` and the accepted reply is read back | `answered` | — |
| `succeeded`, no message | `failed` | `no_reply` |
| `succeeded`, message pending or held | none yet | Reconcile scan retries |
| `failed`, or no `submit_result` (K7 `task.fail`) | `failed` | B's actions are not applied |
| `declined` after K4 retries | `failed` | `busy` or decline code |
| `expired` (cancelled, no claim at deadline) | `expired` | — |
| `cancelled` with Host cancel reason `expired` (claim raced the deadline; WO-05 ruling) | `expired` | `claim_raced_deadline` |
| `cancelled` after a user cancel | `cancelled` | `user_cancelled` |
| Target archived after acceptance | `refused` | `target_archived` (§8.4) |

Execution settlement (SDK evidence) and the verdict (Host) stay separate
records (I8).

### 8.2 Refusal at apply time

The Host writes `refused` with its reason and publishes the projection. It
reports refusals in A's next ContextPack through `rejectedActions`, which #531
already filters per Bot. A refusal never creates its own A Turn. Reasons:

- A `budget_exhausted` refusal that wakes A would let A delegate again and be
  refused again. That is a loop with no budget to stop it.
- A refusal in a fan-out with accepted siblings goes into the batch reply
  Turn (§3.5). A receives it once.

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

Per §3.7. History never blocks. A `bot_request` Turn cannot exceed the budget.
A `bot_reply` Turn blocks only if its own content exceeds a lowered budget,
and the verdict stays.

### 8.8 Cancellation arbitration

- The user can cancel from A's delegation chip or from B's `bot_request` Turn.
  Both call `cancelDelegation(id)`. It cancels the current Turn in the chain
  through `core.cancel`.
- Cancel and B's first message acceptance meet in one Host transaction
  boundary (conversation PRD §5, "取消与首次接受"):
  - Cancel commits first: a later B message is refused. Verdict `cancelled`
    with no reply.
  - Acceptance commits first: the cancel stops only the rest of the
    execution. The verdict is `cancelled`. The reply Turn carries the accepted
    body and marks it partial.
- Main Bot cancel needs a new outcome action. That is an SDK fragment change,
  so v1 has user cancel only (Q7).
- B's staged outcome is never applied after a cancel. K7 sends no document
  with a cancelled terminal.

## 9. Host UI surface

The reference Host has no UI. It publishes projections through K4 `project()`,
like `question:<id>`, `card:<id>` and `blocked:<id>`. Cross-Bot adds
`delegation:<id>` with `{ id, fromBotId, toBotId, request, status, verdict?,
reason?, replyTurnId? }`, and two owner APIs: `cancelDelegation(id)` and
`abandonDelegation(id)`.

A product Host renders at minimum:

| Where | What the user sees |
|---|---|
| A's conversation, after A's ack | One chip per delegation: target name, first line of the request, status. Status text: queued, waiting for device, running, uncertain, then the verdict. Refusals show the reason. |
| Chip controls | "Cancel" while queued, waiting, or running. "End" while uncertain (this sets `abandoned`). No control after a verdict. |
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
| `enqueueAgentHomeProjection` and `readAgentHomeProjection` | Not used directly by Cross-Bot. #531 already gates new Bots on persona readback (`home-projections.ts` on #531). A target is in the enum only after it is ready |
| K2 wake queue | Only through the K4 scan wake. No new wake keys |
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

All slices are `examples/bot-collaboration/` code, tests and docs. No slice
changes an SDK package (§12 lists the SDK gaps that non-default answers would
open).

Prerequisite for every slice: #532 lands. Then #530 and #531 restack onto it
and land (ruling 2026-10-19, "K4 sequencing" and "Cross-Bot delegation").
Before that, #531 must implement the history rulings: recent-N truncation with
a notice, no block on history, and the post-join cutoff. Cross-Bot relies on
them (§3.7).

| Slice | Scope | Depends on | Acceptance (platform PRD §14.2 unless noted) |
|---|---|---|---|
| X1 Core delegation | `Delegation` row; `bot_request`/`bot_reply` sources; `to` enum; apply checks (archived, duplicate, hop, prepaid budget, room seat); `bot_request` schema without management; B ContextPack `delegation` block; `BOT_REPLY_MAX_BYTES`; `consumeMessage` and `tasks.agentMessage` readback; single-delegation reply Turn; continuation chain (§3.6); `delegation:<id>` projection | #530, #531 | "A delegates to B on the same device"; "Host crashes after the delegation write and before submit"; "B's terminal or message is delivered twice"; "B fails or is interrupted, or no `submit_result`"; "outcome does not match the schema"; "chain exceeds the hop limit"; "over budget"; "B runs in its own conversation"; "Main Bot changes B's profile during a delegation"; "security: normal Bot schema"; plus: a `bot_request` on a Main Bot has no management fragments |
| X2 Fan-in join | Batch reply Turn, uncertain release, late single reply | X1 | Fan-out of 2 gives one A execution with both verdicts. One uncertain sibling releases the batch; its later verdict gives exactly one extra A Turn. Budget use is `n + 1` |
| X3 Wait, cancel, uncertain | Verdict mapping (§8.1); `cancelDelegation`, `abandonDelegation`; cancel versus acceptance; `cancelGraceMs`, `uncertainAfterMs`; deadlines in the scan timer; late terminals to audit | X1 | "B drops while running; cancel finds no terminal → uncertain, no resubmit; user ends it → `abandoned`; later terminal → audit only"; cancel before acceptance → `cancelled`, no reply; acceptance before cancel → `cancelled` with a partial reply |
| X4 Lifecycle | Target archived in each state (§8.4); initiator archived (§8.5); enum refresh | X1 | Each row of §8.4 gives one `refused` verdict and A receives one report. Initiator archived: verdict written, no reply Turn |
| X5 Second device | B on a second `deviceId` with a daemon that has no Host code; `waiting_device` status; offline expiry; relay contract doc for two-process Topology L | X1, X3 | "A delegates to B on another device (Topology H); B's device has no Host code"; "B's device is offline → waiting for device → `expired` → A receives one report" |
| X6 Docs | `examples/bot-collaboration/README.md` and VALIDATION; Host guide section; a follow-up docs PR for the PRD text (§9.4 item 3 reply key per Q2; product PRD §5.2, §9, §10 P4 scope) | X1–X5 | Required checks pass. No PRD edit in the code slices |

Each slice runs the five required checks from `CLAUDE.md`: `bun run build`,
`bun run typecheck`, `bun run test`, `bun run check:api-surface`,
`bun run check:version-authority`. Tests use the synthetic fake runtime (product
PRD §5.8). A real Pi run of Cross-Bot is a paid call and needs separate
approval. The `submit_result` success rate on Pi stays a launch gate (platform
PRD §16).

Rollback: every slice is example code, tests and docs. Revert the PR (platform
PRD §13.1, K8 rollback).

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
- New SDK API: a `message` outcome kind, a `cancel_delegation` fragment, or a
  higher `delegateMaxItems`. Q1, Q3 and Q7 exclude them from v1. A later
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
decisions. A change to a decision needs a new Aimpact ruling.

| # | Question | Decision | Status | Rationale |
|---|---|---|---|---|
| Q1 | Do we need a separate "message, no reply" action? | No. One action, `delegate`; a plain message is a delegation with a short reply | Decided (Aimpact, 2026-10-19 14:59 HKT) | A new kind is an SDK change and a fire-and-forget message breaks the one-verdict rule (I8) |
| Q2 | Should the Host join a fan-out into one reply Turn? | Yes. One `bot_reply` Turn per A outcome; uncertain items report later on their own | Decided (Aimpact, 2026-10-19 14:59 HKT) | The PM answers the user once with all results, and the fan-out uses one A execution, not two |
| Q3 | Is a fan-out of 2 per outcome enough? | Yes for v1. Keep the frozen `delegateMaxItems = 2`; more targets take another round | Decided (Aimpact, 2026-10-19 14:59 HKT) | The cap is frozen public API since #525; raising it is an SDK change with no data yet |
| Q4 | Who can a Bot address? | Any active Bot in the same team. No per-Bot allowlist, no cross-team | Decided (Aimpact, 2026-10-19 14:59 HKT) | One owner owns every Bot in a ledger; the enum and the apply-time recheck already bound the scope |
| Q5 | May a Main Bot use management actions on a `bot_request` Turn? | No. `bot_request` Turns never get management fragments | Decided (Aimpact, 2026-10-19 14:59 HKT) | Another Bot's request text must not be able to create, delete or rewire Bots |
| Q6 | May a group member delegate privately from a room seat? | No. In-room addressing stays `room_call` | Decided (Aimpact, 2026-10-19 14:59 HKT) | A private hand-off moves room content into 1:1 conversations and puts the answer where the user did not ask |
| Q7 | Who can cancel a delegation? | The user only, from A's chip or B's Turn. Main Bot cancel waits for its own SDK issue | Decided (Aimpact, 2026-10-19 14:59 HKT) | Main Bot cancel needs a new outcome fragment; user cancel uses the existing K4 cancel path |
| Q8 | What is the reply size cap? | `BOT_REPLY_MAX_BYTES = 8 192` in B's frozen `messageEgress.maxBytes` | Decided (Aimpact, 2026-10-19 14:59 HKT) | It keeps every reply inside A's context budget, so the "block only if the current request alone is over budget" rule never strands a reply |
| Q9 | When does a delegation become uncertain? | Cancel requested with no terminal for 60 s, or claimed with no terminal for 30 min | Decided (Aimpact, 2026-10-19 14:59 HKT) | It is display-only and enables "End"; 30 min avoids marking normal long runs as uncertain |
| Q10 | How does a delegation count against the per-root budget of 12? | Each B execution and each A reply execution counts; the reply is prepaid when the delegation is accepted | Decided (Aimpact, 2026-10-19 14:59 HKT) | The reply then never fails for lack of budget, which keeps the one-report rule |
| Q11 | Is two-process Topology L sync in K8b? | No. K8b documents the relay contract; the Host service implements it downstream | Decided (Aimpact, 2026-10-19 14:59 HKT) | The §14.2 rows run in one ledger; the sync transport is Host-service work, as for K4 (Q19) |

Follow-up: Q2 needs a separate PRD docs PR for platform PRD §9.4 item 3. The
reply Turn key becomes `H('bot_reply', A.taskId)` for a fan-out batch. A
single delegation or a late uncertain report keeps the PRD key `H(delegationId)`,
written here with a domain tag as `H('bot_reply', delegationId)` (§3.4, §3.5).
This PR does not edit the PRD.
