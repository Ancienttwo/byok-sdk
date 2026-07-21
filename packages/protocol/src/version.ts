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
export const CAPABILITY_FLAGS = ['steer', 'blob-upload', 'interactive-approval', 'approval_resolved'] as const;

export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number];
