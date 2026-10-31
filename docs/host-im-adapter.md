# Host IM adapter guide

Use this guide when a Host connects Bots to an IM channel, such as Slack, Telegram, Feishu or DingTalk.
An IM adapter is Host code. The SDK does not receive external events.
This guide adds no SDK API, wire field or protocol type.
It does not change the K4 FIFO or K7 settlement in the [Host execution core guide](host-execution-core.md).
The rules come from issue #552, its plan in #557 and the owner's rulings of 2026-10-19 on that issue.
R6 also carries the owner's ruling of 2026-10-31 on issue #1230.
R1 to R7 are labels of this guide, for use in Host code and tests.

## 1. Ownership and records

| Record | Meaning | Authority |
| --- | --- | --- |
| Principal | The verified sender of one inbound message. Its kind is `human` or `bot`. | Channel adapter, from authenticated platform data. |
| Inbound message | Channel, conversation, platform message id, principal, text, mention entities and an optional reply route. | Host ledger. |
| Reply route | A platform credential that answers one inbound message. It has an expiry time. | Host ledger. |
| Push route | A platform target for one Host conversation. The owner enables it and can revoke it. | Host ledger. |
| Delivery | One final message on one route, with its state and attempt count. | Host outbox. |

A conversation is `direct` or `group`.
A direct conversation maps to one Bot's canonical conversation. A group maps to one room.
The adapter verifies and translates platform data.
The Host makes all authority, mention and retry decisions.

## 2. Rules

### R1. Separate reply and push routes

A reply credential must not become a long-term push target.

A reply route answers one inbound message.
Examples are a message id, `response_url`, `context_token` and `webhook_url`.
Only replies to that message can use the route.
A reply is Bot output that the message started in the same conversation, including a long-task continuation.
In the reference, that output has the same root budget as the input.
Output for a routine or for another input never uses the route.
Never copy a reply credential into the push route table.
Persist the route with the inbound message.
Keep its token out of ContextPack, projections and logs.
Delete the token when the route expires.
Also delete it when no Turn or seat of that root is open, and no delivery on the route is `pending` or `sending`.

A push route needs an explicit owner action. Push is off by default.
After revocation, the Host sends nothing more on that route.
A result that no inbound message started, such as a routine result, uses only the push route of its own conversation.
Without one, the Host shows the result only in the Host UI and records `no_push_route`.
A reply can be due after its reply route is no longer usable, for example at the end of a long task.
Then the Host uses the push route of the same conversation.
Without one, it shows the reply only in the Host UI and records `reply_route_expired`.
When the Host merges several inputs into one Turn, the reply uses the reply route of the newest member message.

### R2. Verified senders

A group member must not get owner authority.

Every inbound message carries a verified principal.
The adapter takes it from authenticated platform data.
That data is a verified webhook signature or an authenticated platform connection, plus the platform user id.
Display names and message text never identify a principal.
If the adapter cannot give a verified principal, the Host rejects the message and records `unverified_sender`.
Only an account that the owner linked in an authenticated Host session maps to the owner principal.

Authorization checks the principal of each action.
It never uses the conversation or the conversation owner instead.
Only the owner principal can:

- approve or reject a card;
- answer a question;
- cancel a Turn or a delegation, or end a delegation;
- start a 1:1 execution;
- enable or revoke a push route;
- resend an `unknown` delivery;
- change a group's `memberMentions` setting (R6).

In a 1:1 conversation, the Host rejects a non-owner human with `not_owner`.
In a group, any verified human can post. Only the owner can approve there.
These two rules are owner rulings of 2026-10-19.
A group also has a `memberMentions` setting that decides whether a non-owner mention opens a seat (R6).
Only the owner changes it.
The Host records each refusal in its audit.
An approval comes only from a platform button callback with a verified principal.
A text command such as `/approve` is not an approval.

### R3. Three delivery results

A timeout must not cause a blind resend.

A delivery result is `accepted`, `rejected` or `unknown`.
`accepted` means that the platform confirmed the message.
`rejected` means that the message did not arrive. The platform refused it or reported it absent, and no retry is left.
`unknown` means that the Host cannot know whether the message arrived.
The adapter reports a rejection only when the platform did not take the message.
The Host persists `sending` and the attempt count before each `send` call.
After that, a timeout, an exception or a lost connection gives `unknown`.
At startup, a delivery that is still `sending` becomes `unknown`.
The default send timeout is 15 seconds. The Host can change it.

The Host never resends an `unknown` delivery automatically.
Readback `absent` proves that the message did not arrive. The next send of the same delivery is then a retry.
The Host UI shows an `unknown` delivery as possibly not delivered.
The owner can resend it. A resend is a new delivery with a new id. The old record stays for audit.
This is an owner ruling of 2026-10-19.

Retry only an explicit retryable rejection, such as HTTP 429 with `Retry-After`.
A delivery makes at most three `send` calls.
Before each new attempt, wait for the larger of `Retry-After` and the backoff.
The backoff starts at one second and doubles.
If the wait is more than 60 seconds, the rejection is final.
A non-retryable rejection is final. The Host UI shows its code.

Each delivery has a stable id, for example `H(taskId, messageId, route)` for an Agent message.
Give it to the platform as an idempotency key when the platform supports one.
There is no end-to-end exactly-once delivery.
A manual resend has a new id. So it can show the message twice.
The delivery state is a Host record. Do not use the SDK message disposition `accepted | held | refused` for it.
That disposition belongs to the Agent message.

### R4. Final results only

Progress must not flood the conversation.

By default, the Host delivers only final content:

- an Agent message that the Host accepted through `messageEgress`;
- a room post that the Host applied from `speech`;
- a Host confirmation or question card.

The Host writes each delivery in the transaction that accepts its content.
Frames of the [Agent message draft lane](spec.md#agent-message-draft-lane) and [typed activity](spec.md#typed-bounded-activity-authority) are progress.
Progress is not a message (L1 in product PRD section 3). The Host does not send it to IM.

### R5. Bot messages start no work

Bots must not trigger each other through the channel.

A message from a bot principal starts no execution by default.
In a group, the Host stores it as background, like a message without a mention.
It creates no seat, even when it has mention entities.
In a 1:1 conversation, the Host records it only in the audit.
The Host does not discard bot messages at the entry.

An echo is a message from a bot account of this Host.
It is not input. The Host uses it only to reconcile a delivery.
Match an echo by an exact platform message id, or by a delivery id that the platform returns. Never match by text.
Before `send` returns, and after a timeout, only a delivery id that the platform returns can match.
Bots work together only through `delegate` ([ADR-038](architecture/adr-2026-10-13-bot-platform.md) decision 13).
That path deduplicates by `H(taskId, 'delegate', index)`. Its hop limit is four.
Each root has a Bot budget of 12 units ([Cross-Bot delegation](../examples/bot-collaboration/README.md#cross-bot-delegation)).

### R6. Structured mentions

Message text must not select a Bot.

Group mentions come only from the platform's mention entities.
The adapter maps each entity to a Bot id.
The Host never scans text for `@` names: I10 in [platform PRD section 5](researches/2026-10-13_bot-platform-prd.md)
and G1 in [product PRD section 3](plans/2026-10-18-bot-mode-product-prd.md).
Text such as "@Bot" without a mention entity selects no seat.

Each group has a Host setting `memberMentions` with the value `execute` or `ignore`.
The default is `execute`, the owner ruling of 2026-10-31 on issue #1230.
With `execute`, a mention entity from any verified human opens a seat.
With `ignore`, a mention entity from a human who is not the owner opens no seat.
The Host stores that message as background, as R5 does for a bot message.
It starts no seat, no device work and no BYOK key, and room history keeps it for later requests.
The owner's own mention opens seats as usual.
Only the owner changes the setting (R2).
A change never touches an open root or an existing seat.
It applies only to inbound messages that arrive after it.

### R7. Channel credentials

A channel secret must not reach a Bot. It must not be in the database as plain text.

Keep bot tokens and webhook secrets in a Host credential broker.
A device-local Host uses the OS credential store through `@byok-sdk/keys`,
like the [connector broker example](../examples/salesko-connector-broker/README.md).
Never store these secrets as plain text in the Host database.
Never put them in a Bot execution's toolset.
The reference already refuses MCP toolsets in Bot executions (A1 in product PRD section 3).
A new channel registration has status `unverified`.
It becomes `connected` only after a real platform probe succeeds.

## 3. Inbound classification

Classify each inbound message in this order. The first match wins.

| Condition | Result |
| --- | --- |
| No verified principal. | Reject. Audit `unverified_sender`. |
| The principal is a bot account of this Host. | Echo. Reconcile a matching delivery. No input. |
| Bot principal in a 1:1 conversation. | Audit only. No Turn. |
| Bot principal in a group. | Room background. No seat. |
| Owner principal in a 1:1 conversation. | User input for that Bot. |
| Other human principal in a 1:1 conversation. | Reject. Audit `not_owner`. |
| Human principal in a group. | Room input. Mention entities select seats, except a non-owner mention when the group setting is `ignore` (R6). The room message records the principal id as its sender. |

Use `H(channel, conversationId, platformMessageId)` as the input key.
A redelivered platform event then maps to the same input.
Some platforms make a message id unique only within one chat.
Room context rules do not change. A message without a mention is background.
A new member sees only later messages ([group chat](../examples/bot-collaboration/README.md#group-chat-and-main-bot)).
Button callbacks for cards, questions and cancellation follow the R2 owner check.

## 4. Delivery state machine

```text
pending --persist sending and attempts + 1--> sending
sending --platform accepts------------------> accepted
sending --matching echo---------------------> accepted
sending --retryable rejection, retry left---> pending, with nextAttemptAt
sending --other rejection, or no retry left-> rejected
sending --timeout, exception, lost link-----> unknown
sending --found at startup------------------> unknown
unknown --readback accepted, or echo--------> accepted
unknown --readback absent, retry left-------> pending, with nextAttemptAt
unknown --readback absent, no retry left----> rejected (attempts_exhausted)
unknown --owner resend----------------------> unknown, and a new delivery
```

- A retry is left when fewer than three `send` calls ran and the wait is at most 60 seconds.
- `accepted` and `rejected` are final.
- Only readback, an echo or a manual resend acts on `unknown`.
- `absent` means that the platform can prove that it did not receive the message.
- Readback is optional. Without it, `unknown` waits for an echo or the owner.

Like K4 `flushProjections`, the outbox uses durable rows and stable ids
([K4 guide section 8](host-execution-core.md#8-outcome-messages-and-upload)).
A projection receiver deduplicates by id. An IM platform often does not.
So a timeout gives `unknown`, not a resend.

## 5. Host checklist

- [ ] Take every principal from authenticated platform data. Reject a message without one.
- [ ] Map only an owner-linked account to the owner principal.
- [ ] Check the principal for each owner action, in 1:1 conversations and groups.
- [ ] Record each refused message and action in the audit.
- [ ] Accept approvals only from verified button callbacks.
- [ ] Derive the input key from channel, conversation and platform message id.
- [ ] Take mentions only from platform mention entities.
- [ ] Keep bot messages as background or audit. Use echoes only to reconcile deliveries.
- [ ] Keep an ignored non-owner group mention as background, and apply a setting change only to later messages.
- [ ] Bind each reply route to one inbound message, its root and its expiry.
- [ ] Keep reply tokens out of ContextPack, projections and logs.
- [ ] Never copy a reply credential into the push route table.
- [ ] Keep push off until the owner enables a route. Stop at revocation.
- [ ] Without a usable reply route, use only the push route of the same conversation. Without one, show the reply only in the Host UI and record `reply_route_expired`.
- [ ] Write each delivery in the transaction that accepts its content.
- [ ] Persist `sending` before each send. Record a timeout, an exception or a restart as `unknown`.
- [ ] Never resend `unknown` automatically. Offer a manual resend as a new delivery.
- [ ] Retry only explicit retryable rejections: at most three sends, and no wait over 60 seconds.
- [ ] Send only final content. Never send drafts or typed activity.
- [ ] Keep channel secrets in a credential broker, out of the database and Bot toolsets.
- [ ] Show `unverified` until a real probe succeeds.

## 6. Acceptance scope

The [Bot collaboration example](../examples/bot-collaboration/README.md#im-channel-input) implements the inbound classification of §3 and the M3 delivery outbox.
Its owner checks include push opt-in, revocation and manual resend.
It persists delivery rows with accepted content, commits sending before I/O, and maps sending to unknown at recovery.
Its fake-channel contract covers reply/push routing, rejection retry limits, uncertainty, readback, echoes and final-only delivery.
See `channelContract` in the example's `src/channel-contract.ts` for the reusable Host test harness.
Real platform adapters and their acceptance belong to the downstream Host.
This guide does not prove the reply, echo, idempotency or readback behavior of any platform.
Each adapter verifies these facts for its platform.
