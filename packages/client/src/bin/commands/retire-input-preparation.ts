import type { DaemonConfig } from '../../daemon/create-daemon';
import {
  runInputPreparationRetirement,
  INPUT_PREPARATION_RETIREMENT_COMMAND,
  type InputPreparationNamespaceInspection,
  type RetireInputPreparationResult,
} from '../../daemon/input-preparation-retirement';
import type { connectControlClient } from '../control-client';

export interface RetireInputPreparationOptions {
  /** `--yes`: execute. Without it the command only inspects and writes nothing. */
  confirmed?: boolean;
  json?: boolean;
  clock?: () => Date;
  log?: (line: string) => void;
  connectControl?: typeof connectControlClient;
}

function inspectionLines(inspection: InputPreparationNamespaceInspection): string[] {
  const versions = Object.entries(inspection.versionCounts).map(([version, count]) => `v${version}=${count}`).join(' ');
  return [
    `${INPUT_PREPARATION_RETIREMENT_COMMAND}: namespace=${inspection.namespacePath} status=${inspection.status}`,
    `records: lines=${inspection.lineCount} parsed=${inspection.recordCount} versions=${versions || '(none)'} pinned=${inspection.pinnedRecordCount}`,
    `unparseable-lines: ${inspection.unparseableLines.length === 0 ? '(none)' : inspection.unparseableLines.join(',')}`,
    `artifacts: files=${inspection.artifactFileCount}`,
    ...(inspection.unexpectedEntries.length > 0 ? [`unexpected-entries: ${inspection.unexpectedEntries.join(',')}`] : []),
  ];
}

/**
 * `byok-agent retire-input-preparation [--yes] [--json]` — the bounded
 * operator action for the input-preparation record-version cut. It only
 * renders the result of the library `retireInputPreparation` (one
 * implementation): default is the read-only `preview`; `--yes` is `execute`,
 * which moves an older-version namespace into
 * `<storeDir>/input-preparation-retired/` with a manifest and refuses (typed,
 * zero writes) whenever the daemon control socket is reachable or the owner
 * lease is held.
 */
export async function runRetireInputPreparationCommand(
  config: DaemonConfig,
  options: RetireInputPreparationOptions = {},
): Promise<RetireInputPreparationResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const result = await runInputPreparationRetirement(
    { productId: config.productId, ...(config.storeDir === undefined ? {} : { storeDir: config.storeDir }) },
    options.confirmed ? { mode: 'execute', confirmed: true } : { mode: 'preview' },
    {
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.connectControl === undefined ? {} : { connectControl: options.connectControl }),
    },
  );
  if (options.json) {
    log(JSON.stringify(result, null, 2));
    return result;
  }
  for (const line of inspectionLines(result.inspection)) log(line);
  if (result.status === 'inspected') log('dry run: nothing was written (pass --yes to retire)');
  else if (result.status === 'nothing-to-retire') log('retire: nothing to retire; nothing was written');
  else {
    log(`retire: moved namespace to ${result.retiredDir}; manifest=${result.manifestPath}`);
    log(`retire: records.jsonl sha256=${result.manifest.recordLog.sha256} bytes=${result.manifest.recordLog.sizeBytes}; artifacts=${result.manifest.artifacts.length}`);
  }
  return result;
}
