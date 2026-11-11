import type { FunctionComponent } from 'react';
import { CardsSection } from './slots/cards.tsx';
import { ConversationSection } from './slots/conversation.tsx';
import { KeysSection } from './slots/keys.tsx';
import { SettingsSection } from './slots/settings.tsx';

export interface ShellSection {
  readonly id: string;
  readonly label: string;
  readonly Component: FunctionComponent;
}

/** One slot per feature, in navigation order. Each feature owns only its slot file. */
export const SECTIONS: readonly ShellSection[] = [
  { id: 'conversation', label: 'Conversation', Component: ConversationSection },
  { id: 'cards', label: 'Activity', Component: CardsSection },
  { id: 'settings', label: 'Settings', Component: SettingsSection },
  { id: 'keys', label: 'Keys', Component: KeysSection },
];
