// Deterministic Host-visible surface snapshot for the upgrade manifest.
//
// A snapshot is a flat, sorted map of item id -> value digest, computed only
// from checked-in files of one tree (no build, no network, no clock). Two
// checkouts of the same commit produce byte-identical snapshots, and the
// snapshot of a release tag is the baseline the next release is gated against.
//
// Item ids, by category (docs/upgrade-manifest.md is the reader-facing copy):
//   entry:<specifier>                 public package.json export entry
//   export:<specifier>#<name>         exported name of a public entry; value is
//                                     the declaration digest from dts-surface.mjs
//   bin:<name>                        package.json `bin` of a public package
//   union:<union>#<member>            member of a Host-visible union type
//   store:<id>                        on-disk store format identity
//   example:<dir>                     vendored example (K4, K8) version + source digest
//   config:<field>                    top-level DaemonConfig field of the generated schema (#1094)
//   interprocess:<id>                 protocol version SDK processes must share to exclude each other (#1149)
//
// Every extractor fails loudly when the source shape it reads is not found, so
// a refactor that moves an authority breaks the gate instead of emptying a
// category.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { packageSurface, sha256, splitGolden, splitStatements } from './dts-surface.mjs';

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** The nine published packages, by `packages/<dir>`. */
export const PUBLIC_PACKAGES = ['client', 'cloud', 'cloud-dataplane', 'cloud-do', 'core', 'protocol', 'server', 'ui-runtime', 'keys'];

/**
 * Host-visible unions. Each one is read from a declaration in the gated
 * api-surface golden; `member` extracts the discriminators from that one
 * statement (raw text, comments removed, tsc indentation kept).
 */
export const UNIONS = [
  {
    // Every wire envelope type: the keys of the payload-schema registry.
    id: 'wire',
    golden: 'protocol',
    statement: /^export declare const MESSAGE_PAYLOAD_SCHEMAS:/,
    members: (text) => matchAll(text, /^ {4}readonly '([^']+)':/gm),
  },
  {
    // Runtime events carried in `task.progress` (`AgentEvent` discriminators).
    id: 'agent-event',
    golden: 'protocol',
    statement: /^export declare const AgentEventSchema:/,
    members: (text) => matchAll(text, /^ {4}type: z\.ZodLiteral<"([^"]+)">;$/gm),
  },
  {
    // What a runtime `Session.events` may yield beyond `AgentEvent`.
    id: 'session-event',
    golden: 'client',
    statement: /^export interface Session \{/,
    members: (text, context) => {
      const match = /^ {4}events: AsyncIterable<([^>]+)>;$/m.exec(text);
      if (!match) throw new Error('Session.events is not AsyncIterable<...>');
      return match[1].split('|').map((name) => name.trim()).map((name) => {
        if (name === 'AgentEvent') return 'AgentEvent';
        const member = context.statement('client', new RegExp(`^export interface ${name} \\{`));
        const type = /^ {4}type: '([^']+)';$/m.exec(member);
        if (!type) throw new Error(`${name} has no literal \`type\``);
        return type[1];
      });
    },
  },
  {
    // Local daemon events (`Daemon.on` / `onEvent`).
    id: 'daemon-event',
    golden: 'client',
    statement: /^export type DaemonEvent =/,
    members: (text) => matchAll(text, /^ {4}kind: '([^']+)';$/gm),
  },
  {
    // UI timeline items folded from activity.
    id: 'timeline-item',
    golden: 'ui-runtime',
    statement: /^export type TimelineItem =/,
    members: (text, context) => text
      .replace(/^export type TimelineItem =/, '')
      .replace(/;\s*$/, '')
      .split('|')
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => {
        const member = context.statement('ui-runtime', new RegExp(`^export interface ${name}\\b`));
        const kind = /^ {4}readonly kind: '([^']+)';$/m.exec(member);
        if (!kind) throw new Error(`${name} has no literal \`kind\``);
        return kind[1];
      }),
  },
];

/**
 * On-disk stores whose format a new build may refuse. `format` returns the
 * identity string recorded in the snapshot; the acceptance policy of a change
 * (accept | new-path-repair | reject) is declared on its manifest entry.
 */
export const STORES = [
  {
    id: 'server-sqlite',
    source: 'packages/server/src/stores/sqlite/index.ts',
    format: (root, file) => `schema_version=${requireMatch(read(root, file), /^const SQLITE_SCHEMA_VERSION = '([^']+)';$/m, file)}`,
  },
  {
    id: 'client-journal',
    source: 'packages/client/src/daemon/journal/sqlite-journal.ts',
    format: (root, file) => `ddl-sha256=${ddlDigest(root, file, ['SCHEMA'])}`,
  },
  {
    id: 'keys-profile-store',
    source: 'packages/keys/src/sqlite-profile-store.ts',
    format: (root, file) => `ddl-sha256=${ddlDigest(root, file, ['SCHEMA', 'ENABLED_INDEX'])}`,
  },
  {
    // Hosted Postgres: forward migrations authored only in deploy/sql and
    // applied by cloud-dataplane `migrate()`.
    id: 'cloud-dataplane-postgres',
    source: 'deploy/sql',
    format: (root, dir) => {
      const files = listFiles(root, dir).filter((file) => /\/\d{4}_[a-z0-9_]+\.sql$/.test(file));
      if (files.length === 0) throw new Error(`${dir} has no migrations`);
      const digest = sha256(files.map((file) => `${path.posix.basename(file)} ${fileDigest(root, file)}`).join('\n'));
      return `migrations=${files.length} last=${path.posix.basename(files.at(-1))} sha256=${digest.slice(0, 16)}`;
    },
  },
  {
    // pi-durable's SQLite schema belongs to the pinned upstream package.
    id: 'pi-durable',
    source: 'packages/client/package.json',
    format: (root, file) => {
      const version = readJson(root, file).dependencies?.['@earendil-works/pi-durable'];
      if (typeof version !== 'string') throw new Error(`${file} does not pin @earendil-works/pi-durable`);
      return `@earendil-works/pi-durable@${version}`;
    },
  },
];

/**
 * Protocols between SDK processes on one machine. Processes of two releases
 * whose versions differ do not exclude each other, so a change is breaking:
 * stop every SDK process before the upgrade. `constant` is an exported
 * integer in `source`.
 */
export const INTERPROCESS_PROTOCOLS = [
  { id: 'path-mutation-gate', source: 'packages/client/src/util/path-mutation-gate.ts', constant: 'PATH_MUTATION_GATE_PROTOCOL' },
];

/** Examples that Hosts copy (vendor) instead of installing. */
export const VENDORED_EXAMPLES = [
  { id: 'host-execution-core', label: 'K4' },
  { id: 'bot-collaboration', label: 'K8' },
];

/**
 * `config:<field>` items (#1094): one per top-level `DaemonConfig` field of
 * the generated, checked-in schema. The value is the field's tier
 * (required/optional, and its surface when restricted) and a digest of its
 * schema without documentation, so a doc-comment edit is not a change.
 *
 * @typedef {{ id: `config:${string}`, value: string }} ConfigFieldItem
 * @param {string} root
 * @param {(file: string) => string} track
 * @returns {ConfigFieldItem[]}
 */
export function configFieldItems(root, track = (file) => file) {
  const schema = readJson(root, track(CONFIG_SCHEMA_PATH));
  if (schema?.type !== 'object' || schema.properties === null || typeof schema.properties !== 'object') {
    throw new Error(`${CONFIG_SCHEMA_PATH}: expected a generated DaemonConfig object schema`);
  }
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties);
  if (fields.length === 0) throw new Error(`${CONFIG_SCHEMA_PATH}: DaemonConfig has no properties`);
  return fields.map(([field, property]) => {
    const surface = property['x-byok-surface'];
    const tier = [required.has(field) ? 'required' : 'optional', ...(surface === undefined ? [] : [surface])].join(' ');
    return { id: `config:${field}`, value: `${tier} schema-sha256=${sha256(JSON.stringify(withoutDocs(property))).slice(0, 16)}` };
  });
}
export const CONFIG_SCHEMA_PATH = 'packages/client/daemon-config.schema.json';
export const CONFIG_FIELDS_STATUS = { status: 'tracked', source: CONFIG_SCHEMA_PATH, owner: '#1094' };

function withoutDocs(value) {
  if (Array.isArray(value)) return value.map(withoutDocs);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, child]) => [key, withoutDocs(child)]));
}

function matchAll(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

function requireMatch(text, pattern, file) {
  const match = pattern.exec(text);
  if (!match) throw new Error(`${file}: ${pattern} not found`);
  return match[1];
}

// Text read with LF line endings, so a CRLF checkout snapshots identically.
function read(root, file) {
  return readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
}

const fileDigest = (root, file) => sha256(read(root, file));

function readJson(root, file) {
  return JSON.parse(read(root, file));
}

// Normalised digest of `const NAME = \`...\`;` SQL templates. An interpolated
// `${fn(CONST)}` is replaced by the source of `CONST`'s array literal, looked
// up in the same package's src, so widening an enum CHECK changes the digest.
function ddlDigest(root, file, names) {
  const source = read(root, file);
  const packageSrc = file.split('/').slice(0, 3).join('/');
  const parts = names.map((name) => {
    const template = requireMatch(source, new RegExp(`^const ${name} = \`([\\s\\S]*?)\`;$`, 'm'), file);
    return template.replace(/\$\{[^}]*?\b([A-Z][A-Z0-9_]+)\b[^}]*\}/g, (_, constant) => arrayLiteral(root, packageSrc, constant));
  });
  return sha256(parts.join('\n').replace(/\s+/g, ' ').trim()).slice(0, 16);
}

function arrayLiteral(root, dir, constant) {
  const pattern = new RegExp(`^(?:export )?const ${constant}\\b[^=]*=\\s*(\\[[\\s\\S]*?\\])`, 'm');
  for (const file of listFiles(root, dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
    const match = pattern.exec(read(root, file));
    if (match) return match[1].replace(/\s+/g, ' ');
  }
  throw new Error(`${dir}: const ${constant} array literal not found`);
}

function listFiles(root, dir) {
  const out = [];
  const walk = (relative) => {
    const absolute = path.join(root, relative);
    for (const name of readdirSync(absolute).sort()) {
      if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
      const child = `${relative}/${name}`;
      if (statSync(path.join(root, child)).isDirectory()) walk(child);
      else out.push(child);
    }
  };
  walk(dir);
  return out;
}

function goldenStatement(goldens, pkg, pattern) {
  const found = [];
  for (const source of splitGolden(goldens.get(pkg)).values()) {
    for (const statement of splitStatements(source, { raw: true })) {
      if (pattern.test(statement)) found.push(statement);
    }
  }
  if (found.length !== 1) throw new Error(`api-surface/${pkg}.d.ts: expected one statement matching ${pattern}, found ${found.length}`);
  return found[0];
}

/** Build the snapshot of the tree at `root`. */
export function buildSnapshot(root) {
  const sources = new Map();
  const track = (file) => {
    sources.set(file, fileDigest(root, file));
    return file;
  };
  const items = new Map();
  const add = (id, value) => {
    if (items.has(id)) throw new Error(`duplicate snapshot item ${id}`);
    items.set(id, value);
  };

  // Entries and exports, from the api-surface goldens.
  const entries = JSON.parse(read(root, track('api-surface/entries.json')));
  const goldens = new Map();
  for (const pkg of PUBLIC_PACKAGES) goldens.set(pkg, read(root, track(`api-surface/${pkg}.d.ts`)));
  for (const pkg of PUBLIC_PACKAGES) {
    const prefix = `packages/${pkg}/`;
    const entryFiles = new Map();
    for (const [specifier, entry] of Object.entries(entries)) {
      if (entry.kind !== 'exports' || !entry.facts?.target?.startsWith(prefix)) continue;
      add(`entry:${specifier}`, 'exports');
      const types = entry.facts.types ?? [];
      if (types.length > 1) throw new Error(`${specifier}: more than one types file`);
      if (types.length === 1) entryFiles.set(specifier, types[0].slice(prefix.length));
    }
    const surface = packageSurface({ golden: goldens.get(pkg), entryFiles });
    for (const [specifier, exported] of surface.entries) {
      for (const [name, digest] of exported) add(`export:${specifier}#${name}`, digest);
    }
  }

  // Bins, from the public package manifests.
  let version = null;
  for (const pkg of PUBLIC_PACKAGES) {
    const manifest = JSON.parse(read(root, track(`packages/${pkg}/package.json`)));
    if (manifest.private) throw new Error(`packages/${pkg} is private but listed as public`);
    if (pkg === 'client') version = manifest.version;
    for (const [name, target] of Object.entries(manifest.bin ?? {})) add(`bin:${name}`, `${manifest.name} ${target}`);
  }

  // Unions.
  const context = { statement: (pkg, pattern) => goldenStatement(goldens, pkg, pattern) };
  for (const union of UNIONS) {
    const members = union.members(goldenStatement(goldens, union.golden, union.statement), context);
    if (members.length === 0) throw new Error(`union ${union.id} has no members`);
    for (const member of new Set(members)) add(`union:${union.id}#${member}`, 'member');
  }

  // Stores.
  for (const store of STORES) {
    const isFile = statSync(path.join(root, store.source)).isFile();
    add(`store:${store.id}`, store.format(root, isFile ? track(store.source) : store.source));
  }

  // Interprocess protocols.
  for (const protocol of INTERPROCESS_PROTOCOLS) {
    const pattern = new RegExp(`^export const ${protocol.constant} = (\\d+);$`, 'm');
    add(`interprocess:${protocol.id}`, `protocol=${requireMatch(read(root, track(protocol.source)), pattern, protocol.source)}`);
  }

  // Vendored examples.
  for (const example of VENDORED_EXAMPLES) {
    const dir = `examples/${example.id}`;
    const manifest = JSON.parse(read(root, track(`${dir}/package.json`)));
    if (!existsSync(path.join(root, dir, 'src'))) throw new Error(`${dir}/src is missing`);
    const files = listFiles(root, `${dir}/src`).filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file));
    const digest = sha256(files.map((file) => `${file.slice(dir.length + 1)} ${fileDigest(root, track(file))}`).join('\n'));
    add(`example:${example.id}`, `${example.label} ${manifest.version} src-sha256=${digest.slice(0, 16)}`);
  }

  for (const item of configFieldItems(root, track)) add(item.id, item.value);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    version,
    items: Object.fromEntries([...items].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    sources: Object.fromEntries([...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}

/** Digest that pins a snapshot's version and items (sources are provenance only). */
export function snapshotDigest(snapshot) {
  return sha256(JSON.stringify({ schemaVersion: snapshot.schemaVersion, version: snapshot.version, items: snapshot.items }));
}
