import type { ConversationBrand } from './src/host/conversation/catalog.ts';

/** The only white-label entry of the desktop app. A fork edits this file and nothing else to rebrand. */
export interface BrandConfig extends ConversationBrand {
  /** Window title and the application name the OS shows. */
  readonly productName: string;
  /** The SDK product id: one portable path segment, fixed for the life of the product (it names the local stores). */
  readonly productId: string;
  /** https origins that links in the UI may open in the system browser; every other link is dropped. */
  readonly externalOrigins: readonly string[];
}

const brand: BrandConfig = {
  productName: 'BYOK Bots',
  productId: 'byok-desktop-bots',
  externalOrigins: [],
  instruction: 'You are a helpful assistant in a desktop app. Answer the user in their language.',
  roles: [
    { id: 'writer', label: 'Writer', role: 'Writes and edits text', persona: 'Clear, short sentences. Ask when the audience is unclear.' },
    { id: 'researcher', label: 'Researcher', role: 'Finds and compares information', persona: 'State sources and uncertainty. Separate facts from opinions.' },
  ],
  // The first entry is the default for new Bots.
  models: {
    pi: { label: 'Pi', runtime: 'pi' },
    claude: { label: 'Claude Code', runtime: 'claude' },
    codex: { label: 'Codex', runtime: 'codex' },
  },
};

export default brand;
