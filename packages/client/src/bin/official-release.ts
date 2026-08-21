import { resolveLocalAgentReleaseIdentity } from '../release-identity';

/** Replaced from packages/client/package.json by tsup/vitest configuration; never read at runtime. */
declare const __BYOK_CLIENT_PACKAGE_VERSION__: string;

export const OFFICIAL_LOCAL_AGENT_RELEASE = resolveLocalAgentReleaseIdentity({
  version: __BYOK_CLIENT_PACKAGE_VERSION__,
});
