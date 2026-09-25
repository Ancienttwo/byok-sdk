/**
 * Admission of Host-owned assistant history into a prepared Pi request.
 *
 * On official Pi (0.87.x) Host assistant history enters the request as an
 * `AssistantMessage` carrying request-scoped sentinel provenance (A2'). The
 * official `transform-messages` step compares that provenance with the target
 * model (`isSameModel`) and handles `thinking` and `toolCall` blocks
 * differently depending on the answer, so a sentinel is only wire-neutral for
 * plain text. Anything other than a plain `{ type: "text", text }` block is
 * therefore refused here with a typed reason instead of being rewritten.
 */

export type HostAssistantRefusalCode =
  | 'host_assistant_content_not_array'
  | 'host_assistant_content_empty'
  | 'host_assistant_block_not_text'
  | 'host_assistant_text_block_malformed';

export interface HostAssistantRefusal {
  readonly code: HostAssistantRefusalCode;
  /** Index of the offending block, when one block is at fault. */
  readonly blockIndex?: number;
  /** The offending block's `type` as supplied, when it is a string. */
  readonly blockType?: string;
}

export type HostAssistantAdmission =
  | { readonly admitted: true; readonly texts: readonly string[] }
  | { readonly admitted: false; readonly refusal: HostAssistantRefusal };

const TEXT_BLOCK_KEYS = new Set(['type', 'text']);

/**
 * Admit one Host assistant entry's `content` iff it is a non-empty list of
 * plain text blocks (`type` and `text` only, `text` a string). Pure.
 */
export function admitHostAssistantContent(content: unknown): HostAssistantAdmission {
  if (!Array.isArray(content)) {
    return { admitted: false, refusal: { code: 'host_assistant_content_not_array' } };
  }
  if (content.length === 0) {
    return { admitted: false, refusal: { code: 'host_assistant_content_empty' } };
  }
  const texts: string[] = [];
  for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
    const block: unknown = content[blockIndex];
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      return { admitted: false, refusal: { code: 'host_assistant_text_block_malformed', blockIndex } };
    }
    const type = (block as { type?: unknown }).type;
    if (type !== 'text') {
      return {
        admitted: false,
        refusal: {
          code: 'host_assistant_block_not_text',
          blockIndex,
          ...(typeof type === 'string' ? { blockType: type } : {}),
        },
      };
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text !== 'string' || Object.keys(block).some((key) => !TEXT_BLOCK_KEYS.has(key))) {
      return {
        admitted: false,
        refusal: { code: 'host_assistant_text_block_malformed', blockIndex, blockType: 'text' },
      };
    }
    texts.push(text);
  }
  return { admitted: true, texts };
}
