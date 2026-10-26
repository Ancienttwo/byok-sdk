import type { RuntimeTaskInput } from '../../types';
import { isRuntimeStartupDisposalFailure } from '../../runtime-failure';
import { projectPiMcpEnvironment } from '../../adapters/pi/mcp-environment';
import { testExecutionScratch } from './execution-scratch';
import {
  sealRuntimeOperationManifest,
  type ApprovalChannel,
  type McpStdioServerConfig,
  type McpToolsetToolObservation,
  type RuntimeAdapter,
  type Session,
} from '../../types';

/** Test-only resources passed to a prepared operation after admission. */
export interface PreparedOperationResources {
  workspaceDir: string;
  scratch?: import('../../daemon/retention/scratch').ExecutionScratch;
  env: NodeJS.ProcessEnv;
  mcpServers?: Readonly<Record<string, McpStdioServerConfig>>;
  /** Stands in for the daemon's `tools/list` observation; required whenever `mcpServers` carries a non-reserved server. */
  mcpToolsetTools?: McpToolsetToolObservation;
  /**
   * A DIFFERENT observation handed to `start()` than the one `prepare()` was
   * admitted with — the drift case an adapter must refuse. Omitted
   * everywhere except those tests, where `mcpToolsetTools` stays the admitted
   * authority and this is the swapped-in one.
   */
  startMcpToolsetTools?: McpToolsetToolObservation;
  approvalChannel?: ApprovalChannel;
  /** Seals a `memory-reader` Agent manifest whose run directory is `workspaceDir`. */
  reader?: { canonicalHome: string };
  /** Seals a canonical writer Agent manifest. */
  agentHome?: string;
}

/** Exercise the public descriptor → prepare → sealed-manifest → operation path in adapter unit tests. */
export async function startPreparedOperation(
  adapter: RuntimeAdapter,
  offer: RuntimeTaskInput,
  resources: PreparedOperationResources,
): Promise<Session> {
  const prepared = await adapter.prepare({
    offer,
    descriptor: adapter.descriptor,
    requiredToolsetIds: [],
    ...(resources.mcpServers === undefined ? {} : { mcpServers: resources.mcpServers }),
    ...(resources.mcpToolsetTools === undefined ? {} : { mcpToolsetTools: resources.mcpToolsetTools }),
  });
  if (prepared.kind === 'reject') throw new Error(prepared.reason);
  if (typeof offer.instruction !== 'string') throw new Error('prepared adapter accepted a non-string instruction');
  const manifest = sealRuntimeOperationManifest({
    taskId: 'adapter-unit-test',
    runtimeId: adapter.descriptor.id,
    descriptor: adapter.descriptor,
    requiredToolsetIds: [],
    ...(offer.dispatchSelection === undefined ? {} : { dispatchSelection: offer.dispatchSelection }),
    ...(offer.sessionRef === undefined ? {} : { sessionRef: offer.sessionRef }),
    ...(resources.agentHome === undefined ? {} : {
      agentRef: { agentId: 'adapter-unit-agent', profileRevision: 'r1' },
      cwd: resources.workspaceDir,
      lease: { leaseId: 'adapter-unit-lease', canonicalHome: resources.agentHome },
    }),
    ...(resources.reader === undefined ? {} : {
      agentRef: { agentId: 'adapter-unit-agent', profileRevision: 'r1' },
      cwd: resources.workspaceDir,
      homeAccess: 'memory-reader' as const,
      lease: { leaseId: 'adapter-unit-lease', canonicalHome: resources.reader.canonicalHome },
    }),
    workspace: { workspaceDir: resources.workspaceDir },
    forwardedEnvironmentNames: Object.keys(resources.env).sort(),
  });
  const scratch = resources.scratch ?? await testExecutionScratch();
  const runtimeLaunch = await prepared.operation.resolveRuntimeLaunch?.({
    kind: 'instruction', cwd: resources.workspaceDir, env: resources.env,
    scratch,
  });
  try {
    return await prepared.operation.start({ scratch,
      ...(runtimeLaunch === undefined ? {} : { runtimeLaunch }),
      kind: 'instruction',
      mcpEnv: projectPiMcpEnvironment(resources.env),
      manifest,
      instruction: offer.instruction,
      env: resources.env,
      ...(resources.mcpServers === undefined ? {} : { mcpServers: resources.mcpServers }),
      ...(resources.startMcpToolsetTools !== undefined
        ? { mcpToolsetTools: resources.startMcpToolsetTools }
        : resources.mcpToolsetTools === undefined ? {} : { mcpToolsetTools: resources.mcpToolsetTools }),
      ...(resources.approvalChannel === undefined ? {} : { approvalChannel: resources.approvalChannel }),
    });
  } catch (error) {
    if (!isRuntimeStartupDisposalFailure(error)) await scratch.release();
    throw error;
  }
}
