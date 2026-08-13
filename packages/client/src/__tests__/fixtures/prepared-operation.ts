import type { TaskOfferPayload } from '@byok-sdk/protocol';
import {
  sealRuntimeOperationManifest,
  type ApprovalChannel,
  type McpStdioServerConfig,
  type RuntimeAdapter,
  type Session,
} from '../../types';

/** Test-only resources passed to a prepared operation after admission. */
export interface PreparedOperationResources {
  workspaceDir: string;
  policy: TaskOfferPayload['policy'];
  env: NodeJS.ProcessEnv;
  mcpServers?: Readonly<Record<string, McpStdioServerConfig>>;
  gitWorkspace?: { workspaceId: string; baseline?: string };
  approvalChannel?: ApprovalChannel;
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
  return prepared.operation.start({
    manifest,
    instruction: offer.instruction,
    env: resources.env,
    ...(resources.mcpServers === undefined ? {} : { mcpServers: resources.mcpServers }),
    ...(resources.approvalChannel === undefined ? {} : { approvalChannel: resources.approvalChannel }),
  });
}
