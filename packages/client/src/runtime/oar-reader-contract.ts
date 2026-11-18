import type { spawnOwnedLineProcess } from './owned-line-process.js';
import type { RuntimeModelCatalog, RuntimeAccountUsage, RuntimeUnsupportedVersion } from './runtime-reader-types.js';

export interface ReaderCommandOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ReaderCommandResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface OwnedReaderOptions extends ReaderCommandOptions {
  readonly spawn: typeof spawnOwnedLineProcess;
  readonly run: (command: string, args: readonly string[], options: ReaderCommandOptions) => Promise<ReaderCommandResult>;
  readonly redact: (text: string) => string;
}

export interface ReaderInstallation {
  readonly kind: 'available';
  readonly via: 'executable';
  readonly command: string;
  readonly version?: string;
}

export interface DshReaderLaunch {
  readonly directory: string;
  readonly patches: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export type ModelReader = (installation: ReaderInstallation, options: OwnedReaderOptions) => Promise<RuntimeModelCatalog>;
export type UsageReader = (installation: ReaderInstallation, options: OwnedReaderOptions) => Promise<RuntimeAccountUsage>;
export type VersionRefusal = RuntimeUnsupportedVersion & { readonly kind: 'unsupported'; readonly code: 'version_unsupported'; readonly reason: string };