import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { REMOVED_DAEMON_CONFIG_FIELDS } from '../../packages/client/src/daemon/config-schema/removed-fields.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const schema = JSON.parse(read('packages/client/daemon-config.schema.json'));
const catalog = JSON.parse(read('packages/client/src/daemon/setup-error-catalog.json'));
const cell = (value) => String(value).replaceAll('|', '&#124;').replaceAll('\n', ' ');
const table = (head, rows) => [head, head.replace(/[^|]/g, '-'), ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n');

// Presentation tiers only; field existence, shape, requiredness and surface come from the schema.
const common = new Set(['deviceName', 'storeDir', 'agentHome', 'runtimeAllowlist', 'runtimePreference', 'localToolApproval']);
function fields(properties, required = [], prefix = '') {
  return Object.entries(properties).flatMap(([name, value]) => {
    const field = prefix + name;
    const surface = value['x-byok-surface'];
    const tier = surface === 'distribution-owned' ? 'CLI-forbidden' : surface === 'embedded-only' ? 'embedded-only'
      : required.includes(name) ? (prefix ? 'required when parent is set' : 'required')
      : !prefix && common.has(name) ? 'common' : 'advanced';
    const shape = value.const !== undefined ? JSON.stringify(value.const) : value.enum ? value.enum.map(JSON.stringify).join(' / ')
      : value.type ?? (value.anyOf ? 'union' : surface ?? 'schema-defined');
    return [[`\`${field}\``, tier, shape], ...fields(value.properties ?? {}, value.required, `${field}.`)];
  });
}

export function declaredCodes() {
  const union = read('packages/client/src/daemon/config-schema/validate.ts').match(/export type DaemonConfigIssueCode\s*=([\s\S]*?);/);
  const halts = read('packages/client/src/daemon/daemon-lifecycle.ts').match(/export const DAEMON_HALT_REASONS\s*=\s*\[([\s\S]*?)\] as const/);
  if (!union || !halts) throw new Error('Setup error declarations changed shape; update coverage extraction.');
  const literals = (text) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const classes = ['packages/client/src/daemon/daemon-errors.ts', 'packages/client/src/daemon/config-schema/errors.ts']
    .flatMap((file) => [...read(file).matchAll(/readonly code\s*=\s*'([^']+)'/g)].map((m) => m[1]));
  if (!classes.length) throw new Error('No coded startup errors found');
  return [...new Set([...literals(union[1]), ...literals(halts[1]), ...classes])].sort();
}

export function validateCatalog(entries = catalog, codes = declaredCodes()) {
  const keys = Object.keys(entries).sort();
  if (JSON.stringify(keys) !== JSON.stringify(codes)) throw new Error(`Setup catalog coverage mismatch: declared=${codes.join(',')} catalog=${keys.join(',')}`);
  for (const [code, entry] of Object.entries(entries)) {
    if (typeof entry.retryable !== 'boolean' || !entry.nextStep || !/^#[a-z-]+$/.test(entry.anchor)) throw new Error(`Invalid setup catalog entry: ${code}`);
  }
}

export function generateGuide(current) {
  validateCatalog();
  const manifest = JSON.parse(read('packages/client/upgrade-manifest.json'));
  const sections = {
    fields: table('| Field | Tier | Shape |', fields(schema.properties, schema.required)),
    errors: table('| Code / halt reason | Retryable unchanged | Next step | Guide |', Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)).map(([code, entry]) => [`\`${code}\``, entry.retryable ? 'yes' : 'no', entry.nextStep, `[guide](${entry.anchor})`])),
    removed: table('| Removed field | Migration |', REMOVED_DAEMON_CONFIG_FIELDS.map((field) => [`\`${field.path}\``, field.message])),
    migrations: `Manifest transition: **${manifest.from.version} → ${manifest.to.version}**. Versions and entries below come from the current package manifest; they are not a release announcement.\n\n` + table('| Entry | Impact | Change and migration |', manifest.entries.filter((entry) => entry.items.some((item) => item.startsWith('config:')) || /local-tool-approval|wire-v4/.test(entry.id) || entry.migration === 'docs/spec.md#recommended-host-layout').map((entry) => [entry.id, entry.impact, `${entry.summary} [Migration](../${entry.migration})`])),
  };
  let result = current;
  for (const [name, content] of Object.entries(sections)) {
    const start = `<!-- generated:${name}:start -->`;
    const end = `<!-- generated:${name}:end -->`;
    if (result.split(start).length !== 2 || result.split(end).length !== 2) throw new Error(`Missing/duplicate generated section ${name}`);
    const before = result.indexOf(start) + start.length;
    const after = result.indexOf(end);
    result = result.slice(0, before) + '\n' + content + '\n' + result.slice(after);
  }
  for (const entry of Object.values(catalog)) {
    const heading = entry.anchor.slice(1).replaceAll('-', ' ');
    if (!result.toLowerCase().includes(`## ${heading}\n`)) throw new Error(`Missing guide anchor ${entry.anchor}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.join(root, 'docs/device-setup.md');
  const current = readFileSync(file, 'utf8');
  const generated = generateGuide(current);
  if (process.argv.includes('--write')) writeFileSync(file, generated);
  else if (generated !== current) throw new Error('Device setup guide is stale: bun run docs:device-setup');
  else console.log('Device setup guide: generated tables and error coverage PASS');
}
