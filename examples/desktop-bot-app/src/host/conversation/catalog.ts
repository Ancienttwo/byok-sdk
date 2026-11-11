import type { AgentEgressPolicy } from '@byok-sdk/client';
import type { ModelProviderProfile } from '@byok-sdk/keys';
import type { ExecutionTemplate } from '@byok-sdk/server/execution-core';
import { catalogEntryFor } from '../keys/catalog.ts';

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

/** One model a Bot can pick: its catalog id and the label the UI shows. */
export interface ModelChoice {
  readonly id: string;
  readonly label: string;
}

/** The catalog id of the Pi entry pinned to one keys profile. */
export const profileModelId = (profileRef: string): string => `pi:${profileRef}`;

/**
 * K8's execution templates (#1499 s1.4 "Models"): one fresh-lane template per brand catalog entry, then one Pi entry per
 * keys profile Pi can launch, pinned to that profile (R6, `catalogEntryFor`); a profile without `pi_model` has none, and
 * the enabled profile is not read as a default. All run on this device and reply through `messageEgress`. K8 sets each
 * Bot's `agentRef`, its instruction and its outcome projection when it freezes a Turn; the values here are the base.
 */
export function executionCatalog(brand: Pick<ConversationBrand, 'instruction' | 'models'>, deviceId: string, profiles: readonly ModelProviderProfile[]): {
  readonly execution: ExecutionTemplate;
  readonly models: Readonly<Record<string, ExecutionTemplate>>;
  readonly choices: readonly ModelChoice[];
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
  const models: Record<string, ExecutionTemplate> = Object.fromEntries(ids.map(id => [id, template(brand.models[id]!.runtime)]));
  const choices: ModelChoice[] = ids.map(id => ({ id, label: brand.models[id]!.label }));
  for (const profile of profiles) {
    const entry = catalogEntryFor(profile, template('pi'));
    if (entry === undefined) continue;
    const id = profileModelId(profile.profile_ref);
    if (Object.hasOwn(models, id)) throw new Error(`brand.config.ts model ${id} collides with the keys profile ${profile.profile_ref}`);
    models[id] = entry;
    choices.push({ id, label: profile.display_name });
  }
  return { execution: models[ids[0]!]!, models, choices };
}
