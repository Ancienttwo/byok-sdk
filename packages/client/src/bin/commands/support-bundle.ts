import path from 'node:path';
import type { DaemonConfig } from '../../index';
import { createSupportBundle, writeSupportBundle } from '../../diagnostics/support-bundle';
import type { CollectDiagnosticsOptions } from '../../diagnostics/diagnostics';
import { resolveStoreDir } from '../config';

export interface SupportBundleOptions extends CollectDiagnosticsOptions {
  outputPath: string;
  log?: (line: string) => void;
}

export async function runSupportBundleCommand(config: DaemonConfig, options: SupportBundleOptions): Promise<void> {
  if (!options.outputPath) throw new Error('support-bundle requires --output <path>');
  const outputPath = path.resolve(options.outputPath);
  const bundle = await createSupportBundle(config, resolveStoreDir(config), options);
  await writeSupportBundle(outputPath, bundle);
  const log = options.log ?? ((line: string) => console.log(line));
  log(`support bundle written: ${outputPath}`);
  log(`redaction policy: ${bundle.redaction.policy}; omitted=${bundle.redaction.omitted.length}; transformed=${bundle.redaction.transformed.length}`);
}
