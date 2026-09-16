import { RUNTIME_DESCENDANT_EDGES, type ToolImplementationInstallRecordV1, type RuntimeImplementationRecordV1 } from '@byok-sdk/implementation-identity';

/** Synthetic no-delegation policy, explicit fixture values, never a product default. */
export function runtimeRecordFixture(record: ToolImplementationInstallRecordV1): RuntimeImplementationRecordV1 {
  return { record, descendantPolicy: { envNameAllowlist: [], maxDepth: 0, fanout: 1, parallel: 1, sessionCap: 1 },
    edges: RUNTIME_DESCENDANT_EDGES };
}
