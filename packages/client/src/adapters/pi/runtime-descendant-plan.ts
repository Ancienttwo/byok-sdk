import { isDeepStrictEqual } from 'node:util';
import {
  descendantTemplateDigest, parseImplementationSpawnBinding, parseRuntimeDescendantPolicy,
  RUNTIME_DESCENDANT_EDGES, RUNTIME_ENTRIES, runtimeEntryFixedArgv,
  type ImplementationSpawnBindingV1, type RuntimeDescendantEdgeV1,
  type RuntimeDescendantPolicyV1, type RuntimeEntryV1,
} from '@byok-sdk/implementation-identity';

export interface RuntimeDescendantDeclarationV1 {
  readonly descendantPolicy: RuntimeDescendantPolicyV1;
  readonly edges: readonly RuntimeDescendantEdgeV1[];
}
export interface RuntimeDescendantTemplateV1 {
  readonly kind: RuntimeEntryV1;
  readonly template: ImplementationSpawnBindingV1;
  readonly templateDigest: string;
}
export interface RuntimeDescendantPlanV1 {
  readonly format: 'byok.runtime-launch-plan';
  readonly version: 1;
  readonly selfKind: RuntimeEntryV1;
  readonly policy: RuntimeDescendantPolicyV1;
  readonly edges: readonly RuntimeDescendantEdgeV1[];
  readonly templates: readonly RuntimeDescendantTemplateV1[];
}
function fail(reason: string): never { throw new Error(`runtime_launch_plan_${reason}`); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function isKind(value: unknown): value is RuntimeEntryV1 {
  return typeof value === 'string' && (RUNTIME_ENTRIES as readonly string[]).includes(value);
}
function validEdges(value: unknown): value is readonly RuntimeDescendantEdgeV1[] {
  return Array.isArray(value) && value.length === RUNTIME_DESCENDANT_EDGES.length
    && Array.from(value).every((edge, i) => exact(edge, ['parent', 'child', 'inheritsCredential'])
      && isDeepStrictEqual(edge, RUNTIME_DESCENDANT_EDGES[i]));
}
function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
/** The finite type closure is independent of instance depth/budget admission. */
export function requiredRuntimePlanKinds(
  selfKind: RuntimeEntryV1, policy: RuntimeDescendantPolicyV1, edges: readonly RuntimeDescendantEdgeV1[],
): readonly RuntimeEntryV1[] {
  if (!isKind(selfKind) || !parseRuntimeDescendantPolicy(policy) || !validEdges(edges)) fail('invalid_declaration');
  const result = new Set<RuntimeEntryV1>([selfKind]);
  if (policy.maxDepth > 0) {
    for (const parent of result) for (const edge of edges) if (edge.parent === parent) result.add(edge.child);
  }
  return Object.freeze([...result]);
}
function commonBinding(binding: ImplementationSpawnBindingV1): unknown {
  if (binding.identity.kind !== 'attested') fail('unattested_template');
  const { launchArgv: _launchArgv, ...identity } = binding.identity;
  const { fixedArgv: _fixedArgv, identity: _identity, ...physical } = binding;
  return { ...physical, identity };
}
/** Validate raw template bytes before any V1 parser projection changes member order. */
export function parseRuntimeDescendantPlan(
  value: unknown, selfKind: RuntimeEntryV1, selfBinding: ImplementationSpawnBindingV1,
  expectedDeclaration?: RuntimeDescendantDeclarationV1,
): RuntimeDescendantPlanV1 | null {
  const parsedSelf = parseImplementationSpawnBinding(selfBinding);
  if (!parsedSelf || !isKind(selfKind)) fail('invalid_self_binding');
  if (parsedSelf.identity.kind === 'unavailable') {
    if (parsedSelf.identity.reason !== 'resolver_unconfigured' || value !== null || expectedDeclaration !== undefined) fail('unexpected_unconfigured_plan');
    return null;
  }
  if (!isDeepStrictEqual(parsedSelf.fixedArgv, runtimeEntryFixedArgv(selfKind))) fail('self_kind_mismatch');
  if (!exact(value, ['format', 'version', 'selfKind', 'policy', 'edges', 'templates'])
    || value.format !== 'byok.runtime-launch-plan' || value.version !== 1 || value.selfKind !== selfKind) fail('invalid_shape');
  const policy = parseRuntimeDescendantPolicy(value.policy);
  if (!policy || !validEdges(value.edges)) fail('invalid_declaration');
  if (expectedDeclaration !== undefined) {
    const expectedPolicy = parseRuntimeDescendantPolicy(expectedDeclaration.descendantPolicy);
    if (!expectedPolicy || !validEdges(expectedDeclaration.edges)
      || !isDeepStrictEqual(policy, expectedPolicy) || !isDeepStrictEqual(value.edges, expectedDeclaration.edges)) fail('declaration_mismatch');
  }
  const required = requiredRuntimePlanKinds(selfKind, policy, value.edges);
  if (!Array.isArray(value.templates) || value.templates.length !== required.length) fail('incomplete_templates');
  const seen = new Set<RuntimeEntryV1>();
  for (const row of value.templates) {
    if (!exact(row, ['kind', 'template', 'templateDigest']) || !isKind(row.kind)
      || !required.includes(row.kind) || seen.has(row.kind)) fail('invalid_template_row');
    if (typeof row.templateDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(row.templateDigest)
      || descendantTemplateDigest(row.template as ImplementationSpawnBindingV1) !== row.templateDigest) fail('template_digest_mismatch');
    const template = parseImplementationSpawnBinding(row.template);
    if (!template || template.identity.kind !== 'attested') fail('invalid_template');
    if (!isDeepStrictEqual(template.fixedArgv, runtimeEntryFixedArgv(row.kind))) fail('template_kind_mismatch');
    if (!isDeepStrictEqual(commonBinding(template), commonBinding(parsedSelf))) fail('template_identity_mismatch');
    if (row.kind === selfKind && JSON.stringify(row.template) !== JSON.stringify(selfBinding)) fail('self_template_mismatch');
    seen.add(row.kind);
  }
  // Preserve each digest preimage, and own immutable copies independent of the caller.
  return freezeJson(JSON.parse(JSON.stringify(value)) as RuntimeDescendantPlanV1);
}
/** Assemble already measured rows; this helper never resolves or measures Host records. */
export function createRuntimeDescendantPlan(
  selfKind: RuntimeEntryV1, selfBinding: ImplementationSpawnBindingV1,
  declaration?: RuntimeDescendantDeclarationV1,
  templates: readonly Pick<RuntimeDescendantTemplateV1, 'kind' | 'template'>[] = [],
): RuntimeDescendantPlanV1 | null {
  if (selfBinding.identity.kind === 'unavailable') {
    if (templates.length !== 0) fail('unexpected_unconfigured_templates');
    return parseRuntimeDescendantPlan(null, selfKind, selfBinding, declaration);
  }
  if (!declaration) fail('declaration_required');
  return parseRuntimeDescendantPlan({
    format: 'byok.runtime-launch-plan', version: 1, selfKind,
    policy: declaration.descendantPolicy, edges: declaration.edges,
    templates: templates.map(row => ({ ...row, templateDigest: descendantTemplateDigest(row.template) })),
  }, selfKind, selfBinding, declaration);
}
