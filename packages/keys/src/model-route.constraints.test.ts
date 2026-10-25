import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = path.dirname(fileURLToPath(import.meta.url));

/** The relative modules the entry loads at run time, following value imports only. */
function runtimeClosure(entry: string): { modules: string[]; bare: string[]; source: string } {
  const modules = new Set<string>();
  const bare = new Set<string>();
  const sources: string[] = [];
  const visit = (file: string): void => {
    if (modules.has(file)) return;
    modules.add(file);
    const text = readFileSync(path.join(src, file), 'utf8');
    // Comments may name what the code must not touch; only code is checked.
    sources.push(text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, ''));
    for (const match of text.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gmu)) {
      const [, typeOnly, specifier] = match;
      if (typeOnly !== undefined) continue;
      if (specifier!.startsWith('.')) visit(`${path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier!))}.ts`);
      else bare.add(specifier!);
    }
  };
  visit(entry);
  return { modules: [...modules].sort(), bare: [...bare].sort(), source: sources.join('\n') };
}

describe('@byok-sdk/keys/model-route entry boundary', () => {
  const closure = runtimeClosure('model-route.ts');

  it('loads only browser-safe modules', () => {
    expect(closure.modules).toEqual([
      'errors.ts',
      'model-route.ts',
      'pi-model-catalog.generated.ts',
      'pi-model-config.ts',
      'pi-runtime-defaults.generated.ts',
      'provider-catalog.ts',
      'provider-profile.ts',
      'secret-value.ts',
      'url.ts',
    ]);
    expect(closure.bare).toEqual(['zod']);
  });

  it('has no Node, network, environment or custody surface', () => {
    expect(closure.source).not.toMatch(/from ['"]node:/u);
    expect(closure.source).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|process\.env|require\()/u);
    expect(closure.source).not.toMatch(/\b(?:SecretStore|ProviderRegistry|Keychain|CredentialManager|Sqlite|DatabaseSync)\b/u);
  });
});
