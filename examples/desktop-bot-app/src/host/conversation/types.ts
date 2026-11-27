import type { DreamRecord } from '@byok-sdk/bot-collaboration/host-kit';
import type { ModelChoice, RolePreset } from './catalog.ts';
import type { BotView, ConversationView } from './view.ts';

/** Pure-type conversation snapshot shared between Host service and the bridge contract. */
export interface ConversationSnapshot {
  readonly bots: readonly BotView[];
  readonly roles: readonly RolePreset[];
  readonly models: readonly ModelChoice[];
  /** The selected Bot's conversation; absent when no Bot is selected or the Bot is unknown. */
  readonly conversation?: ConversationView;
  /** Some Bot has open work or a profile catching up: the renderer reads again while this holds. */
  readonly busy: boolean;
}

/** One Bot's memory (`k8.memory`): its Agent home's files and K8's dream record. `null` marks a value the Host cannot read. */
export interface BotMemory {
  /** `MEMORY.md`. Over `limitBytes`, the device fails the Bot's tasks before they start. */
  readonly resident: { readonly byteCount: number; readonly limitBytes: number; readonly overLimit: boolean } | null;
  /** The regular files under `notes/`. */
  readonly notes: { readonly count: number; readonly bytes: number } | null;
  /** How this Bot's last dream occurrence ended (K8's `snapshot().dreams`); null before its first. `at` is ISO 8601. */
  readonly lastDream: (Pick<DreamRecord, 'outcome' | 'reason' | 'template' | 'fallback'> & { readonly at: string }) | null;
  /**
   * Always null: bot-collaboration exposes no next-dream time. A dream runs only if the Bot worked since its last one,
   * and that rule is private to the scheduler.
   */
  readonly nextDream: null;
}
