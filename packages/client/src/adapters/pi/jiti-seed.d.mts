export const PI_JITI_SEED_DIR: string;
export const PI_JITI_SEED_FORMAT: string;
export const PI_JITI_SEED_VERSION: number;
export const PI_JITI_SEED_CANONICAL_ROOT: string;
export type PiJitiSeedGroup = 'parent' | 'runner' | 'host-peers';
export const PI_JITI_SEED_GROUPS: readonly PiJitiSeedGroup[];
export const PI_SUBAGENTS_PEERS_KEY: string;
export const PI_SUBAGENTS_HOST_KEY: string;
export function piSubagentHostPeersSource(specifiers: readonly string[]): string;
export function sha256(bytes: string | Uint8Array): string;
export function fileUrlLiteral(file: string): string;
export function piJitiFilename(jiti: { resolve(id: string): string }, file: string): string;
export function canonicalSeedFile(group: PiJitiSeedGroup, relative: string): string;

export interface PiJitiSeed {
  readonly digest: string;
  readonly cacheDir: string;
  /** Throws `pi_jiti_seed_unavailable` before writing anything when an input does not verify. */
  materialize(group: PiJitiSeedGroup, root: string): { readonly written: number; readonly kept: number };
}
export function openPiJitiSeed(seedRoot: string, loaderUrls: readonly string[]): PiJitiSeed;
export interface PiJitiSeedUse {
  /** Writes the group's private cache files, or turns the process cold. */
  materialize(group: PiJitiSeedGroup, root: string): void;
}
/** An absent seed root checks only the execution-private cache location. */
export function usePiJitiSeed(seedRoot: string | undefined, loaderUrls: readonly string[], report: (reason: string) => void): PiJitiSeedUse;
