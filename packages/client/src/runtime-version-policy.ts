import type {
  RuntimeDetectionAdvisory,
  RuntimeVersionPolicy,
  RuntimeVersionSpec,
  RuntimeVersionVerdict,
} from './types';

/** Which entry supplied the effective policy (#1103). */
export type RuntimeVersionPolicySource = 'descriptor' | 'adapter-option' | 'daemon-config' | 'none';

/** The three complete policy candidates; never merged, only replaced. */
export interface RuntimeVersionPolicyCandidates {
  /** The SDK/descriptor default. A descriptor default may not carry a block. */
  readonly descriptor?: RuntimeVersionPolicy;
  /** A Host constructing an adapter directly. */
  readonly adapterOption?: RuntimeVersionPolicy;
  /** `createDaemon` from `DaemonConfig.runtimes.<id>.versionPolicy`. */
  readonly daemonConfig?: RuntimeVersionPolicy;
}

export interface RuntimeVersionPolicyResolution {
  /** The winning candidate's frozen copy; absent when all three are absent. */
  readonly policy?: RuntimeVersionPolicy;
  readonly source: RuntimeVersionPolicySource;
  /** Lower-priority candidates that were present and replaced. Diagnostic only. */
  readonly overridden: readonly ('descriptor' | 'adapter-option')[];
}

export type RuntimeVersionPolicyIssueReason =
  | 'invalid_policy'
  | 'invalid_qualified_version'
  | 'invalid_unqualified'
  | 'invalid_spec'
  | 'duplicate_spec'
  | 'block_requires_host';

/** One reason a policy is unusable. Shared by resolver construction and `config check`. */
export interface RuntimeVersionPolicyIssue {
  readonly reason: RuntimeVersionPolicyIssueReason;
  /** Dotted path within the candidate, for example `versionPolicy.block[0].prefix`. */
  readonly path: string;
  readonly message: string;
}

/** A descriptor default, adapter option or daemon policy failed validation (#1103). */
export class InvalidRuntimeVersionPolicyError extends Error {
  readonly code = 'invalid_version_policy' as const;

  constructor(readonly issues: readonly RuntimeVersionPolicyIssue[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'InvalidRuntimeVersionPolicyError';
  }
}

const UNQUALIFIED = ['allow', 'warn', 'block'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function specKey(spec: RuntimeVersionSpec): string {
  return spec.kind === 'exact' ? `exact:${spec.version}` : `prefix:${spec.prefix}`;
}

function matchedText(spec: RuntimeVersionSpec): string {
  return spec.kind === 'exact' ? spec.version : spec.prefix;
}

function matches(spec: RuntimeVersionSpec, token: string): boolean {
  return spec.kind === 'exact' ? token === spec.version : token.startsWith(spec.prefix);
}

function matchedIn(specs: readonly RuntimeVersionSpec[] | undefined, token: string): RuntimeVersionSpec | undefined {
  return specs?.find((spec) => matches(spec, token));
}

/**
 * Validate one complete policy candidate. `hostLayer: false` rejects a
 * descriptor default that carries a block or `unqualified: 'block'`: the SDK
 * never refuses a runtime version on its own (#1103 D3).
 */
export function runtimeVersionPolicyIssues(
  input: unknown,
  options: { readonly path: string; readonly hostLayer: boolean },
): RuntimeVersionPolicyIssue[] {
  const { path, hostLayer } = options;
  const issues: RuntimeVersionPolicyIssue[] = [];
  if (!isObject(input)) {
    return [{ reason: 'invalid_policy', path, message: `${path} must be a complete version policy object` }];
  }
  const qualifiedVersion = input.qualifiedVersion;
  if (typeof qualifiedVersion !== 'string' || qualifiedVersion.length === 0) {
    issues.push({ reason: 'invalid_qualified_version', path: `${path}.qualifiedVersion`, message: `${path}.qualifiedVersion must be a non-empty string` });
  }
  const unqualified = input.unqualified;
  if (typeof unqualified !== 'string' || !(UNQUALIFIED as readonly string[]).includes(unqualified)) {
    issues.push({ reason: 'invalid_unqualified', path: `${path}.unqualified`, message: `${path}.unqualified must be one of "allow", "warn", "block"` });
  }
  const seen = new Map<string, string>();
  for (const listName of ['allow', 'warn', 'block'] as const) {
    const list = input[listName];
    if (list === undefined) continue;
    const listPath = `${path}.${listName}`;
    if (!Array.isArray(list)) {
      issues.push({ reason: 'invalid_policy', path: listPath, message: `${listPath} must be an array of version specs` });
      continue;
    }
    list.forEach((raw, index) => {
      const specPath = `${listPath}[${index}]`;
      if (!isObject(raw)) {
        issues.push({ reason: 'invalid_spec', path: specPath, message: `${specPath} must be an exact or prefix version spec` });
        return;
      }
      let key: string;
      if (raw.kind === 'exact') {
        if (typeof raw.version !== 'string' || raw.version.length === 0) {
          issues.push({ reason: 'invalid_spec', path: `${specPath}.version`, message: `${specPath}.version must be a non-empty exact version` });
          return;
        }
        key = `exact:${raw.version}`;
      } else if (raw.kind === 'prefix') {
        if (typeof raw.prefix !== 'string' || raw.prefix.length === 0) {
          issues.push({ reason: 'invalid_spec', path: `${specPath}.prefix`, message: `${specPath}.prefix must be a non-empty version prefix` });
          return;
        }
        if (!raw.prefix.endsWith('.')) {
          issues.push({ reason: 'invalid_spec', path: `${specPath}.prefix`, message: `${specPath}.prefix must end with "." so it matches whole version components` });
          return;
        }
        key = `prefix:${raw.prefix}`;
      } else {
        issues.push({ reason: 'invalid_spec', path: specPath, message: `${specPath}.kind must be "exact" or "prefix"` });
        return;
      }
      const previous = seen.get(key);
      if (previous !== undefined) {
        issues.push({ reason: 'duplicate_spec', path: specPath, message: `${specPath} duplicates a spec already listed in ${previous}` });
      } else {
        seen.set(key, listName);
      }
    });
  }
  if (!hostLayer) {
    if (Array.isArray(input.block) && input.block.length > 0) {
      issues.push({
        reason: 'block_requires_host', path: `${path}.block`,
        message: `${path}.block must be empty in a descriptor default; configure a version block through the adapter option or DaemonConfig.runtimes.<id>.versionPolicy (block_requires_host)`,
      });
    }
    if (input.unqualified === 'block') {
      issues.push({
        reason: 'block_requires_host', path: `${path}.unqualified`,
        message: `${path}.unqualified must not be "block" in a descriptor default; configure it through the adapter option or DaemonConfig.runtimes.<id>.versionPolicy (block_requires_host)`,
      });
    }
  }
  return issues;
}

/** Deep, frozen copy of a validated policy. Never retains the caller's arrays. */
export function freezeRuntimeVersionPolicy(policy: RuntimeVersionPolicy): RuntimeVersionPolicy {
  const freezeSpec = (spec: RuntimeVersionSpec): RuntimeVersionSpec => spec.kind === 'exact'
    ? Object.freeze({ kind: 'exact' as const, version: spec.version })
    : Object.freeze({ kind: 'prefix' as const, prefix: spec.prefix });
  return Object.freeze({
    qualifiedVersion: policy.qualifiedVersion,
    unqualified: policy.unqualified,
    ...(policy.allow === undefined ? {} : { allow: Object.freeze(policy.allow.map(freezeSpec)) }),
    ...(policy.warn === undefined ? {} : { warn: Object.freeze(policy.warn.map(freezeSpec)) }),
    ...(policy.block === undefined ? {} : { block: Object.freeze(policy.block.map(freezeSpec)) }),
  });
}

/**
 * The ONLY precedence function for version policies (#1103 O5).
 * `daemonConfig > adapterOption > descriptor`, wholesale replacement, with
 * every present candidate validated. No caller may merge policies itself.
 */
export function resolveRuntimeVersionPolicy(candidates: RuntimeVersionPolicyCandidates): RuntimeVersionPolicyResolution {
  const entries = [
    ['descriptor', candidates.descriptor, false],
    ['adapterOption', candidates.adapterOption, true],
    ['daemonConfig', candidates.daemonConfig, true],
  ] as const;
  const issues: RuntimeVersionPolicyIssue[] = [];
  for (const [name, policy, hostLayer] of entries) {
    if (policy === undefined) continue;
    issues.push(...runtimeVersionPolicyIssues(policy, { path: `${name}.versionPolicy`, hostLayer }));
  }
  if (issues.length > 0) throw new InvalidRuntimeVersionPolicyError(issues);

  const chosen = candidates.daemonConfig !== undefined
    ? ['daemon-config', candidates.daemonConfig] as const
    : candidates.adapterOption !== undefined
      ? ['adapter-option', candidates.adapterOption] as const
      : candidates.descriptor !== undefined
        ? ['descriptor', candidates.descriptor] as const
        : undefined;
  const overridden: ('descriptor' | 'adapter-option')[] = [];
  if (chosen?.[0] === 'daemon-config') {
    if (candidates.descriptor !== undefined) overridden.push('descriptor');
    if (candidates.adapterOption !== undefined) overridden.push('adapter-option');
  } else if (chosen?.[0] === 'adapter-option' && candidates.descriptor !== undefined) {
    overridden.push('descriptor');
  }
  return {
    ...(chosen === undefined ? {} : { policy: freezeRuntimeVersionPolicy(chosen[1]) }),
    source: chosen?.[0] ?? 'none',
    overridden: Object.freeze(overridden),
  };
}

/**
 * The one verdict evaluator (#1103). Order: qualified token, block, allow,
 * warn, then `unqualified`. An absent token yields no verdict, preserving a
 * custom adapter's today behavior.
 */
export function runtimeVersionVerdict(
  policy: RuntimeVersionPolicy | undefined,
  token: string | undefined,
): RuntimeVersionVerdict | undefined {
  if (policy === undefined || token === undefined || token.length === 0) return undefined;
  if (token === policy.qualifiedVersion) return { state: 'allow', qualifiedVersion: policy.qualifiedVersion };
  const blocked = matchedIn(policy.block, token);
  if (blocked !== undefined) return { state: 'block', qualifiedVersion: policy.qualifiedVersion, matched: matchedText(blocked) };
  const allowed = matchedIn(policy.allow, token);
  if (allowed !== undefined) return { state: 'allow', qualifiedVersion: policy.qualifiedVersion, matched: matchedText(allowed) };
  const warned = matchedIn(policy.warn, token);
  if (warned !== undefined) return { state: 'warn', qualifiedVersion: policy.qualifiedVersion, matched: matchedText(warned) };
  if (policy.unqualified === 'block') return { state: 'block', qualifiedVersion: policy.qualifiedVersion, matched: 'unqualified' };
  return { state: policy.unqualified, qualifiedVersion: policy.qualifiedVersion };
}

/**
 * The `available` detect fields for one token: the verdict, and the existing
 * advisory exactly when the verdict is a warning. Adapters call this so the
 * verdict and the legacy advisory can never disagree (#1103 §2.4).
 */
export function runtimeVersionDetectionFields(
  policy: RuntimeVersionPolicy | undefined,
  token: string | undefined,
): { readonly versionVerdict?: RuntimeVersionVerdict; readonly advisory?: RuntimeDetectionAdvisory } {
  const verdict = runtimeVersionVerdict(policy, token);
  if (verdict === undefined) return {};
  return {
    versionVerdict: verdict,
    ...(verdict.state === 'warn'
      ? { advisory: { reason: 'runtime_version_unqualified' as const, qualifiedVersion: verdict.qualifiedVersion } }
      : {}),
  };
}
