import { canonical } from '@byok-sdk/server/execution-core/canonical';

/** Bound of one canonical metadata line in the Request section, asserted when the line is built. */
export const REPLY_META_MAX_BYTES = 2048;
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
/** One length-framed block of raw UTF-8: a header with the body size, one canonical metadata line, the body and an end line. */
export function frame(label: string, meta: Record<string, unknown>, body: string): string {
  const line = canonical(meta);
  if (bytes(line) > REPLY_META_MAX_BYTES) throw new Error(`Delegation metadata exceeds ${REPLY_META_MAX_BYTES} bytes`);
  return `--- ${label} (${bytes(body)} bytes) ---\n${line}\n${body}\n--- end ${label} ---`;
}
