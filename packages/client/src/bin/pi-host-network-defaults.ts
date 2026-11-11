import net from 'node:net';

/**
 * #1730: Node's 250 ms per-address attempt timeout aborts a working but slow
 * IPv4 connect after an unreachable IPv6 one. The Pi host owns its process, so
 * its entry sets the process-wide `net` default that global fetch uses; the
 * explicit call replaces any `--network-family-autoselection-attempt-timeout`.
 */
const PI_HOST_FAMILY_ATTEMPT_TIMEOUT_MS = 3000;

/** Every SDK-owned Pi host entry calls this before any provider connect. */
export function applyPiHostNetworkDefaults(): void {
  net.setDefaultAutoSelectFamilyAttemptTimeout(PI_HOST_FAMILY_ATTEMPT_TIMEOUT_MS);
}
