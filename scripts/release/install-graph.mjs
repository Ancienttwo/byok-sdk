import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function assertSingleVersionSet(installDirectory, expectedVersions, context) {
  const root = path.join(installDirectory, 'node_modules');
  const found = [];
  const visit = (nodeModulesDirectory) => {
    const retiredUmbrella = path.join(nodeModulesDirectory, 'byok-sdk', 'package.json');
    if (existsSync(retiredUmbrella)) found.push(retiredUmbrella);
    const scope = path.join(nodeModulesDirectory, '@byok-sdk');
    if (existsSync(scope)) {
      for (const entry of readdirSync(scope)) {
        const manifest = path.join(scope, entry, 'package.json');
        if (existsSync(manifest)) found.push(manifest);
      }
    }
    for (const entry of readdirSync(nodeModulesDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (entry.name.startsWith('@')) {
        for (const scoped of readdirSync(path.join(nodeModulesDirectory, entry.name))) {
          const nested = path.join(nodeModulesDirectory, entry.name, scoped, 'node_modules');
          if (existsSync(nested)) visit(nested);
        }
        continue;
      }
      const nested = path.join(nodeModulesDirectory, entry.name, 'node_modules');
      if (existsSync(nested)) visit(nested);
    }
  };
  visit(root);
  if (found.length === 0) throw new Error(`${installDirectory}: no @byok-sdk packages found under node_modules`);
  const allowedParents = new Set([path.join(root, 'byok-sdk')]);
  const scopeRoot = path.join(root, '@byok-sdk');
  if (existsSync(scopeRoot)) {
    for (const entry of readdirSync(scopeRoot)) allowedParents.add(path.join(scopeRoot, entry));
  }
  const nestedCopies = found.filter((manifestPath) => !allowedParents.has(path.dirname(manifestPath)));
  if (nestedCopies.length > 0) {
    throw new Error(`split @byok-sdk version set — nested copies installed:\n  ${nestedCopies.join('\n  ')}`);
  }
  const seenNames = new Set();
  for (const manifestPath of found) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch (cause) { throw new Error(`Invalid installed package manifest: ${manifestPath}`, { cause }); }
    const expected = expectedVersions[manifest.name];
    if (typeof expected !== 'string') {
      throw new Error(`${manifestPath}: unexpected @byok-sdk package ${manifest.name} in the ${context} install`);
    }
    if (manifest.version !== expected) {
      throw new Error(`${manifestPath}: version ${manifest.version}, expected ${expected} — the @byok-sdk graph does not close to its exact package versions`);
    }
    seenNames.add(manifest.name);
  }
  for (const packageName of Object.keys(expectedVersions)) {
    if (!seenNames.has(packageName)) {
      throw new Error(`${installDirectory}: missing expected ${context} package ${packageName}`);
    }
  }
  console.log(`[${context}] install tree closes to exact package versions (${found.length} package(s))`);
}

export function assertNpmCoreClosure(tree, expectedVersion, context) {
  const versions = new Set();
  function collect(value) {
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [name, entry] of Object.entries(value)) {
      if (name === '@byok-sdk/core' && entry && typeof entry === 'object' && typeof entry.version === 'string') {
        versions.add(entry.version);
      }
      collect(entry);
    }
  }
  collect(tree);
  if (versions.size !== 1 || !versions.has(expectedVersion)) {
    throw new Error(
      `npm ls @byok-sdk/core --all --json resolved ${[...versions].sort().join(', ') || '(none)'}, expected only ${expectedVersion}`,
    );
  }
  console.log(`[${context}] npm ls @byok-sdk/core --all --json resolves only ${expectedVersion}`);
}

