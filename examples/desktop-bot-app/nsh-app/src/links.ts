import { openUrl } from "nsh";
import brand from "../../brand.config.ts";

/** Validates an external URL against the desktop app's `https:` + exact origin allowlist. */
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

/** Opens `target` in the OS browser only when `https:` and its origin appears in `allowedOrigins` (default `brand.externalOrigins`). */
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
