// A published file must not name the install store
// (node_modules/.bun/<name>@<version>+<peer-hash>/...): the store directory
// moves with the lockfile, so the published bytes would change without a code
// change. Bodies are read as latin1 so a binary file is matched byte for byte.
const STORE_PATH = /node_modules[\\/]\.bun[\\/]/;

/** Throws when any `[name, body]` entry of `packageName`'s tarball names the install store. */
export function assertNoStorePaths(packageName, entries) {
  const found = [];
  for (const [name, body] of entries) {
    if (STORE_PATH.test(body.toString('latin1'))) found.push(name);
  }
  if (found.length > 0) {
    throw new Error(`${packageName}: published files name the install store (node_modules/.bun/): ${found.join(', ')}`);
  }
}
