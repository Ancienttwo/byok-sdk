export function writeKoffiAssetRoot(
  outDir: string,
  pin: { readonly package: string; readonly version: string; readonly integrity: string; readonly sha256: string },
): Promise<string>;
