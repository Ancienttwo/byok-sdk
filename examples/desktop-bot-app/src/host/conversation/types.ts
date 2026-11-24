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
