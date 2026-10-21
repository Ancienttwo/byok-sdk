import { createHash } from 'node:crypto';
import type { AgentHomeManager, AgentRef } from '../agent-home';
import { captureAgentMemoryHomeSnapshot, AgentMemoryValidationError, type AgentMemorySnapshot } from './agent-memory';
import { openAgentMemoryFilesystemHelper } from './agent-memory-fs-helper';
import type { AgentMemoryFilesystem } from './agent-memory-filesystem';

/** Raw local-only Host result. Never send this through the redacted projection port. */
export interface AgentMemoryExport extends AgentMemorySnapshot {
  /** Validated Host request, not proof of a globally current profile revision. */
  readonly requestedAgentRef: AgentRef;
  /** Present only when the home has a durable applied profile projection. */
  readonly appliedProfileRevision?: string;
  /** sha256 of UTF-8 JSON ["byok-agent-memory-export.v1", [[path, revision, byteCount], ...]]. */
  readonly snapshotDigest: string;
}
export interface AgentMemoryExportOptions { readonly signal?: AbortSignal; }

/** Internal composition: only the daemon's explicit opt-in exposes this operation. */
export async function exportAgentMemoryHome(
  homes: AgentHomeManager,
  agentRef: AgentRef,
  options: AgentMemoryExportOptions = {},
  helper?: { readonly bin: string; readonly assetRoot?: string },
): Promise<AgentMemoryExport> {
  options.signal?.throwIfAborted();
  const binding = await homes.acquire(agentRef);
  let filesystem: AgentMemoryFilesystem | undefined;
  try {
    options.signal?.throwIfAborted();
    const projected = await homes.readAppliedProjection(binding);
    if (projected !== undefined && projected.profileRevision !== binding.resolution.agentRef.profileRevision) {
      throw new AgentMemoryValidationError('Agent memory export profile revision does not match the applied home projection');
    }
    await homes.initializeTaskFree(binding);
    options.signal?.throwIfAborted();
    if (helper !== undefined) filesystem = await openAgentMemoryFilesystemHelper({
      helperBin: helper.bin, assetRoot: helper.assetRoot,
      canonicalHome: binding.lease.canonicalHome, homeIdentity: binding.lease.homeIdentity,
    });
    const snapshot = await captureAgentMemoryHomeSnapshot({
      canonicalHome: binding.lease.canonicalHome, homeIdentity: binding.lease.homeIdentity,
      ...(filesystem === undefined ? {} : { filesystem }),
    }, options.signal);
    const tree = ['byok-agent-memory-export.v1', snapshot.files.map(file => [file.path, file.revision, file.byteCount])];
    return Object.freeze({ ...snapshot, requestedAgentRef: binding.resolution.agentRef,
      ...(projected === undefined ? {} : { appliedProfileRevision: projected.profileRevision }),
      snapshotDigest: `sha256:${createHash('sha256').update(JSON.stringify(tree), 'utf8').digest('hex')}` });
  } finally {
    try { await filesystem?.close(); }
    finally { await binding.lease.release(); }
  }
}
