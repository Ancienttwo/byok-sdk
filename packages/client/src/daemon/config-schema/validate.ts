import { DAEMON_CONFIG_SCHEMA } from './schema.generated.js';
import type { DaemonConfigJsonSchema } from './schema-types.js';

/**
 * Where a `DaemonConfig` comes from (#1094).
 *
 * - `cli`: a `byok-agent` JSON config file. Embedded-only fields (functions,
 *   transports) and the distribution-owned `localAgentRelease` are errors.
 * - `embedded`: an object a Host passes to `createDaemon` or
 *   `createDaemonWithAdapters`. Embedded-only fields are allowed and checked
 *   by daemon construction.
 */
export type DaemonConfigSource = 'cli' | 'embedded';

export type DaemonConfigIssueCode =
  | 'not_an_object'
  | 'missing_required'
  | 'invalid_type'
  | 'invalid_value'
  | 'invalid_version_policy'
  | 'invalid_file_scope'
  | 'unknown_field'
  | 'embedded_only'
  | 'distribution_owned';

/**
 * One finding of {@link validateDaemonConfig}. Messages name the field path
 * and the expected type, never the supplied value.
 */
export interface DaemonConfigIssue {
  readonly code: DaemonConfigIssueCode;
  /** Dotted path from the config root; `''` for the root itself. */
  readonly path: string;
  readonly message: string;
}

export interface DaemonConfigValidation {
  /** No issue. */
  readonly ok: boolean;
  readonly issues: readonly DaemonConfigIssue[];
}

/**
 * The one `DaemonConfig` validator, shared by `byok-agent` (config files) and
 * daemon construction (#1094). It checks what the generated schema
 * (`daemon-config.schema.json`) expresses: required fields, JSON types and
 * literal values and unknown fields. Value ranges and cross-field rules stay
 * with daemon construction, which reports them as construction errors.
 *
 * Every issue is an error: an unknown field, including one an older release
 * accepted, fails the config instead of being silently ignored.
 */
export function validateDaemonConfig(input: unknown, options: { readonly source: DaemonConfigSource }): DaemonConfigValidation {
  const issues: DaemonConfigIssue[] = [];
  if (!isPlainObject(input)) {
    issues.push({ code: 'not_an_object', path: '', message: `DaemonConfig must be a JSON object, got ${kindOf(input)}` });
  } else {
    validateObject(input, DAEMON_CONFIG_SCHEMA, '', options.source, issues, true);
  }
  return { ok: issues.length === 0, issues };
}

function validateValue(value: unknown, schema: DaemonConfigJsonSchema, path: string, source: DaemonConfigSource, issues: DaemonConfigIssue[]): void {
  const surface = schema['x-byok-surface'];
  if (surface !== undefined) {
    // Embedded construction validates these itself (functions, transports,
    // the distribution's release identity); a config file cannot carry them.
    if (source === 'embedded') return;
    issues.push(surface === 'embedded-only'
      ? { code: 'embedded_only', path, message: `DaemonConfig.${path} is not expressible in a config file; only an embedded Host can pass it to createDaemon` }
      : { code: 'distribution_owned', path, message: `config field "${path}" is distribution-owned and must not be supplied` });
    return;
  }
  const functionAlternative = schema['x-byok-embeddedAlternative'] === 'function';
  if (functionAlternative && typeof value === 'function') {
    // Embedded construction resolves the function; a config file sets the object form.
    if (source === 'cli') {
      issues.push({ code: 'embedded_only', path, message: `DaemonConfig.${path} as a function is not expressible in a config file; set its object form, or pass the function from an embedded Host` });
    }
    return;
  }
  if (schema.anyOf !== undefined) {
    // A branch the value fails only by unknown fields is the one it meant:
    // report those, with their suggestions, instead of the bare union type.
    let unknownOnly: DaemonConfigIssue[] | undefined;
    for (const branch of schema.anyOf) {
      const branchIssues: DaemonConfigIssue[] = [];
      validateValue(value, branch, path, source, branchIssues);
      if (branchIssues.length === 0) return;
      if (unknownOnly === undefined && branchIssues.every((issue) => issue.code === 'unknown_field')) unknownOnly = branchIssues;
    }
    issues.push(...(unknownOnly ?? [typeIssue(path, describe(schema), value)]));
    return;
  }
  if (schema.const !== undefined) {
    if (value !== schema.const) issues.push(valueIssue(path, describe(schema), value));
    return;
  }
  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value as string | number | boolean)) issues.push(valueIssue(path, describe(schema), value));
    return;
  }
  switch (schema.type) {
    case 'string':
    case 'number':
    case 'boolean':
      if (typeof value !== schema.type) issues.push(typeIssue(path, schema.type, value));
      return;
    case 'null':
      if (value !== null) issues.push(typeIssue(path, 'null', value));
      return;
    case 'array':
      if (!Array.isArray(value)) {
        issues.push(typeIssue(path, 'an array', value));
        return;
      }
      if (schema.prefixItems !== undefined && value.length !== schema.prefixItems.length) {
        issues.push({ code: 'invalid_value', path, message: `DaemonConfig.${path} must have exactly ${schema.prefixItems.length} items` });
        return;
      }
      value.forEach((item, index) => {
        const itemSchema = schema.prefixItems?.[index] ?? schema.items;
        if (itemSchema !== undefined) validateValue(item, itemSchema, `${path}[${index}]`, source, issues);
      });
      return;
    case 'object':
      if (!isPlainObject(value)) {
        issues.push(typeIssue(path, functionAlternative && source === 'embedded' ? 'an object or a function' : 'an object', value));
        return;
      }
      validateObject(value, schema, path, source, issues, false);
      return;
    case undefined:
      return;
  }
}

function validateObject(
  value: Record<string, unknown>,
  schema: DaemonConfigJsonSchema,
  path: string,
  source: DaemonConfigSource,
  issues: DaemonConfigIssue[],
  root: boolean,
): void {
  const properties = schema.properties ?? {};
  for (const key of Object.keys(value)) {
    const child = path === '' ? key : `${path}.${key}`;
    // A config file may name its schema for editors.
    if (root && key === '$schema') continue;
    const propertySchema = Object.hasOwn(properties, key) ? properties[key] : schema.additionalProperties;
    if (propertySchema === undefined) {
      const suggestion = closest(key, Object.keys(properties));
      issues.push({
        code: 'unknown_field', path: child,
        message: `DaemonConfig.${child} is not a known field${suggestion === undefined ? '' : `; did you mean "${suggestion}"?`}`,
      });
      continue;
    }
    if (value[key] === undefined) continue;
    validateValue(value[key], propertySchema, child, source, issues);
  }
  for (const key of schema.required ?? []) {
    // At the root an empty string is as missing as an absent field, as it was for the CLI.
    if (value[key] === undefined || value[key] === null || (root && value[key] === '')) {
      const child = path === '' ? key : `${path}.${key}`;
      issues.push({ code: 'missing_required', path: child, message: root ? `config is missing required field "${key}"` : `DaemonConfig.${child} is required` });
    }
  }
}

function typeIssue(path: string, expected: string, value: unknown): DaemonConfigIssue {
  return { code: 'invalid_type', path, message: `DaemonConfig.${path} must be ${expected}, got ${kindOf(value)}` };
}

function valueIssue(path: string, expected: string, value: unknown): DaemonConfigIssue {
  return { code: 'invalid_value', path, message: `DaemonConfig.${path} must be ${expected}, got ${typeof value === 'string' ? 'another string' : kindOf(value)}` };
}

function describe(schema: DaemonConfigJsonSchema): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum !== undefined) return `one of ${schema.enum.map((value) => JSON.stringify(value)).join(', ')}`;
  if (schema.anyOf !== undefined) return schema.anyOf.map(describe).join(' or ');
  if (schema.type === 'object' || schema.type === 'array') return `an ${schema.type}`;
  return schema.type ?? 'any value';
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The sibling within edit distance 2, for a likely typo. */
function closest(key: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}
