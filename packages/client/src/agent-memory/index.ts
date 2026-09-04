/**
 * `@byok-sdk/client/agent-memory` — the embedded-host composition surface for
 * Agent memory.
 *
 * A product that embeds this SDK instead of running the daemon (no second
 * control plane, no `control.sock`) already owns the pieces the daemon would
 * otherwise own for it: the canonical Agent home under `AGENT_HOME_DIRECTORY`,
 * the lease that pins it, and the signed/notarized macOS helper binary. What it
 * cannot own is the memory authority itself — the compare-and-swap semantics,
 * the audit record, the platform gate, and the exact path policy the model is
 * allowed to name. Those must stay in one place or two implementations drift.
 *
 * This entry therefore exports exactly the pieces `daemon/task-runner.ts`
 * composes for an in-daemon Agent task, minus the daemon:
 *
 * - `AgentMemoryService`             — task-scoped recall/save authority.
 * - `captureAgentMemorySnapshot`     — the post-close bounded snapshot.
 * - `openAgentMemoryFilesystemHelper`— admission of the host's macOS helper.
 * - `serveAgentMemoryMcpOverStdio`   — the two memory tools over stdio.
 * - `prependAgentMemoryGuidance`     — the prompt half of the path contract.
 *
 * Three things are deliberately absent, and this file is the record of why.
 *
 * 1. The control client. `connectControlClient`/`ControlClient` are not
 *    exported from this package at all (see `src/index.ts`) and must not become
 *    reachable here: they also carry `shutdown`, approval resolution, and the
 *    raw task-event stream. The shipped `byok-agent-memory-mcp` bin reaches the
 *    same service *through* that socket; an embedded host reaches it directly,
 *    which is the entire reason this entry exists.
 *
 * 2. The transport. Nothing reachable from this entry may import `ws`, the
 *    daemon composition, or any transport module. Importing a single memory
 *    symbol from the root entry drags daemon transport into a host
 *    bundle; the subpath exists so it does not. `__tests__/agent-memory-entry-
 *    constraints.test.ts` walks this module graph and `scripts/check-agent-
 *    memory-entry.mjs` re-checks the built bundle.
 *
 * 3. Hosted projection. `AgentMemoryRedactor`, `AgentMemoryProjectionPort`,
 *    `AgentMemoryHostedProjection` and `snapshotAndProjectAgentMemory` stay off
 *    this entry. Projection is a network surface, and a credential-blind
 *    transport for it does not exist yet; an embedded host gets the local
 *    snapshot and nothing that sends it anywhere.
 *
 * Platform semantics are unchanged by this entry, not re-stated in it: Linux
 * uses the native descriptor backend, macOS requires the host's external
 * helper, and Windows stays fail-closed. `isAgentMemorySecureFilesystemAvailable`
 * is the single gate a host consults before offering memory at all.
 */

/** Per-task memory authority: `recall`/`save` under sha256 compare-and-swap, bound to one exact active Agent task context. */
export { AgentMemoryService } from '../daemon/agent-memory';
/** Bounded, audited snapshot of the Agent's local memory files, taken after `Session.close()` while the home lease still exists. */
export { captureAgentMemorySnapshot } from '../daemon/agent-memory';
/** The single source of truth for which relative path a model may name: `MEMORY.md` or `notes/<safe-relative>.md`. */
export { validateAgentMemoryPath } from '../daemon/agent-memory';
/** The sole platform gate for the memory write authority: native Linux, macOS only with the host's helper, Windows never. */
export { isAgentMemorySecureFilesystemAvailable } from '../daemon/agent-memory';
/** Base failure for every rejected memory operation. */
export { AgentMemoryError } from '../daemon/agent-memory';
/** Compare-and-swap failure carrying the expected and actual content revisions. */
export { AgentMemoryRevisionConflictError } from '../daemon/agent-memory';

/** The exact active-task binding required to construct the service; every field is validated on each call. */
export type { AgentMemoryTaskContext } from '../daemon/agent-memory';
/** One memory file as the snapshot sees it: relative path, sha256 revision, byte count, content. */
export type { AgentMemoryFile } from '../daemon/agent-memory';
/** A bounded set of memory files plus their total byte count. */
export type { AgentMemorySnapshot } from '../daemon/agent-memory';
/** Result of `recall`, including the metadata-only audit warning when the audit write failed but the read did not. */
export type { AgentMemoryRecallResult } from '../daemon/agent-memory';
/** Result of `save`, distinguishing a replace (with new revision) from a delete. */
export type { AgentMemorySaveResult } from '../daemon/agent-memory';
/** Metadata-only signal that the audit record could not be written; the source operation still succeeded. */
export type { AgentMemoryAuditWarning } from '../daemon/agent-memory';

/** Whether this platform can admit an external filesystem helper at all (macOS only today). */
export { isAgentMemoryFilesystemHelperSupported } from '../daemon/agent-memory-fs-helper';
/** Admits the host's absolute signed/notarized helper binary and returns the root-pinned filesystem for one Agent home. */
export { openAgentMemoryFilesystemHelper } from '../daemon/agent-memory-fs-helper';

/** Root-bound filesystem authority the service operates through; the host supplies it only on macOS. */
export type { AgentMemoryFilesystem } from '../daemon/agent-memory-filesystem';
/** One file's state as reported by that filesystem authority. */
export type { AgentMemoryFilesystemFileState } from '../daemon/agent-memory-filesystem';
/** Product-owned deployment pointer to the helper binary; the SDK never searches PATH. */
export type { AgentMemoryFilesystemHelperConfig } from '../daemon/agent-memory-filesystem';

/** Serves `memory_recall`/`memory_save` as a stdio MCP server over host-provided streams. */
export { serveAgentMemoryMcpOverStdio } from '../bin/agent-memory-mcp-server';
/** MCP tool name a host must allowlist for reads. */
export { AGENT_MEMORY_RECALL_TOOL_NAME } from '../bin/agent-memory-mcp-server';
/** MCP tool name a host must allowlist for writes. */
export { AGENT_MEMORY_SAVE_TOOL_NAME } from '../bin/agent-memory-mcp-server';
/** The two calls the stdio server delegates to; an `AgentMemoryService` satisfies it directly. */
export type { AgentMemoryMcpDeps } from '../bin/agent-memory-mcp-server';

/** Runtime-neutral instructions telling the model how to use `MEMORY.md` and `notes/`. */
export { AGENT_MEMORY_GUIDANCE } from '../daemon/memory-guidance';
/** Prepends that guidance to an Agent instruction, exactly as the daemon's task runner does. */
export { prependAgentMemoryGuidance } from '../daemon/memory-guidance';

/** The validated Agent identity carried by `AgentMemoryTaskContext`. */
export type { AgentRef } from '../agent-home';
