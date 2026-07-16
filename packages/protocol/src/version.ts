/**
 * Wire protocol version. Bump on breaking (non-additive) changes to the envelope
 * or message shapes. Additive changes (new optional fields, new message types)
 * do not require a bump — servers negotiate the highest common version and
 * daemons/servers must ignore unknown fields and unknown message types.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Capability flags exchanged during the connection handshake (`conn.hello` /
 * `conn.ack`). Additional flags may be introduced without a protocol version
 * bump; unrecognized flags must be ignored by both sides.
 */
export const CAPABILITY_FLAGS = ['steer', 'blob-upload'] as const;

export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number];
