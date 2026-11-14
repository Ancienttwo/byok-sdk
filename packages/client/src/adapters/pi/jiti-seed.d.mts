export const PI_JITI_SEED_DIR: string;
export const PI_JITI_SEED_FORMAT: string;
export const PI_JITI_SEED_VERSION: number;
export const PI_JITI_SEED_CANONICAL_ROOT: string;
export const PI_JITI_SEED_BASES: readonly ['pi-subagents', 'host-peers'];
export const PI_SUBAGENTS_PEERS_KEY: string;
export const PI_SUBAGENTS_HOST_KEY: string;
export function piSubagentHostPeersSource(specifiers: readonly string[]): string;
export function sha256(bytes: string | Uint8Array): string;
export function fileUrlLiteral(file: string): string;
export function canonicalSeedFile(base: string, relative: string): string;

export interface PiJitiSeed {
  readonly digest: string;
  readonly cacheDir: string;
  /** Returns the number of private cache files written; throws `pi_jiti_seed_unavailable`. */
  materialize(base: (typeof PI_JITI_SEED_BASES)[number], root: string): number;
}
export function openPiJitiSeed(seedRoot: string, loaderUrl: string | undefined): PiJitiSeed;
