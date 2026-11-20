import type { VersionRefusal } from './oar-reader-contract.js';

export declare function antigravityVersionRefusal(version: string | undefined): VersionRefusal | null;
export declare function compareSemver(left: string, right: string): number | null;
export declare function dshVersionUnsupported(version: string | undefined): VersionRefusal | null;
