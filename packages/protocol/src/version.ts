/**
 * Wire protocol version. Bump on breaking (non-additive) changes to the envelope
 * or message shapes. Additive changes (new optional fields, new message types)
 * do not require a bump — servers negotiate the highest common version and
 * daemons/servers must ignore unknown fields and unknown message types.
 *
 * Still `1` through M1: the wire is pre-freeze until the claude/codex
 * runtime adapters (M2) have both exercised it, per the plan. Breaking
 * changes are still allowed pre-freeze (this is why the M1 protocol gaps —
 * see docs/protocol.md — were fixed in place rather than added
 * additively). Freeze target: end of M2.
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
 */
export const CAPABILITY_FLAGS = ['steer', 'blob-upload', 'interactive-approval'] as const;

export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number];
