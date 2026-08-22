import type { DaemonConfig } from '../../daemon/create-daemon';
import type { ControlStatusResult } from '../../daemon/control-protocol';
import type { McpToolsetReloadReceipt } from '../../types';
import { connectControlClient } from '../control-client';
import { resolveStoreDir } from '../config';
import { formatToolsetsReloadReceiptLines } from '../format';

export interface ToolsetsReloadDeps {
  log?: (line: string) => void;
  connectControl?: typeof connectControlClient;
}

/** Reload from the CLI host's already-loaded config; the daemon never receives a pathname. */
export async function runToolsetsReloadCommand(
  config: DaemonConfig,
  deps: ToolsetsReloadDeps = {},
): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const connectControl = deps.connectControl ?? connectControlClient;
  const conn = await connectControl({ storeDir: resolveStoreDir(config), productId: config.productId });
  if (!conn.ok) throw new Error(`toolset reload requires a running daemon: ${conn.reason}`);
  try {
    const status = await conn.client.request<ControlStatusResult>('status');
    const receipt = await conn.client.request<McpToolsetReloadReceipt>('toolsets.reload', {
      expectedRevision: status.toolsets.revision,
      mcpToolsets: config.mcpToolsets ?? {},
    });
    for (const line of formatToolsetsReloadReceiptLines(receipt)) log(line);
  } finally {
    conn.client.close();
  }
}
