export interface SuggestedRuntimeVersionEntry {
  readonly version: string;
  readonly reason: string;
  readonly verifiedAt?: string;
  readonly evidence?: string;
}

export interface SuggestedRuntimeVersionsManifest {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly runtimes: Readonly<Record<string, SuggestedRuntimeVersionEntry>>;
}

export interface SuggestedRuntimeVersionAdvice {
  readonly runtime: string;
  readonly installedVersion: string;
  readonly suggestedMinVersion: string;
  readonly reason: string;
}

/** OAR's live manifest URL for Host-managed refreshes. */
export declare const SUGGESTED_RUNTIME_VERSIONS_URL: string;
/** The snapshot bundled with the SDK. */
export declare const suggestedRuntimeVersions: SuggestedRuntimeVersionsManifest;
/** Validate decoded JSON. Reject an invalid document and drop invalid runtime rows. */
export declare function parseSuggestedRuntimeVersions(raw: unknown): SuggestedRuntimeVersionsManifest | null;
/** Advise when the installed version is readable and strictly below the suggested minimum. */
export declare function checkSuggestedRuntimeVersion(
  runtimeId: string,
  installedVersion: string | undefined,
  manifest?: SuggestedRuntimeVersionsManifest,
): SuggestedRuntimeVersionAdvice | null;
