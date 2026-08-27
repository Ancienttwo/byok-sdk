/**
 * Runtime-neutral instructions for an Agent's model-authored local memory.
 *
 * This is deliberately prompt guidance only: the SDK does not read memory
 * content, infer durable values, or auto-inject files into the operation.
 */
export const AGENT_MEMORY_GUIDANCE = [
  'At the start of this Agent task, first read `MEMORY.md` in the provided `cwd`.',
  'Treat `MEMORY.md` as a concise, self-contained recovery index; if it is empty, initialize a brief index from durable, non-secret task knowledge.',
  'Read files under `notes/` only as needed, following pointers from the index.',
  'When task permissions allow and a durable value is learned, update the relevant `notes/` entry and the `MEMORY.md` index.',
  'Never write credentials, secrets, tokens, API keys, private keys, or other authentication material to `MEMORY.md` or `notes/`.',
].join('\n');

export function prependAgentMemoryGuidance(instruction: string): string {
  return `${AGENT_MEMORY_GUIDANCE}\n\n${instruction}`;
}
