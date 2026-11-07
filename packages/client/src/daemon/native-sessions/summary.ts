import path from 'node:path';
import { redactSecrets } from '@byok-sdk/protocol';

const OMITTED = '[omitted: too long]';
const REDACTED = '[redacted]';

/** Summary-only rules deliberately do not change diagnostic SHA/UUID handling. */
export function redactSummary(text: string): string {
  return redactSecrets(text)
    // Path normalization collapses URL separators; the final scan must recognize them.
    .replace(/:\/(?!\/)[^\s/?#@]{1,256}@/g, `:/${REDACTED}@`)
    .replace(/[A-Za-z0-9]{24,65536}/g, token => /[A-Za-z]/.test(token) && /[0-9]/.test(token) ? REDACTED : token);
}

export function argumentSummary(
  name: string, args: Record<string, unknown>, home: string, cwd: string,
): Record<string, string> | undefined {
  if (name === 'bash') {
    if (typeof args.command !== 'string') return undefined;
    const ends = [args.command.indexOf('\r'), args.command.indexOf('\n')].filter(index => index >= 0);
    const words: string[] = [];
    for (const word of args.command.slice(0, Math.min(args.command.length, ...ends)).trim().split(/\s+/, 3)) {
      if (!/^[a-z][a-z0-9-]{0,22}$/.test(word)) break;
      words.push(word);
    }
    return words.length > 0 ? { command: words.join(' ') } : undefined;
  }
  if (!['read', 'write', 'edit', 'ls', 'find', 'grep'].includes(name)) return undefined;
  const summary: Record<string, string> = {};
  if (typeof args.path === 'string') {
    // Classify and bound the complete raw value before redaction or normalization.
    summary.path = args.path.includes('://') ? '[url]'
      : Buffer.byteLength(args.path) > 256 ? OMITTED
        : path.relative(home, path.resolve(cwd, redactSummary(args.path))) || '.';
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}
