import type { DaemonConfig } from '../../daemon/create-daemon';
import {
  executeInputPreparationRetirement,
  inspectInputPreparationNamespace,
  INPUT_PREPARATION_RETIREMENT_COMMAND,
  type InputPreparationNamespaceInspection,
  type InputPreparationRetirementResult,
} from '../../daemon/input-preparation-retirement';
import { connectControlClient } from '../control-client';
import { resolveStoreDir } from '../config';

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
 * operator action for the input-preparation record-version cut. Default is a
 * read-only inspection; `--yes` moves an older-version namespace into
 * `<storeDir>/input-preparation-retired/` with a manifest, and refuses
 * (typed, zero writes) whenever the daemon control socket is reachable.
 */
export async function runRetireInputPreparationCommand(
  config: DaemonConfig,
  options: RetireInputPreparationOptions = {},
): Promise<InputPreparationRetirementResult | { status: 'inspected'; inspection: InputPreparationNamespaceInspection }> {
  const log = options.log ?? ((line: string) => console.log(line));
  const storeDir = resolveStoreDir(config);
  if (!options.confirmed) {
    const inspection = await inspectInputPreparationNamespace(storeDir);
    if (options.json) log(JSON.stringify({ status: 'inspected', inspection }, null, 2));
    else {
      for (const line of inspectionLines(inspection)) log(line);
      log('dry run: nothing was written (pass --yes to retire)');
    }
    return { status: 'inspected', inspection };
  }

  const connectControl = options.connectControl ?? connectControlClient;
  const connection = await connectControl({ storeDir, productId: config.productId });
  // A completed authenticated handshake is itself proof a daemon owns this
  // store; the retirement refuses on it without asking anything further.
  if (connection.ok) connection.client.close();
  const result = await executeInputPreparationRetirement(storeDir, {
    confirmed: true,
    controlOnline: connection.ok,
    clock: options.clock,
  });
  if (options.json) {
    log(JSON.stringify(result, null, 2));
    return result;
  }
  for (const line of inspectionLines(result.inspection)) log(line);
  if (result.status === 'nothing-to-retire') log('retire: nothing to retire; nothing was written');
  else {
    log(`retire: moved namespace to ${result.retiredDir}; manifest=${result.manifestPath}`);
    log(`retire: records.jsonl sha256=${result.manifest.recordLog.sha256} bytes=${result.manifest.recordLog.sizeBytes}; artifacts=${result.manifest.artifacts.length}`);
  }
  return result;
}
