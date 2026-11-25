import { openUrl } from "nsh";
import brand from "../../brand.config.ts";

/**
 * UI-layer validation of an external URL against the desktop app's `https:` + exact origin allowlist.
 * Per #2457 Decision D-O3 (2026-11-25): `nsh.json` enforces `openUrl.schemes: ["https"]` at the NSH
 * capability layer and `links.ts` enforces exact `brand.externalOrigins` validation as the single
 * TSX external-link gate (no Rust link broker).
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
