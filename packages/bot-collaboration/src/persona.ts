import { createAgentHomeProjectionConsumer } from '@byok-sdk/client';
import { hash } from '@byok-sdk/server/execution-core';

/** Install on the daemon. SDK supplies the canonical home, writer lease and atomic file write. */
export function createBotPersonaProjection() {
  return createAgentHomeProjectionConsumer(async ({ projection, projectionHash, writeHomeFile }) => {
    if (!projection || typeof projection !== 'object' || !('schemaVersion' in projection)
      || projection.schemaVersion !== 'bot-profile.v1' || !('persona' in projection) || typeof projection.persona !== 'string'
      || projectionHash !== `sha256:${hash(projection)}`) throw new Error('Invalid Bot persona projection');
    await writeHomeFile('AGENTS.md', projection.persona);
  });
}
