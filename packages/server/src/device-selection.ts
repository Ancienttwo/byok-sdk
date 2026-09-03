import { STRICT_AGENT_ONLY_CAPABILITY, type ToolsetId } from '@byok-sdk/protocol';

/**
 * Ambient device selection for a `dispatch()` that named no `deviceId`.
 *
 * `DispatchInput.deviceId` stays optional (ADR-034), so this rule survives the
 * fold. It is a SCHEDULING convenience and nothing more: every admission gate
 * that actually protects something — Agent capability, strict-agent-only,
 * egress, toolset selection — runs afterwards against the durable device row
 * inside the kernel, on the device this picked exactly as on one the caller
 * named. Picking wrong therefore costs a refusal, never a wrongly-authorized
 * dispatch.
 *
 * "First connected" means first OBSERVED (`connections.ts` preserves
 * first-observation order), which is stable and explainable, unlike any
 * load-shaped ordering this package has no information to compute.
 */
export interface DeviceCandidate {
  readonly deviceId: string;
  /** The durable capability list from the device's last accepted `conn.hello`. */
  readonly capabilities: readonly string[] | undefined;
  /** The logical toolset inventory the same announcement reported, if any. */
  readonly configuredToolsets: readonly ToolsetId[] | undefined;
}

export interface AmbientSelectionQuery {
  /** Every toolset must be present; an unknown inventory is never guessed at. */
  readonly requiredToolsets?: readonly ToolsetId[];
  /** Agent-bound dispatch is the only caller allowed to land on a strict-agent-only device. */
  readonly allowStrictAgentOnly?: boolean;
}

export function pickFirstConnectedDevice(
  candidates: readonly DeviceCandidate[],
  query: AmbientSelectionQuery = {},
): string | undefined {
  for (const candidate of candidates) {
    if (query.allowStrictAgentOnly !== true && candidate.capabilities?.includes(STRICT_AGENT_ONLY_CAPABILITY)) {
      continue;
    }
    if (query.requiredToolsets === undefined) return candidate.deviceId;
    // A device that never advertised toolset selection, or never reported an
    // inventory at all, is skipped rather than assumed adequate: "unknown" is
    // not "has them", and guessing here would send a task to a device that
    // fails it locally.
    if (!candidate.capabilities?.includes('toolset-selection')) continue;
    if (candidate.configuredToolsets === undefined) continue;
    const configured = new Set(candidate.configuredToolsets);
    if (query.requiredToolsets.every((toolsetId) => configured.has(toolsetId))) return candidate.deviceId;
  }
  return undefined;
}
