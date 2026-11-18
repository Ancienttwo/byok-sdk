import type { RuntimeModelCatalog } from './runtime-reader-types.js';
import type { DshReaderLaunch, ModelReader, UsageReader, VersionRefusal, ReaderInstallation, OwnedReaderOptions } from './oar-reader-contract.js';

export declare const codexListModels: ModelReader;
export declare const codexAccountUsage: UsageReader;
export declare const claudeListModels: ModelReader;
export declare const claudeAccountUsage: UsageReader;
export declare function dshListModels(installation: ReaderInstallation, options: OwnedReaderOptions, launch: DshReaderLaunch): Promise<RuntimeModelCatalog>;
export declare const opencodeListModels: ModelReader;
export declare const antigravityAccountUsage: UsageReader;
export declare function antigravityVersionRefusal(version: string | undefined): VersionRefusal | null;
export declare function dshVersionUnsupported(version: string | undefined): VersionRefusal | null;
