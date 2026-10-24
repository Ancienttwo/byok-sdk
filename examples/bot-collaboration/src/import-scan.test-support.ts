/** One import scanner for the #606 §5.5 rules boundary and the vendor manifest (#886). */
export interface ImportRow { from: string; names?: string[] }

/** Drops comments, so a scan sees code and not prose about code. */
export function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
/** Static imports and re-exports, also on several lines, with their named bindings; then side-effect imports, `import()` and `require()`. */
export function imports(source: string): ImportRow[] {
  const text = code(source), found: ImportRow[] = [];
  for (const [, clause, from] of text.matchAll(/\b(?:import|export)\b([^'"`;]*?)\bfrom\s*['"]([^'"]+)['"]/g)) {
    const list = /\{([^}]*)\}/.exec(clause!)?.[1];
    found.push({ from: from!, ...(list === undefined ? {} : {
      names: list.split(',').map(name => name.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!).filter(Boolean) }) });
  }
  for (const [, from] of text.matchAll(/\b(?:import\s*\(?|require\s*\()\s*['"]([^'"]+)['"]/g)) found.push({ from: from! });
  return found;
}
