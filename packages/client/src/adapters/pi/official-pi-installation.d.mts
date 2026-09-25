import type { ToolImplementationNativeProvenanceV1 } from '@byok-sdk/implementation-identity';
export const OFFICIAL_PI_PROVENANCE: Readonly<ToolImplementationNativeProvenanceV1>;
export const OFFICIAL_PI_PACKAGES: readonly string[];
export function locateOfficialPiPackage(name: string, from: string): string;
export function verifyOfficialPiPackage(root: string, name: string): Record<string, unknown>;
export function verifyOfficialPiClosure(from: string): { provenance: Readonly<ToolImplementationNativeProvenanceV1>; roots: {root: string; name: string}[] };
export function assertOfficialPiProvenance(value: unknown): void;

export function assertOfficialPiManifest(bytes: Uint8Array): void;
