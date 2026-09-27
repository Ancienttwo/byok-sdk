// Test-only Node loader hook: lets a child `node` process run this package's
// TypeScript source directly (type stripping), by resolving the extensionless
// relative specifiers the source uses to their `.ts` files.
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.(?:[cm]?[jt]s|json)$/u.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // fall through to the default resolution below
    }
  }
  return next(specifier, context);
}
