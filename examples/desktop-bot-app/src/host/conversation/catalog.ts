import type { AgentEgressPolicy, RuntimeAdapter } from '@byok-sdk/client';
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

/** One brand label: the picker shows it for the runtime adapter of the same id. */
export interface ModelEntry {
  readonly label: string;
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
  /**
   * Picker order and labels, keyed by runtime adapter id; the first composed one is the default execution. It decides
   * neither which runtimes exist (the Host's composed adapters do) nor which can run (detection does).
   */
  readonly models: Readonly<Record<string, ModelEntry>>;
}

/** One model a Bot can pick: its catalog id, the label the UI shows and the runtime adapter facts the picker needs. */
export interface ModelChoice {
  readonly id: string;
  readonly label: string;
  /** The runtime adapter id the model runs on; the renderer joins it with `settings.device` detection for availability. */
  readonly runtime: string;
  /** The adapter's `capabilities.mcpToolsets` (omission is unsupported): whether a Bot on this model can take toolsets. */
  readonly mcpToolsets: boolean;
}

/** The catalog id of the Pi entry pinned to one keys profile. */
export const profileModelId = (profileRef: string): string => `pi:${profileRef}`;

/**
 * K8's execution templates (#1499 s1.4 "Models", #2546): one fresh-lane template per runtime adapter the Host composed
 * that takes a `device-default` selection, in brand order and then the unbranded ones under their adapter id; then one
 * Pi entry per keys profile Pi can launch, pinned to that profile (R6, `catalogEntryFor`). A profile without `pi_model`
 * has none, and the enabled profile is not read as a default. Detection never removes a template: a Bot keeps its model
 * while its runtime is missing, signed out or version-blocked, and the picker shows why. A brand label for a runtime the
 * Host did not compose is unused. All run on this device and reply through `messageEgress`. K8 sets each Bot's
 * `agentRef`, its instruction and its outcome projection when it freezes a Turn; the values here are the base.
 */
export function executionCatalog(
  brand: Pick<ConversationBrand, 'instruction' | 'models'>, deviceId: string,
  adapters: readonly Pick<RuntimeAdapter, 'descriptor'>[], profiles: readonly ModelProviderProfile[],
): {
  readonly execution: ExecutionTemplate;
  readonly models: Readonly<Record<string, ExecutionTemplate>>;
  readonly choices: readonly ModelChoice[];
} {
  const runnable = adapters.map(adapter => adapter.descriptor).filter(descriptor => descriptor.selectionModes.includes('device-default'));
  const rank = (id: string) => {
    const index = Object.keys(brand.models).indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  // A stable sort: unbranded adapters keep their composition order after the branded ones.
  const ordered = runnable.sort((a, b) => rank(a.id) - rank(b.id));
  const first = ordered[0];
  if (first === undefined) throw new Error('The Host composed no runtime adapter that takes a device-default selection');
  const template = (harnessId: string): ExecutionTemplate => ({
    deviceId, agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'desktop' },
    payload: {
      target: { lane: 'harness', harnessId, selection: { mode: 'device-default' } }, session: { mode: 'fresh' }, instruction: brand.instruction, agentRef: { agentId: 'host', profileRevision: '1' },
      egressPolicy: AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 },
      terminalProjection: { mode: 'result-document', contract: 'desktop-turn-v1', schema: { type: 'object' } },
    },
  });
  const models: Record<string, ExecutionTemplate> = {};
  const choices: ModelChoice[] = [];
  for (const descriptor of ordered) {
    models[descriptor.id] = template(descriptor.id);
    choices.push({
      id: descriptor.id, label: brand.models[descriptor.id]?.label ?? descriptor.id, runtime: descriptor.id,
      mcpToolsets: descriptor.capabilities.mcpToolsets === true,
    });
  }
  // A profile entry runs on the Pi adapter: without it there is none.
  const pi = ordered.find(descriptor => descriptor.id === 'pi');
  for (const profile of pi === undefined ? [] : profiles) {
    const entry = catalogEntryFor(profile, template('pi'));
    if (entry === undefined) continue;
    const id = profileModelId(profile.profile_ref);
    if (Object.hasOwn(models, id)) throw new Error(`Runtime ${id} collides with the keys profile ${profile.profile_ref}`);
    models[id] = entry;
    choices.push({ id, label: profile.display_name, runtime: 'pi', mcpToolsets: pi?.capabilities.mcpToolsets === true });
  }
  return { execution: models[first.id]!, models, choices };
}
