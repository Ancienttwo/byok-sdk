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

/**
 * Guidance for a `memory-reader` Attempt. Its `cwd` is its own run directory,
 * `<home>/.byok/runs/<taskId>/`, so the memory is three levels up. The writer
 * Attempt owns memory changes. This is guidance only: the SDK does not make
 * memory read-only, and the reader terminal reports any memory change.
 * Agent content reads do not reach the run directory (it is under `.byok/`),
 * so the guidance puts the result in the final reply, not in a file.
 */
export const AGENT_MEMORY_READER_GUIDANCE = [
  'At the start of this Agent task, first read `MEMORY.md` in the Agent home, which is `../../../MEMORY.md` from the provided `cwd`.',
  'Read files under the Agent home `notes/` (`../../../notes/`) only as needed, following pointers from the index.',
  'This task reads Agent memory only. Do not change `MEMORY.md` or `notes/`: another task writes memory.',
  'Give the result of this task in your final reply. Files in the provided `cwd` are scratch files: do not expect the host to read them.',
].join('\n');

export function prependAgentMemoryGuidance(instruction: string): string {
  return `${AGENT_MEMORY_GUIDANCE}\n\n${instruction}`;
}

export function prependAgentMemoryReaderGuidance(instruction: string): string {
  return `${AGENT_MEMORY_READER_GUIDANCE}\n\n${instruction}`;
}
