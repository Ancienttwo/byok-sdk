/** Local Agent application-release identity. It is observability data, never a protocol or capability gate. */
export interface LocalAgentReleaseIdentity {
  /** Canonical strict SemVer owned by the final Local Agent distribution. */
  version: string;
  /** Optional bounded build/content identity owned by the same distribution. */
  buildId?: string;
}

export const LOCAL_AGENT_RELEASE_VERSION_MAX_LENGTH = 128;
export const LOCAL_AGENT_RELEASE_BUILD_ID_MAX_LENGTH = 128;

// SemVer 2.0.0: core numeric identifiers cannot have leading zeroes;
// prerelease numeric identifiers have the same rule; build identifiers may.
const STRICT_SEMVER_PATTERN = new RegExp(
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)' +
    '(?:-(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)' +
    '(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*)?' +
    '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
);
const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Validates, copies, and freezes a release identity at a composition boundary.
 * No normalization is performed: non-canonical input is rejected instead of
 * being rewritten into another authority.
 */
export function resolveLocalAgentReleaseIdentity(
  input: LocalAgentReleaseIdentity | undefined,
): Readonly<LocalAgentReleaseIdentity> {
  if (
    input === undefined ||
    typeof input.version !== 'string' ||
    input.version.length > LOCAL_AGENT_RELEASE_VERSION_MAX_LENGTH ||
    !STRICT_SEMVER_PATTERN.test(input.version)
  ) {
    throw new Error('DaemonConfig.localAgentRelease.version must be canonical strict SemVer');
  }
  if (
    input.buildId !== undefined &&
    (typeof input.buildId !== 'string' ||
      input.buildId.length > LOCAL_AGENT_RELEASE_BUILD_ID_MAX_LENGTH ||
      !BUILD_ID_PATTERN.test(input.buildId))
  ) {
    throw new Error(
      `DaemonConfig.localAgentRelease.buildId must be 1-${LOCAL_AGENT_RELEASE_BUILD_ID_MAX_LENGTH} safe opaque characters`,
    );
  }
  return Object.freeze({
    version: input.version,
    ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
  });
}
