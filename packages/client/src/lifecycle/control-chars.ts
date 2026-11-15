/**
 * True if `value` contains any C0 control character (newline, CR, NUL,
 * etc., code points below 32) or DEL (code point 127) - checked by
 * character code rather than a regex escape sequence for that range, so
 * there is no ambiguity about which literal bytes are being matched.
 */
export function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
