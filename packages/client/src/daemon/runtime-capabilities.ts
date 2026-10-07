import type { RuntimeCapabilities as ProtocolRuntimeCapabilities } from '@byok-sdk/protocol';
import type { RuntimeCapabilities } from '../types';

/**
 * Maps a frozen `RuntimeAdapterDescriptor`'s internal `capabilities` value
 * (`../types.ts`'s `RuntimeCapabilities` — `{steer, resume,
 * approvalInteractive}`, always-required fields) onto the
 * wire's `RuntimeCapabilities` shape (`@byok-sdk/protocol` — the same field names,
 * but all-optional).
 *
 * Every field, `approvalInteractive` included, is a pure passthrough of the
 * adapter's own self-report: the adapter is the single source of truth for
 * what its runtime can do, and this function does no interpretation of its
 * own. All bundled adapters currently report approvalInteractive: false;
 * third-party adapters remain responsible for their own support declaration.
 *
 * This lives in its own module, rather than beside either of its two callers,
 * because those two callers sit on opposite sides of an import edge:
 * `create-daemon.ts` imports `task-runner.ts`, so exporting the mapper from
 * `create-daemon.ts` would make `task-runner.ts` import back into it and close
 * a cycle. A leaf module with no local imports beyond `../types` is the one
 * place both can reach.
 *
 * The connection-level `interactive-approval` flag (`CAPABILITY_FLAGS`,
 * `@byok-sdk/protocol`) is a separate, connection-scoped signal and is NOT derived
 * from this: `create-daemon.ts`'s `computeCapabilities` keeps its own
 * semantics.
 */
export function toRuntimeInfoCapabilities(caps: RuntimeCapabilities): ProtocolRuntimeCapabilities {
  return {
    steer: caps.steer,
    resume: caps.resume,
    approvalInteractive: caps.approvalInteractive,
    ...(caps.mcpToolsets === undefined ? {} : { mcpToolsets: caps.mcpToolsets }),
  };
}
