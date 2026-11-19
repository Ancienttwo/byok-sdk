import { createAgentHomeProjectionConsumer, type AgentHomeProjectionApplyInput } from '@byok-sdk/client';
import { hash } from '@byok-sdk/server/execution-core';

/** Validated persona and SDK projection metadata, supplied while the writer lease is held. */
export interface BotPersonaProjectionContext {
  readonly agentRef: AgentHomeProjectionApplyInput['agentRef'];
  readonly canonicalHome: string;
  readonly requestId: string;
  readonly projectionHash: string;
  readonly projection: { readonly schemaVersion: 'bot-profile.v1'; readonly persona: string };
}

export interface BotPersonaProjectionOptions {
  /**
   * Additional root files, atomically written through the SDK. `AGENTS.md` is reserved for the persona.
   * Files omitted on a later projection remain in the home; the SDK does not delete them.
   */
  readonly renderAdditionalFiles?: (input: BotPersonaProjectionContext) =>
    readonly { name: string; body: string | Uint8Array }[] | Promise<readonly { name: string; body: string | Uint8Array }[]>;
  /**
   * Runs after all file writes under the same lease, for side effects outside the home only.
   * Do not write to canonicalHome here; home files must go through renderAdditionalFiles and writeHomeFile.
   * Exact revision/hash replays call this again, so it must be idempotent.
   */
  readonly afterWrite?: (input: BotPersonaProjectionContext) => void | Promise<void>;
}

/**
 * Install on the daemon. The SDK supplies the canonical home, writer lease and atomic file writes.
 * Each file is atomic individually; the files and afterWrite do not form a transaction. Both callbacks run again on exact replays.
 */
export function createBotPersonaProjection(options: BotPersonaProjectionOptions = {}) {
  return createAgentHomeProjectionConsumer(async ({ projection, projectionHash, writeHomeFile, agentRef, canonicalHome, requestId }) => {
    if (!projection || typeof projection !== 'object' || !('schemaVersion' in projection)
      || projection.schemaVersion !== 'bot-profile.v1' || !('persona' in projection) || typeof projection.persona !== 'string'
      || projectionHash !== `sha256:${hash(projection)}`) throw new Error('Invalid Bot persona projection');
    const context: BotPersonaProjectionContext = { agentRef, canonicalHome, requestId, projectionHash,
      projection: projection as BotPersonaProjectionContext['projection'] };
    const files = options.renderAdditionalFiles ? await options.renderAdditionalFiles(context) : [];
    if (files.some(file => file.name.toLowerCase() === 'agents.md')) throw new Error('AGENTS.md is reserved for the Bot persona');
    await writeHomeFile('AGENTS.md', projection.persona);
    for (const file of files) await writeHomeFile(file.name, file.body);
    if (options.afterWrite) await options.afterWrite(context);
  });
}
