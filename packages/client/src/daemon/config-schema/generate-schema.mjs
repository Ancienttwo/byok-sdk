#!/usr/bin/env node
// Generates the DaemonConfig JSON schema from the `DaemonConfig` TypeScript
// interface (#1094). The interface is the one source: this script reads it
// through the TypeScript checker and writes two generated files that must
// never be edited by hand.
//
//   packages/client/daemon-config.schema.json
//       The published schema, with field documentation. Shipped in the
//       package beside package.json (like upgrade-manifest.json; not an
//       export, because workspace exports resolve into dist/) and read, with
//       no build, by the upgrade-manifest snapshot for `config:<field>` items.
//   packages/client/src/daemon/config-schema/schema.generated.ts
//       The same schema without documentation, for the runtime validator.
//
// Usage (from the repo root or anywhere):
//   node packages/client/src/daemon/config-schema/generate-schema.mjs           write both files
//   node packages/client/src/daemon/config-schema/generate-schema.mjs --check   exit 1 if either is stale
//
// Mapping rules:
// - A required property is in `required`, except a distribution-owned one.
// - A function, or an object whose members are all functions, or an object
//   that requires such a member, is not JSON-expressible: the property is
//   `x-byok-surface: "embedded-only"` with `not: {}`, so a config file that
//   sets it fails any JSON Schema validator.
// - A union of a function and one JSON-expressible object type (e.g.
//   `toolAuthorization`) is the object's schema plus
//   `x-byok-embeddedAlternative: "function"`: a config file sets the object
//   form, and an embedded Host may pass the function instead. Any other union
//   of embedded-only and JSON-expressible members is an error.
// - `localAgentRelease` is `x-byok-surface: "distribution-owned"`: the
//   distribution (the `byok-agent` bin) supplies it, a config file must not.
// - Objects are open in the schema (no `additionalProperties: false`): an
//   unknown field is a warning at runtime and an error only under
//   `byok-agent config check --strict` (Q4').

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { API, SymbolFlags, TypeFlags } from 'typescript/unstable/sync';

/** Bump when the shape of the generated schema (not of DaemonConfig) changes. */
export const DAEMON_CONFIG_SCHEMA_VERSION = 1;
const DISTRIBUTION_OWNED = new Set(['localAgentRelease']);

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '../../..');
const tsconfig = path.join(clientRoot, 'tsconfig.json');
const sourceFile = path.join(clientRoot, 'src/daemon/create-daemon.ts');
export const SCHEMA_JSON_PATH = path.join(clientRoot, 'daemon-config.schema.json');
export const SCHEMA_TS_PATH = path.join(here, 'schema.generated.ts');

async function generate() {
  // Node strips the types of this import-free module (engines >= 24).
  const { REMOVED_DAEMON_CONFIG_FIELDS } = await import(pathToFileURL(path.join(here, 'removed-fields.ts')).href);
  const api = new API({ cwd: clientRoot });
  try {
    const snapshot = api.updateSnapshot({ openProject: tsconfig });
    const project = snapshot.getProject(tsconfig);
    if (project === undefined) throw new Error(`no TypeScript project for ${tsconfig}`);
    const checker = project.checker;
    const file = project.program.getSourceFile(sourceFile);
    if (file === undefined) throw new Error(`${sourceFile} is not in the client project`);
    const marker = 'export interface DaemonConfig {';
    const at = file.text.indexOf(marker);
    if (at < 0) throw new Error(`${sourceFile}: "${marker}" not found`);
    const symbol = checker.getSymbolAtPosition(sourceFile, at + 'export interface '.length);
    if (symbol?.name !== 'DaemonConfig') throw new Error('DaemonConfig symbol not found');
    const root = new SchemaBuilder(checker).objectSchema(checker.getDeclaredTypeOfSymbol(symbol), { root: true });
    return {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'DaemonConfig',
      description: 'Configuration of one @byok-sdk/client daemon (byok-agent config file or createDaemon argument). Generated from the DaemonConfig TypeScript interface; do not edit.',
      'x-byok-schemaVersion': DAEMON_CONFIG_SCHEMA_VERSION,
      ...root,
      'x-byok-removedFields': REMOVED_DAEMON_CONFIG_FIELDS.map(({ path: field, migration }) => ({ path: field, migration })),
    };
  } finally {
    api.close();
  }
}

class SchemaBuilder {
  constructor(checker) {
    this.checker = checker;
    this.stack = new Set();
  }

  /** `{ schema, embeddedOnly }` for one type, `undefined` stripped. */
  typeSchema(type) {
    const flags = type.flags;
    if (flags & TypeFlags.Union) return this.unionSchema(type.getTypes());
    if (flags & (TypeFlags.Any | TypeFlags.Unknown)) return { schema: {}, embeddedOnly: false };
    if (flags & TypeFlags.String || flags & (TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) return data({ type: 'string' });
    if (flags & TypeFlags.Number) return data({ type: 'number' });
    if (flags & TypeFlags.Boolean) return data({ type: 'boolean' });
    if (flags & TypeFlags.Null) return data({ type: 'null' });
    if (flags & (TypeFlags.StringLiteral | TypeFlags.NumberLiteral)) return data({ const: type.value });
    if (flags & TypeFlags.BooleanLiteral) return data({ const: type.value === true });
    if (flags & TypeFlags.Intersection) {
      // A branded primitive (`string & { __brand }`) is its primitive.
      const primitive = type.getTypes().find((member) => member.flags & (TypeFlags.String | TypeFlags.Number | TypeFlags.Boolean));
      if (primitive !== undefined) return this.typeSchema(primitive);
      return this.objectResult(type);
    }
    if (flags & (TypeFlags.Object | TypeFlags.NonPrimitive)) return this.objectResult(type);
    throw new Error(`unsupported type ${this.checker.typeToString(type)} (flags ${flags})`);
  }

  unionSchema(members) {
    const present = members.filter((member) => !(member.flags & TypeFlags.Undefined));
    const literals = present.filter((member) => member.flags & (TypeFlags.StringLiteral | TypeFlags.NumberLiteral | TypeFlags.BooleanLiteral));
    const booleans = literals.filter((member) => member.flags & TypeFlags.BooleanLiteral);
    const rest = present.filter((member) => !literals.includes(member));
    const options = [];
    if (booleans.length === 2) options.push({ type: 'boolean' });
    const values = literals
      .filter((member) => booleans.length !== 2 || !(member.flags & TypeFlags.BooleanLiteral))
      .map((member) => (member.flags & TypeFlags.BooleanLiteral ? member.value === true : member.value));
    // Union member order follows checker type ids; sort so output is stable.
    values.sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    if (values.length === 1) options.push({ const: values[0] });
    else if (values.length > 1) options.push({ enum: values });
    const embedded = [];
    for (const member of rest) {
      const result = this.typeSchema(member);
      if (result.embeddedOnly) embedded.push(member);
      else options.push(result.schema);
    }
    if (options.length === 0) return embedded.length > 0 ? embeddedOnly() : { schema: {}, embeddedOnly: false };
    const schema = options.length === 1 ? options[0] : { anyOf: options };
    if (embedded.length === 0) return data(schema);
    const functions = embedded.filter((member) => this.checker.getSignaturesOfType(member, 0).length > 0);
    if (functions.length !== embedded.length || schema.type !== 'object') {
      const union = present.map((member) => this.checker.typeToString(member)).join(' | ');
      throw new Error(`unsupported union of embedded-only and JSON members: ${union}; only a function with one object type is supported`);
    }
    return data({ ...schema, 'x-byok-embeddedAlternative': 'function' });
  }

  objectResult(type) {
    const checker = this.checker;
    if (checker.isArrayType(type)) {
      const [element] = checker.getTypeArguments(type);
      const items = this.typeSchema(element);
      return items.embeddedOnly ? embeddedOnly() : data({ type: 'array', items: items.schema });
    }
    if (checker.isTupleType(type)) {
      const elements = checker.getTypeArguments(type).map((element) => this.typeSchema(element));
      if (elements.some((element) => element.embeddedOnly)) return embeddedOnly();
      return data({ type: 'array', prefixItems: elements.map((element) => element.schema), minItems: elements.length, maxItems: elements.length });
    }
    if (this.stack.has(type.id)) throw new Error(`recursive DaemonConfig type ${checker.typeToString(type)} is not supported`);
    this.stack.add(type.id);
    try {
      const schema = this.objectSchema(type, { root: false });
      return schema === undefined ? embeddedOnly() : data(schema);
    } finally {
      this.stack.delete(type.id);
    }
  }

  /**
   * The object schema, or `undefined` when the object is not JSON-expressible
   * (callable, all members functions, or a required member embedded-only).
   */
  objectSchema(type, { root }) {
    const checker = this.checker;
    const properties = {};
    const required = [];
    let dataMembers = 0;
    let requiresEmbedded = false;
    const symbols = checker.getPropertiesOfType(type);
    for (const symbol of symbols) {
      const optional = (symbol.flags & SymbolFlags.Optional) !== 0;
      const description = normalizeDoc(checker.getDocumentationCommentOfSymbol(symbol));
      let property;
      if (root && DISTRIBUTION_OWNED.has(symbol.name)) {
        property = { 'x-byok-surface': 'distribution-owned', not: {} };
      } else {
        const result = symbol.flags & SymbolFlags.Method
          ? embeddedOnly()
          : this.typeSchema(checker.getTypeOfSymbol(symbol));
        if (result.embeddedOnly) {
          property = { 'x-byok-surface': 'embedded-only', not: {} };
          if (!optional) requiresEmbedded = true;
        } else {
          property = result.schema;
          dataMembers += 1;
          if (!optional) required.push(symbol.name);
        }
      }
      properties[symbol.name] = description === '' ? property : { ...property, description };
    }
    const indexes = checker.getIndexInfosOfType(type);
    let additionalProperties;
    for (const index of indexes) {
      if (!(index.keyType.flags & TypeFlags.String)) continue;
      const value = this.typeSchema(index.valueType);
      if (value.embeddedOnly) return undefined;
      additionalProperties = value.schema;
      dataMembers += 1;
    }
    const callable = checker.getSignaturesOfType(type, 0).length > 0 || checker.getSignaturesOfType(type, 1).length > 0;
    if (!root && (callable || requiresEmbedded || (symbols.length > 0 && dataMembers === 0))) return undefined;
    const hasProperties = Object.keys(properties).length > 0;
    return {
      type: 'object',
      ...(hasProperties || additionalProperties === undefined ? { properties } : {}),
      ...(required.length === 0 ? {} : { required }),
      ...(additionalProperties === undefined ? {} : { additionalProperties }),
    };
  }
}

const data = (schema) => ({ schema, embeddedOnly: false });
const embeddedOnly = () => ({ schema: undefined, embeddedOnly: true });

/** Doc comments with tsc's indentation and trailing spaces removed. */
function normalizeDoc(text) {
  return text.split('\n').map((line) => line.trimEnd()).join('\n').trim();
}

function stripDescriptions(value) {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'description' && key !== '$schema' && key !== 'title')
    .map(([key, child]) => [key, stripDescriptions(child)]));
}

export function renderSchemaFiles(schema) {
  const json = `${JSON.stringify(schema, null, 2)}\n`;
  const runtime = stripDescriptions(schema);
  const ts = [
    '// GENERATED by generate-schema.mjs from the DaemonConfig interface (#1094). Do not edit.',
    '// Regenerate: node packages/client/src/daemon/config-schema/generate-schema.mjs',
    "import type { DaemonConfigJsonSchema } from './schema-types';",
    '',
    `export const DAEMON_CONFIG_SCHEMA_VERSION = ${DAEMON_CONFIG_SCHEMA_VERSION};`,
    '',
    `export const DAEMON_CONFIG_SCHEMA: DaemonConfigJsonSchema = ${JSON.stringify(runtime, null, 2)};`,
    '',
  ].join('\n');
  return { json, ts };
}

async function main() {
  const { json, ts } = renderSchemaFiles(await generate());
  const check = process.argv.includes('--check');
  const files = [[SCHEMA_JSON_PATH, json], [SCHEMA_TS_PATH, ts]];
  const stale = [];
  for (const [file, content] of files) {
    let current;
    try { current = readFileSync(file, 'utf8'); } catch { current = undefined; }
    if (current === content) continue;
    if (check) stale.push(path.relative(process.cwd(), file));
    else writeFileSync(file, content);
  }
  if (stale.length > 0) {
    console.error(`stale generated DaemonConfig schema: ${stale.join(', ')}\nrun node packages/client/src/daemon/config-schema/generate-schema.mjs`);
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
