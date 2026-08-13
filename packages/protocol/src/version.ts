/**
 * Wire protocol version. Bump on breaking (non-additive) changes to the envelope
 * or message shapes. Additive changes (new optional fields, new message types)
 * do not require a bump — servers negotiate the highest common version and
 * daemons/servers must ignore unknown fields and unknown message types.
 *
 * FROZEN v1 (end of M2 — see docs/protocol.md "Freeze rule"): the pi, claude,
 * and codex runtime adapters have all exercised the wire, and every M1/M2
 * protocol gap has been closed. `PROTOCOL_VERSION` stays `1` from here
 * forward; it does not bump for additive changes (new optional fields, new
 * message types, new `AgentEvent` variants, new capability flags) — only for
 * a breaking one (changing, removing, or retyping anything that already
 * exists).
 *
 * IMPORTANT: changing this constant, or changing/removing/retyping any
 * already-frozen schema in this package, requires a DELIBERATE update to the
 * committed golden fixtures in `src/__tests__/golden/` (`v1.frozen.json`,
 * `v1.envelopes.ndjson`) — see `src/__tests__/freeze-guard.test.ts`, which
 * fails loudly on exactly that kind of drift. A passing freeze-guard run
 * after such a change means either (a) the change was genuinely additive and
 * the golden was regenerated with justification, or (b) this constant was
 * bumped alongside a new golden generation for the new version — never a
 * silent edit to either file to make the test pass.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Capability flags exchanged during the connection handshake (`conn.hello` /
 * `conn.ack`). Additional flags may be introduced without a protocol version
 * bump; unrecognized flags must be ignored by both sides.
 *
 * `interactive-approval` is RESERVED as of this addition: it gates the
 * (currently unexercised) approval seam — a server must not route an
 * approval-requiring policy to a daemon that hasn't advertised this flag. No
 * bundled runtime adapter emits it yet; that's expected until interactive
 * approval is actually wired up in a later wave.
 *
 * `approval_resolved` (additive-minor): a SERVER-advertised flag meaning
 * "I understand the `task.approval_resolved` message" (`messages.ts`). This
 * is the N/N-1 answer for that new daemon -> server message: an old server's
 * `CAPABILITY_FLAGS`/`conn.ack.capabilities` never includes it, so a new
 * daemon talking to an old server never sends `task.approval_resolved` at
 * all (see `packages/client`'s `task-runner.ts`) and falls back to the
 * pre-existing implicit-resume inference
 * (`ConnectionHub.resumeIfImplicitlyApproved`, `packages/server/src/hub.ts`)
 * unconditionally, exactly as before this flag existed. Unlike
 * `interactive-approval`, this one IS exercised the moment both sides
 * support it — there is no reserved/dormant period for it.
 */
/**
 * `approval-targeting` (M5, additive-minor): unlike `approval_resolved`
 * above, this flag is purely INFORMATIONAL/semantic, not a functional gate.
 * `task.await_approval`/`task.approve`/`task.reject` all carry their new
 * `approvalId` field UNCONDITIONALLY on both sides once each peer is
 * upgraded -- the wire is tolerant (a plain, non-`.strict()` `z.object()`
 * field, `messages.ts`), so no version/capability negotiation is needed just
 * to send it safely; an older peer that doesn't recognize the field simply
 * never reads it. Receivers decide whether to apply exact-match targeting
 * by FIELD PRESENCE on the specific message at hand (does this particular
 * `task.approve`/`task.reject`/`onApprovalResolved` payload carry an
 * `approvalId`, and does a stored one exist to compare it against?), never
 * by checking this flag -- see `ConnectionHub.approveTask`/`rejectTask`/
 * `onApprovalResolved` and `TaskRunner.handleApprove`/`handleReject`
 * (`packages/client`'s `task-runner.ts`). This flag exists only so each side
 * can advertise, and an embedder/operator can observe (`ConnectionHub.
 * getDeviceCapabilities`), whether the OTHER side is new enough to
 * participate in targeting at all -- the same N/N-1-safe shape as every
 * other flag here, just consumed for observability instead of gating.
 */
/**
 * `result-document` (additive-minor): a SERVER-advertised flag meaning "I
 * understand the optional `task.complete.document` field" (`messages.ts`).
 * Functionally gating, like `approval_resolved` and unlike
 * `approval-targeting`.
 *
 * This is the N/N-1 answer for that new daemon -> server FIELD. An old
 * server's `CAPABILITY_FLAGS`/`conn.ack.capabilities` never includes it, and
 * its `TaskCompletePayloadSchema` is a tolerant (non-`.strict()`)
 * `z.object()`, so a `document` sent to it would be silently STRIPPED on
 * parse and vanish without a trace. That is exactly why emission is gated
 * here rather than sent unconditionally the way `approvalId` is: `document`
 * carries the task's primary structured RESULT, so losing it silently is
 * data loss, not a missed observability hint. A new daemon talking to an old
 * server therefore never sends `document` at all, and — if its configured
 * extractor did produce one — reports `task.fail` (retryable: false; the
 * same server will strip it on every retry too) instead of completing the
 * task with its main result quietly deleted (`packages/client`'s
 * `task-runner.ts`). A new server talking to an old daemon is unaffected:
 * the field is optional, and an old daemon simply never sets it.
 *
 * `dispatch-selection` (additive-minor) is a correctness gate for the
 * optional `task.offer.dispatchSelection` control field. An older v1 daemon
 * legally strips unknown optional fields, so a server must never send an
 * authoritative provider/model selection unless the target connection
 * advertises this flag. Absence means reject before task creation, not send
 * a legacy runtime-only offer that could reach a different provider.
 *
 * `toolset-selection` (additive-minor) means the daemon understands
 * `task.offer_with_toolsets` and can resolve its logical ids against local
 * MCP configuration. The distinct message type is also the N/N-1 safety
 * boundary for long-poll: an older daemon skips it as unknown and therefore
 * cannot accidentally execute the instruction without the required tools.
 */
export const CAPABILITY_FLAGS = [
  'steer',
  'blob-upload',
  'interactive-approval',
  'approval_resolved',
  'approval-targeting',
  'result-document',
  'dispatch-selection',
  'toolset-selection',
] as const;

export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number];
