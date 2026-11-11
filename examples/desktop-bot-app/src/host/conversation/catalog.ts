import type { AgentEgressPolicy } from '@byok-sdk/client';
import type { ExecutionTemplate } from '@byok-sdk/server/execution-core';

/**
 * The Agent egress policy of this Host. The daemon consumes only an offer carrying exactly its configured policy, so
 * `compose.ts` configures the daemon with this value and every template offers it.
 */
export const AGENT_EGRESS_POLICY: AgentEgressPolicy = {
  policyRevision: 'desktop-v1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 16, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 16384 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
};

/** One brand catalog entry: a Bot stores only its id; the label is what the UI shows. */
export interface ModelEntry {
  readonly label: string;
  readonly runtime: 'pi' | 'claude' | 'codex';
}
/** A "New by role" preset of the brand config. */
export interface RolePreset {
  readonly id: string;
  readonly label: string;
  readonly role: string;
  readonly persona: string;
}
/** What the Host reads from the brand config for conversations. */
export interface ConversationBrand {
  /** The base instruction of every Turn; K8 adds the Bot persona context and its ContextPack. */
  readonly instruction: string;
  readonly roles: readonly RolePreset[];
  readonly models: Readonly<Record<string, ModelEntry>>;
}

/**
 * K8's execution templates from the brand catalog (#1499 s1.4 "Models"): one fresh-lane template per catalog entry, on
 * this device, replying through `messageEgress`. K8 sets each Bot's `agentRef`, its instruction and its outcome
 * projection when it freezes a Turn; the values here are the base it starts from.
 */
export function executionCatalog(brand: Pick<ConversationBrand, 'instruction' | 'models'>, deviceId: string): {
  readonly execution: ExecutionTemplate;
  readonly models: Readonly<Record<string, ExecutionTemplate>>;
} {
  const ids = Object.keys(brand.models);
  if (ids.length === 0) throw new Error('brand.config.ts lists no models');
  const template = (runtime: ModelEntry['runtime']): ExecutionTemplate => ({
    deviceId, agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'desktop' },
    payload: {
      runtime, session: { mode: 'fresh' }, instruction: brand.instruction, agentRef: { agentId: 'host', profileRevision: '1' },
      egressPolicy: AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 },
      terminalProjection: { mode: 'result-document', contract: 'desktop-turn-v1', schema: { type: 'object' } },
    },
  });
  const models = Object.fromEntries(ids.map(id => [id, template(brand.models[id]!.runtime)]));
  return { execution: models[ids[0]!]!, models };
}
