// #1499 D7: the packaged app ships Electron's codec-free ffmpeg build in place of
// the one inside Electron, which includes proprietary codecs. The chat UI decodes
// no media. Packaging swaps the library (electron-builder.config.mjs afterPack);
// package-smoke.mjs checks the packaged file.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extract } from '@electron-internal/extract-zip';
import { downloadArtifact } from '@electron/get';

const require = createRequire(import.meta.url);
const LIBRARY = { darwin: 'libffmpeg.dylib', win32: 'ffmpeg.dll', linux: 'libffmpeg.so' };

function library(platform) {
  const file = LIBRARY[platform];
  if (!file) throw new Error(`No ffmpeg library is known for ${platform}`);
  return file;
}

/**
 * The bytes of Electron `version`'s codec-free ffmpeg library for `platform`-`arch`.
 * The zip is checked against the checksum that the installed electron package pins
 * (the same file Electron's own install checks); an unknown artifact fails.
 */
export async function codecFreeFfmpeg({ version, platform, arch }) {
  const zip = await downloadArtifact({ version, artifactName: 'ffmpeg', platform, arch, checksums: require('electron/checksums.json') });
  const dir = mkdtempSync(path.join(tmpdir(), 'byok-desktop-ffmpeg-'));
  try {
    await extract(zip, { dir });
    return readFileSync(path.join(dir, library(platform)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Where a packaged app keeps Electron's ffmpeg library: inside the framework of the macOS `.app`, beside the executable elsewhere. */
export function packagedFfmpeg(app, platform) {
  return platform === 'darwin' ? path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Libraries', library(platform))
    : path.join(app, library(platform));
}
