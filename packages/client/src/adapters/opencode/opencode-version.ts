/** Compatibility floors are independent of OS/line canary qualification. */
export function opencodeVersionToken(output: string): string | undefined {
  const match = /^(?:opencode v)?((1|2)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/.exec(output.trim());
  if (!match) return undefined;
  const [, version, major, minor, patch] = match;
  if (major === '1' && (Number(minor) < 18 || (minor === '18' && Number(patch) < 35))) return undefined;
  if (major === '2' && minor === '0' && Number(patch) < 26) return undefined;
  return version;
}

/** No OS/line combination is qualified until its native onboarding canary passes (#1538). */
export const OPENCODE_QUALIFICATION = 'unqualified';
