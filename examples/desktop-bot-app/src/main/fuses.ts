/**
 * The Electron fuses of every packaged build. Packaging (#1811) flips them on the
 * app's Electron binary; `node src/main/fuses.ts <electron binary>` flips a copy.
 * Never flip the workspace's own node_modules binary: dev runs load the app from
 * a directory, which OnlyLoadAppFromAsar refuses.
 */
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';

export const APP_FUSES = {
  version: FuseVersion.V1,
  // The Host child runs on its own Node, so Electron never needs to act as Node.
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
} as const;

export function flipAppFuses(electronBinary: string): Promise<unknown> {
  return flipFuses(electronBinary, { ...APP_FUSES, resetAdHocDarwinSignature: process.platform === 'darwin' });
}

if (import.meta.main) {
  const [binary] = process.argv.slice(2);
  if (!binary) throw new Error('Usage: node src/main/fuses.ts <electron binary>');
  await flipAppFuses(binary);
}
