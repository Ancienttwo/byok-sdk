import { openUrl } from "nsh";
import brand from "../../brand.config.ts";

/**
 * UI-layer validation of an external URL against the desktop app's `https:` + exact origin allowlist.
 * Note: `nsh.json` enforces `openUrl.schemes: ["https"]` at the NSH capability layer; `#2461` product
 * wiring must also enforce brand-origin validation inside a native Rust broker before OS `openUrl`.
 */
export function parseAllowedExternalUrl(
  target: string,
  allowedOrigins: readonly string[],
): string | null {
  if (!URL.canParse(target)) {
    return null;
  }
  const url = new URL(target);
  if (url.protocol !== "https:" || !allowedOrigins.includes(url.origin)) {
    return null;
  }
  return url.href;
}

/**
 * UI-layer external link handler permitting only `https:` URLs whose origin appears in `allowedOrigins`
 * (default `brand.externalOrigins`) before invoking NSH `openUrl`.
 */
export async function openAllowedExternalUrl(
  target: string,
  allowedOrigins: readonly string[] = brand.externalOrigins,
): Promise<boolean> {
  const allowed = parseAllowedExternalUrl(target, allowedOrigins);
  if (allowed === null) {
    return false;
  }
  const result = await openUrl(allowed);
  return result.opened;
}
