/**
 * The single authority for the display text of a `task.fail` `reason` (#1124).
 *
 * A runtime's stderr tail can carry credentials a runtime or proxy printed
 * while failing. The `task.fail` schema applies this to `reason` on every
 * parse, so `createEnvelope` bounds what a daemon sends (sealed or not) and
 * every decode bounds what a receiver holds. The raw tail stays local, on the
 * adapter's `RuntimeExecutionFailure`. The result is a fixed point: applying
 * it to its own output changes nothing, so a bounded envelope round-trips
 * byte-for-byte.
 *
 * Every pattern starts at a literal and its runs never backtrack into a
 * failure, so the cost stays linear in the input length.
 */

/** Maximum UTF-8 bytes of a `task.fail` `reason` after normalization, truncation marker included. */
export const TASK_FAIL_REASON_MAX_BYTES = 2048;

const REDACTED = '[redacted]';

// A secret value: a quoted string (an unclosed quote runs to the end of the
// line), or an unquoted run. A backslash and its following character belong
// to the value together, so an escaped quote cannot expose a secret suffix.
// A dangling backslash in an unclosed value is consumed too. Every alternative
// succeeds greedily without backtracking. An unquoted value never starts with `[` or `…`, so a
// redaction or truncation marker is never mistaken for a value on a second pass.
const VALUE = String.raw`(?:"(?:\\[^\n]|[^"\\\n])*(?:\\)?"?|'(?:\\[^\n]|[^'\\\n])*(?:\\)?'?|[^\s"'\[\u2026,;&|][^\s"',;&|]*)`;

// Bounded runs keep a failed match from rescanning a long run at every literal.
const GAP = '[ \\t]{0,16}';

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // `Authorization: Bearer …`, `proxy-authorization=Basic …`, JSON `"authorization": "…"`.
  [new RegExp(String.raw`\b((?:proxy-)?authorization)(["']?${GAP}[:=]${GAP})(?:(?:bearer|basic|token|digest)[ \t]{1,16})?${VALUE}`, 'gi'), `$1$2${REDACTED}`],
  [/\b(bearer)[ \t]{1,16}[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // `ANTHROPIC_API_KEY=…`, `x-api-key: …`, `GITHUB_TOKEN=…`, `client_secret: …`, `DB_PASSWORD_FILE=…`.
  [new RegExp(String.raw`(key|token|secret|passw(?:or)?d[\w.-]{0,64})(["']?${GAP}[:=]${GAP})${VALUE}`, 'gi'), `$1$2${REDACTED}`],
  // URL userinfo: `postgres://user:pass@host`, `https://token@host`.
  [/:\/\/[^\s/?#@]{1,256}@/g, `://${REDACTED}@`],
  // Provider key shapes.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bxai-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}/g, REDACTED],
  // JWT-like tokens.
  [/\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*){0,2}/g, REDACTED],
];

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

const marker = (droppedBytes: number): string => `\u2026[truncated ${droppedBytes} bytes]`;

/** UTF-8 bytes of `text`; a lone surrogate encodes as U+FFFD. */
function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

function wellFormed(text: string): string {
  return decoder.decode(encoder.encode(text));
}

export interface TruncateOptions {
  /** Size of a text, additive over its code points. Default: its UTF-8 bytes. */
  readonly measure?: (text: string) => number;
  /** Keep the end of the text too, with the marker in the middle. Default: the head only. */
  readonly keepTail?: boolean;
}

/**
 * The single text cut of the protocol: `text` as it is when it measures at
 * most `maxBytes`, else the kept code points and a `…[truncated N bytes]`
 * marker, where N counts the dropped measured bytes. The kept text is
 * re-encoded, so a lone surrogate in it becomes U+FFFD. A `maxBytes` that
 * cannot hold the marker gives the marker alone, which is then over `maxBytes`.
 */
export function truncateUtf8(text: string, maxBytes: number, options: TruncateOptions = {}): string {
  const { measure = utf8Bytes, keepTail = false } = options;
  const total = measure(text);
  if (total <= maxBytes) return text;
  // Reserve the widest marker this input can need; the final one is no wider.
  const room = maxBytes - measure(marker(total));
  if (room <= 0) return marker(total);
  const points = Array.from(text);
  let start = 0, kept = 0;
  for (const headRoom = keepTail ? Math.ceil(room / 2) : room; start < points.length; start += 1) {
    const size = measure(points[start]!);
    if (kept + size > headRoom) break;
    kept += size;
  }
  let end = points.length;
  while (keepTail && end > start) {
    const size = measure(points[end - 1]!);
    if (kept + size > room) break;
    kept += size;
    end -= 1;
  }
  const head = wellFormed(points.slice(0, start).join(''));
  return `${head}${marker(total - kept)}${wellFormed(points.slice(end).join(''))}`;
}

/**
 * Redact credentials from a failure reason, then cap it at
 * {@link TASK_FAIL_REASON_MAX_BYTES} UTF-8 bytes on a code-point boundary
 * with a `…[truncated N bytes]` marker, where N counts the dropped redacted
 * bytes.
 */
export function boundFailureReason(reason: string): string {
  return truncateUtf8(redact(reason), TASK_FAIL_REASON_MAX_BYTES);
}
