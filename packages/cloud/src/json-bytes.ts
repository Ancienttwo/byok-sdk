/** Decode strict UTF-8 JSON; malformed bytes or JSON return undefined, while null is valid. */
export function parseJsonBytes(bytes: Uint8Array): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}
