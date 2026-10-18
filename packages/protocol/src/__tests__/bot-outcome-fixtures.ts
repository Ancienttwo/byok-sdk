import { resultOutcomeMaxBytes, type ResultSchema } from '../result-schema';
const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
type Node = ResultSchema;
/**
 * A large valid instance for the schemas this probe builds: every allowed
 * property present, every array full, every string full of U+0001 (6 bytes
 * each). Only handles the shapes used here; it is a witness, not a general
 * solver, and it can be smaller than the conservative bound.
 */
export function worstCaseInstance(schema: ResultSchema): unknown {
  const node = schema as Node;
  if (Object.hasOwn(node, 'const')) return node.const;
  if (Array.isArray(node.enum)) return [...node.enum].sort((a, b) => size(b) - size(a))[0];
  if (node.type === 'object' && Array.isArray(node.oneOf) && node.properties) {
    // Branches that only name allowed properties: fill each branch's names from
    // the outer properties and keep the largest instance.
    const outer = node.properties as Record<string, ResultSchema>;
    const fill = (names: string[]) => Object.fromEntries(names.map(k => [k, worstCaseInstance(outer[k]!)]));
    const options = node.oneOf.map(b => fill(Object.keys((b as Node).properties ?? outer)));
    return options.sort((a, b) => size(b) - size(a))[0];
  }
  if (Array.isArray(node.oneOf)) {
    const ranked = [...node.oneOf].sort((a, b) => (resultOutcomeMaxBytes(b) ?? 0) - (resultOutcomeMaxBytes(a) ?? 0));
    return worstCaseInstance(ranked[0]!);
  }
  switch (node.type) {
    case 'string': return '\u0001'.repeat(node.maxLength as number);
    case 'integer': {
      const ends = [Math.ceil(node.minimum as number), Math.floor(node.maximum as number)];
      return ends.sort((a, b) => size(b) - size(a))[0];
    }
    case 'array': return Array.from({ length: node.maxItems as number }, () => worstCaseInstance(node.items!));
    case 'object': return Object.fromEntries(Object.entries(node.properties ?? {}).map(([k, v]) => [k, worstCaseInstance(v)]));
    default: throw new Error(`worstCaseInstance: unsupported node ${JSON.stringify(node).slice(0, 80)}`);
  }
}
