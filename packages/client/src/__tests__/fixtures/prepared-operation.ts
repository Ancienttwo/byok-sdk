import { projectPiMcpEnvironment } from '../../adapters/pi/mcp-environment';
import os from 'node:os';
import path from 'node:path';
import type { TaskOfferPayload } from '@byok-sdk/protocol';
import {
  sealRuntimeOperationManifest,
  type ApprovalChannel,
  type McpStdioServerConfig,
  type McpToolsetToolObservation,
  type RuntimeAdapter,
  type Session,
} from '../../types';
import type { McpLaunchBinding } from '../../daemon/trusted-launch-cwd';
import { trustedLaunchBinding } from './launch-cwd';

/** Test-only resources passed to a prepared operation after admission. */
export interface PreparedOperationResources {
  workspaceDir: string;
  policy: TaskOfferPayload['policy'];
  env: NodeJS.ProcessEnv;
  mcpServers?: Readonly<Record<string, McpStdioServerConfig>>;
  /** Stands in for the daemon's `tools/list` observation; required whenever `mcpServers` carries a non-reserved server. */
  mcpToolsetTools?: McpToolsetToolObservation;
  /**
   * A DIFFERENT observation handed to `start()` than the one `prepare()` was
   * admitted with — the grant-drift case an adapter must refuse. Omitted
   * everywhere except those tests, where `mcpToolsetTools` stays the admitted
   * authority and this is the swapped-in one.
   */
  startMcpToolsetTools?: McpToolsetToolObservation;
  gitWorkspace?: { workspaceId: string; baseline?: string };
  approvalChannel?: ApprovalChannel;
  /**
   * What `TaskRunner` resolves once per offer
   * (`daemon/trusted-launch-cwd.ts`). Left unset, this helper resolves the
   * REAL one for the machine the test runs on, exactly as the daemon would,
   * so an adapter test never gets a directory the daemon would have refused.
   * Set it to exercise an adapter's own fail-closed branches.
   */
  mcpLaunch?: McpLaunchBinding | null;
}

/** Exercise the public descriptor → prepare → sealed-manifest → operation path in adapter unit tests. */
export async function startPreparedOperation(
  adapter: RuntimeAdapter,
  offer: TaskOfferPayload,
  resources: PreparedOperationResources,
): Promise<Session> {
  const prepared = await adapter.prepare({
    offer,
    policy: resources.policy,
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
    policy: resources.policy,
    requiredToolsetIds: [],
    ...(offer.dispatchSelection === undefined ? {} : { dispatchSelection: offer.dispatchSelection }),
    ...(offer.sessionRef === undefined ? {} : { sessionRef: offer.sessionRef }),
    workspace: {
      workspaceDir: resources.workspaceDir,
      ...(resources.gitWorkspace === undefined
        ? {}
        : { workspaceId: resources.gitWorkspace.workspaceId, baseline: resources.gitWorkspace.baseline }),
    },
    forwardedEnvironmentNames: Object.keys(resources.env).sort(),
  });
  // Mirrors `TaskRunner`'s own predicate: the daemon resolves the binding for
  // every task that will GENERATE an MCP server, which includes an adapter
  // that generates a reserved approval server of its own under
  // `policy.mode: 'confirm'` even when the daemon projects no server at all.
  const generatesApprovalMcp = resources.policy.mode === 'confirm'
    && adapter.descriptor.generatesApprovalMcpServer === true;
  const mcpLaunch = resources.mcpLaunch === null
    ? undefined
    : resources.mcpLaunch
      ?? (resources.mcpServers === undefined && !generatesApprovalMcp ? undefined : await trustedLaunchBinding());
  const runtimeLaunch = await prepared.operation.resolveRuntimeLaunch?.({
    kind: 'instruction', cwd: resources.workspaceDir, env: resources.env,
    projectionRoot: path.join(os.tmpdir(), 'byok-adapter-test-runtime-projections'),
  });
  try {
    return await prepared.operation.start({
      ...(runtimeLaunch === undefined ? {} : { runtimeLaunch }),
      kind: 'instruction',
      mcpEnv: projectPiMcpEnvironment(resources.env),
      manifest,
      instruction: offer.instruction,
      env: resources.env,
      ...(mcpLaunch === undefined ? {} : { mcpLaunch }),
      ...(resources.mcpServers === undefined ? {} : { mcpServers: resources.mcpServers }),
      ...(resources.startMcpToolsetTools !== undefined
        ? { mcpToolsetTools: resources.startMcpToolsetTools }
        : resources.mcpToolsetTools === undefined ? {} : { mcpToolsetTools: resources.mcpToolsetTools }),
      ...(resources.approvalChannel === undefined ? {} : { approvalChannel: resources.approvalChannel }),
    });
  } catch (error) {
    await runtimeLaunch?.release();
    throw error;
  }
}
