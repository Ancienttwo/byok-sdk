/** The official Pi release the prepared lane's runtime identity names. */
export interface OfficialPiProvenance {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly tarballIntegrity: string;
  readonly provenanceDigest: string;
  readonly closureDigest: string;
  readonly upstreamCommit: string;
  readonly compilerVersion: number;
}
export const OFFICIAL_PI_PROVENANCE: Readonly<OfficialPiProvenance>;
