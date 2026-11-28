import type { ConversationBrand, RoleLocale, RolePresetCopy } from './src/host/conversation/catalog.ts';

/** The only white-label entry of the desktop app. A fork edits this file and nothing else to rebrand. */
export interface BrandConfig extends ConversationBrand {
  /** Window title and the application name the OS shows. */
  readonly productName: string;
  /** The SDK product id: one portable path segment, fixed for the life of the product (it names the local stores). */
  readonly productId: string;
  /** https origins that links in the UI may open in the system browser; every other link is dropped. */
  readonly externalOrigins: readonly string[];
}

const rolePresets: Readonly<Record<string, Record<RoleLocale, RolePresetCopy>>> = {
  writer: {
    en: { label: 'Writer', role: 'Writes and edits text', persona: 'Clear, short sentences. Ask when the audience is unclear.' },
    'zh-Hans': { label: '写作助手', role: '撰写和编辑文本', persona: '用清晰的短句表达。读者不明确时先询问。' },
    'zh-Hant': { label: '寫作助理', role: '撰寫及編輯文字', persona: '用清晰的短句表達。讀者不明確時先詢問。' },
  },
  researcher: {
    en: { label: 'Researcher', role: 'Finds and compares information', persona: 'State sources and uncertainty. Separate facts from opinions.' },
    'zh-Hans': { label: '研究助手', role: '查找并比较资料', persona: '注明来源和不确定之处。区分事实和观点。' },
    'zh-Hant': { label: '研究助理', role: '查找並比較資料', persona: '註明來源和不確定之處。區分事實與觀點。' },
  },
};

export function rolePreset(id: string, locale: RoleLocale): RolePresetCopy {
  const preset = Object.hasOwn(rolePresets, id) ? rolePresets[id] : undefined;
  if (preset === undefined) throw new Error(`Unknown role preset: ${id}`);
  return preset[locale];
}

const brand: BrandConfig = {
  productName: 'BYOK Bots',
  productId: 'byok-desktop-bots',
  externalOrigins: [],
  instruction: 'You are a helpful assistant in a desktop app. Answer the user in their language.',
  roles: Object.keys(rolePresets).map((id) => ({ id })),
  // Picker order and labels by runtime id; the Host's composed adapters decide which exist, the first one here is the default.
  models: {
    pi: { label: 'Pi' },
    claude: { label: 'Claude Code' },
    codex: { label: 'Codex' },
  },
};

export default brand;
