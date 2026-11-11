// Test-only Node loader hook: lets a child `node` process run this package's
// TypeScript source directly (type stripping). The shipping source spells
// relative specifiers `./x.js` and these fixtures spell them `./x`; both
// resolve to the sibling `x.ts`.
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const base = specifier.endsWith('.js') ? specifier.slice(0, -3) : specifier;
    if (base !== specifier || !/\.(?:[cm]?[jt]s|json)$/u.test(specifier)) {
      try {
        return await next(`${base}.ts`, context);
      } catch {
        // fall through to the default resolution below
      }
    }
  }
  return next(specifier, context);
}
