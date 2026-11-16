import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Discover the non-private workspace manifests, in deterministic package-name order. */
export function publicPackages(root) {
  const packages = path.join(root, 'packages');
  if (!existsSync(packages)) return [];
  return readdirSync(packages, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(path.join(packages, entry.name, 'package.json')))
    .map(entry => {
      const directory = path.join(packages, entry.name);
      const file = path.join(directory, 'package.json');
      let manifest;
      try { manifest = JSON.parse(readFileSync(file, 'utf8')); }
      catch (cause) { throw new Error(`Invalid workspace manifest: ${file}`, { cause }); }
      return { directory, manifest, workspace: true };
    })
    .filter(pkg => pkg.manifest.private !== true)
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export function publicPackageDirectories(root) {
  return publicPackages(root).map(pkg => path.basename(pkg.directory));
}
