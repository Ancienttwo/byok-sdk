import type { RuntimeCapabilities as ProtocolRuntimeCapabilities } from '@byok/protocol';
import type { RuntimeCapabilities } from '../types';

/**
 * Maps a `RuntimeAdapter`'s own internal `capabilities()` result
 * (`../types.ts`'s `RuntimeCapabilities` — `{steer, resume,
 * approvalInteractive, permissionModes}`, always-required fields) onto the
 * wire's `RuntimeCapabilities` shape (`@byok/protocol` — the same field names,
 * but all-optional).
 *
 * Every field, `approvalInteractive` included, is a pure passthrough of the
 * adapter's own self-report: the adapter is the single source of truth for
 * what its runtime can do, and this function does no interpretation of its
 * own. Previously `approvalInteractive` was hardcoded `false` at the sole
 * caller, which had gone stale — as of M4 Phase 3 claude genuinely does
 * support interactive approval, via `--permission-prompt-tool` routing
 * `ClaudeSession.resolveApproval` into the local out-of-process MCP approval
 * channel (`bin/byok-approval-mcp.ts`) under `policy.mode: 'confirm'` (see
 * docs/protocol.md §5.1/§11.2) — so the wire advertised a capability claim no
 * adapter owned. pi and codex report `false` for the same honest reason they
 * always did: neither has any notion of pausing for approval
 * (`resolveApproval()` throws unconditionally for both — see `../types.ts`'s
 * `Session.resolveApproval` doc comment).
 *
 * This lives in its own module, rather than beside either of its two callers,
 * because those two callers sit on opposite sides of an import edge:
 * `create-daemon.ts` imports `task-runner.ts`, so exporting the mapper from
 * `create-daemon.ts` would make `task-runner.ts` import back into it and close
 * a cycle. A leaf module with no local imports beyond `../types` is the one
 * place both can reach.
 *
 * The connection-level `interactive-approval` flag (`CAPABILITY_FLAGS`,
 * `@byok/protocol`) is a separate, connection-scoped signal and is NOT derived
 * from this: `create-daemon.ts`'s `computeCapabilities` keeps its own
 * semantics.
 */
export function toRuntimeInfoCapabilities(caps: RuntimeCapabilities): ProtocolRuntimeCapabilities {
  return {
    steer: caps.steer,
    resume: caps.resume,
    approvalInteractive: caps.approvalInteractive,
    permissionModes: caps.permissionModes,
  };
}
