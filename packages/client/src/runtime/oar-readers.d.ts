import type { RuntimeAccountUsage, RuntimeAccountUsageOptions, RuntimeModelCatalog } from './runtime-reader-types.js';
import type { DshReaderLaunch, ModelReader, UsageReader, ReaderInstallation, OwnedReaderOptions } from './oar-reader-contract.js';

export declare const codexListModels: ModelReader;
export declare const codexAccountUsage: UsageReader;
export declare const claudeListModels: ModelReader;
export declare const claudeAccountUsage: UsageReader;
export declare function dshListModels(installation: ReaderInstallation, options: OwnedReaderOptions, launch: DshReaderLaunch): Promise<RuntimeModelCatalog>;
export declare const opencodeListModels: ModelReader;
export declare function antigravityAccountUsage(installation: ReaderInstallation, options: OwnedReaderOptions & Pick<RuntimeAccountUsageOptions, 'allowPrintMode'>): Promise<RuntimeAccountUsage>;
