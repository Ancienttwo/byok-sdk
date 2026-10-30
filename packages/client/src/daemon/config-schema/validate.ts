import { DAEMON_CONFIG_SCHEMA } from './schema.generated';
import type { DaemonConfigJsonSchema } from './schema-types';
import { REMOVED_DAEMON_CONFIG_FIELDS, type RemovedDaemonConfigField } from './removed-fields';

/**
 * Where a `DaemonConfig` comes from (#1094).
 *
 * - `cli`: a `byok-agent` JSON config file. Embedded-only fields (functions,
 *   transports), the function form of a field that also has an object form
 *   (`toolAuthorization`) and the distribution-owned `localAgentRelease` are
 *   errors.
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
  | 'unknown_field'
  | 'removed_field'
  | 'embedded_only'
  | 'distribution_owned';

/**
 * One finding of {@link validateDaemonConfig}. Messages name the field path
 * and the expected type, never the supplied value.
 */
export interface DaemonConfigIssue {
  /** `warning` never stops a daemon (Q4'); `byok-agent config check --strict` fails on it. */
  readonly severity: 'error' | 'warning';
  readonly code: DaemonConfigIssueCode;
  /** Dotted path from the config root; `''` for the root itself. */
  readonly path: string;
  readonly message: string;
  /** Repo-relative `.md#anchor` of the migration note, for `removed_field`. */
  readonly migration?: string;
}

export interface DaemonConfigValidation {
  /** No `error` issue. Warnings do not affect it. */
  readonly ok: boolean;
  readonly issues: readonly DaemonConfigIssue[];
}

const REMOVED = new Map<string, RemovedDaemonConfigField>(REMOVED_DAEMON_CONFIG_FIELDS.map((field) => [field.path, field]));

/** The removed-field entry for `path`, if `path` names a removed `DaemonConfig` field. */
export function removedDaemonConfigField(path: string): RemovedDaemonConfigField | undefined {
  return REMOVED.get(path);
}

/**
 * The one `DaemonConfig` validator, shared by `byok-agent` (config files) and
 * daemon construction (#1094). It checks what the generated schema
 * (`daemon-config.schema.json`) expresses: required fields, JSON types and
 * literal values, unknown fields and removed fields. Value ranges and
 * cross-field rules stay with daemon construction, which reports them as
 * construction errors.
 *
 * An unknown field is a `warning`: a config written by a newer Host or SDK
 * must still start an older daemon after a rollback (Q4'). A removed field is
 * an `error` with its migration note, because the Host relied on it.
 */
export function validateDaemonConfig(input: unknown, options: { readonly source: DaemonConfigSource }): DaemonConfigValidation {
  const issues: DaemonConfigIssue[] = [];
  if (!isPlainObject(input)) {
    issues.push({ severity: 'error', code: 'not_an_object', path: '', message: `DaemonConfig must be a JSON object, got ${kindOf(input)}` });
  } else {
    validateObject(input, DAEMON_CONFIG_SCHEMA, '', options.source, issues, true);
  }
  return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
}

function validateValue(value: unknown, schema: DaemonConfigJsonSchema, path: string, source: DaemonConfigSource, issues: DaemonConfigIssue[]): void {
  const surface = schema['x-byok-surface'];
  if (surface !== undefined) {
    // Embedded construction validates these itself (functions, transports,
    // the distribution's release identity); a config file cannot carry them.
    if (source === 'embedded') return;
    issues.push(surface === 'embedded-only'
      ? { severity: 'error', code: 'embedded_only', path, message: `DaemonConfig.${path} is not expressible in a config file; only an embedded Host can pass it to createDaemon` }
      : { severity: 'error', code: 'distribution_owned', path, message: `config field "${path}" is distribution-owned and must not be supplied` });
    return;
  }
  const functionAlternative = schema['x-byok-embeddedAlternative'] === 'function';
  if (functionAlternative && typeof value === 'function') {
    // Embedded construction resolves the function; a config file sets the object form.
    if (source === 'cli') {
      issues.push({ severity: 'error', code: 'embedded_only', path, message: `DaemonConfig.${path} as a function is not expressible in a config file; set its object form, or pass the function from an embedded Host` });
    }
    return;
  }
  if (schema.anyOf !== undefined) {
    for (const branch of schema.anyOf) {
      const branchIssues: DaemonConfigIssue[] = [];
      validateValue(value, branch, path, source, branchIssues);
      if (!branchIssues.some((issue) => issue.severity === 'error')) {
        issues.push(...branchIssues);
        return;
      }
    }
    issues.push(typeIssue(path, describe(schema), value));
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
        issues.push({ severity: 'error', code: 'invalid_value', path, message: `DaemonConfig.${path} must have exactly ${schema.prefixItems.length} items` });
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
    const removed = REMOVED.get(child);
    if (removed !== undefined) {
      issues.push({ severity: 'error', code: 'removed_field', path: child, message: removed.message, migration: removed.migration });
      continue;
    }
    // A config file may name its schema for editors.
    if (root && key === '$schema') continue;
    const propertySchema = Object.hasOwn(properties, key) ? properties[key] : schema.additionalProperties;
    if (propertySchema === undefined) {
      const suggestion = closest(key, Object.keys(properties));
      issues.push({
        severity: 'warning', code: 'unknown_field', path: child,
        message: `DaemonConfig.${child} is not a known field and is ignored${suggestion === undefined ? '' : `; did you mean "${suggestion}"?`}`,
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
      issues.push({ severity: 'error', code: 'missing_required', path: child, message: root ? `config is missing required field "${key}"` : `DaemonConfig.${child} is required` });
    }
  }
}

function typeIssue(path: string, expected: string, value: unknown): DaemonConfigIssue {
  return { severity: 'error', code: 'invalid_type', path, message: `DaemonConfig.${path} must be ${expected}, got ${kindOf(value)}` };
}

function valueIssue(path: string, expected: string, value: unknown): DaemonConfigIssue {
  return { severity: 'error', code: 'invalid_value', path, message: `DaemonConfig.${path} must be ${expected}, got ${typeof value === 'string' ? 'another string' : kindOf(value)}` };
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
