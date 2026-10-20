# Octop M3 delivery outbox execution

Base: origin/main d3e71375bf4acb007b1974f8ef08bebeecb4e3aa. Refs #552.
Source: #557 plan section 5.6 M3. M2 is merged in #569.

## P1 / P2 / P3

- P1: changes stay in examples/bot-collaboration and Host documentation. The ledger is a single-owner SQLite reference. ChannelPort is the external boundary.
- P2: receive binds an authenticated inbound route to its input root. consumeMessage accepts a final Agent message before terminal. The acceptance transaction must also create the delivery. process claims pending rows before external send.
- P3: preserve K4/K7 and exact Agent-message acceptance. Persist sending and increment attempts before send. An exception, deadline, or restart gives unknown. Only explicit retryable rejection or authoritative absent readback permits another send. accepted/rejected stay final.

The owner confirmed that the plan's 15-second business send deadline is required. Test deadlines must remain unchanged.

## Implementation units

1. Pure state and types. Own channel.ts, delivery.ts, delivery.test.ts. Add route/port/delivery types and exact echo classification. Implement pure transitions with a three-attempt cap, 1s exponential backoff, Retry-After and a 60s maximum wait. Reject waits above the cap instead of sending early. No I/O in these transitions.
2. Host routing and persistence. Own model.ts, host.ts, delivery-routing.ts and index.ts. Keep routes separate from ContextPack and projections. BotOptions.channel holds a ChannelPort, per-channel self bot principal IDs, and optional sendTimeoutMs. Only owner APIs enable/revoke push or manually resend unknown with a new ID. receive must save inbound/root binding before process can send. Coalesced replies select the latest member route. Routine output only uses its own conversation's opted-in push route.
3. Channel contract and Host tests. Add fake ChannelPort cases for acceptance, timeout/exception unknown with one send, 429 Retry-After, final rejection, echo with exact IDs and verified self account, readback accepted/absent/unsupported, no push routine, no draft/activity, revocation, token cleanup, atomic first acceptance, concurrent drains and durable sending recovery. Keep old assertions unchanged. Export a reusable channelContract test factory.
4. Documentation and acceptance. Update the Host IM guide and example README. Run focused and existing example tests, then the five root checks. Run an independent read-only review of implementation and tests. Self-review before commit. Push and open a Draft PR with Refs #552. No merge or force-push.

## API and invariants

- Conversation: direct Bot id or group room id.
- ReplyRoute: kind reply, channel, inboundId (platform inbound message id), token, expiresAt.
- PushRoute: kind push, id, conversation, channel, target, optedInBy, optedInAt, optional revokedAt.
- Delivery: id, taskId, messageId, body, conversation, channel, route reference, state, attempts, optional nextAttemptAt/platformMessageId/code/resendOf.
- Reply route references in the ledger use the Host inbound key H(channel, conversation id, platform message id). The ChannelPort still receives the original platform inboundId.
- Echo matching requires a verified bot principal listed in channel.self for that channel. It must match conversation/channel and an exact delivery ID or already-known platform message ID. No text matching.
- Reply tokens are removed at expiry, or when the root has no open Turn/seat and no pending/sending delivery on that route. Unknown keeps metadata for reconciliation, not a reply credential.
- A failed or expired route never turns into push credentials. A new delivery can use a separately opted-in push route of the same conversation.
- One Host instance owns one ledger tenant. Recovery runs before serving work. Recovery maps sending to unknown and never blindly retries it.

## Verification record

Implementation is present. Old test assertions are unchanged. The new fixture waits for the real runtime start receipt; it adds no test deadline.

The independent review found a late-echo race after absent readback. Pure-state and real-Host regression tests failed before the fix and passed after it. An already-attempted pending delivery now accepts its exact verified echo and cancels the queued retry. A never-sent pending row still rejects an echo.

The final focused run passed: 4 files, 52 tests. It includes the old classification cases, pure transitions, route boundaries, real final/card/question delivery, room post/pass, durable recovery and the late-echo regression.

A real-ledger boundary test also caught a retry wake while channel configuration was absent. The Host now leaves those rows dormant instead of scheduling a retry loop. The regression failed before the guard and passed after it.

The example typecheck and root build passed. The other root checks are in progress. Final results will be recorded in the Draft PR. Logs and other scratch stay in this worktree or /tmp.
