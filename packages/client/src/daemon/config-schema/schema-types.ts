/**
 * The JSON Schema subset `generate-schema.mjs` emits for `DaemonConfig`, and
 * the only subset the validator interprets (#1094).
 */
export type DaemonConfigSurface = 'embedded-only' | 'distribution-owned';

export interface DaemonConfigJsonSchema {
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  readonly const?: string | number | boolean;
  readonly enum?: readonly (string | number | boolean)[];
  readonly anyOf?: readonly DaemonConfigJsonSchema[];
  readonly properties?: Readonly<Record<string, DaemonConfigJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: DaemonConfigJsonSchema;
  readonly items?: DaemonConfigJsonSchema;
  readonly prefixItems?: readonly DaemonConfigJsonSchema[];
  readonly minItems?: number;
  readonly maxItems?: number;
  /** Always `{}` here: set only on a surface-restricted property, so any value fails a JSON Schema validator. */
  readonly not?: Readonly<Record<string, never>>;
  readonly 'x-byok-surface'?: DaemonConfigSurface;
  /**
   * `function`: an embedded Host may pass a function instead of this object
   * schema; a config file must set the object.
   */
  readonly 'x-byok-embeddedAlternative'?: 'function';
  readonly 'x-byok-schemaVersion'?: number;
  readonly 'x-byok-removedFields'?: readonly { readonly path: string; readonly migration: string }[];
}
