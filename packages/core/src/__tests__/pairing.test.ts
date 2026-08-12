/**
 * The domain-equivalence falsifier for the nonce-signing authority.
 *
 * Two things are being defended, and they fail in opposite directions:
 *
 * 1. **Equivalence.** Moving a wire constant is only safe if the moved value is
 *    byte-identical to what the three ends were signing before. So this file
 *    does not merely assert `NONCE_SIGNING_DOMAIN === NONCE_SIGNING_DOMAIN`: it
 *    reads the three former definition sites out of the source tree and
 *    compares the bytes they now resolve to against core's. If a package ever
 *    re-introduces a local literal, this goes red rather than the drift going
 *    unnoticed for a release.
 * 2. **Separation.** A domain tag that is a prefix of another domain tag buys
 *    nothing — a signature over `tag_a || m` would be a signature over
 *    `tag_b || m'` for a suitable `m'`. So the nonce domain and the device-proof
 *    domain must be mutually non-prefixed.
 *
 * Reading sibling package sources from a test is the same freedom
 * `constraints.test.ts` uses: the test tree is excluded from
 * `tsconfig.build.json` and unreachable from the tsup entry, so `node:fs` here
 * says nothing about what the shipped source may import.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEVICE_PROOF_DOMAIN_PREFIX } from '../attestation';
import { NONCE_SIGNING_DOMAIN, nonceSigningBytes } from '../pairing';

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** `packages/core/src/__tests__/` → `packages/`. */
const PACKAGES_URL = new URL('../../../', import.meta.url);

/** The three files that each held their own copy of the literal before this authority existed. */
const FORMER_DEFINITION_SITES = [
  'client/src/daemon/device-keys.ts',
  'cloud/src/auth/verify.ts',
  'server/src/auth.ts',
] as const;

describe('nonce signing domain', () => {
  it('is byte-frozen', () => {
    // The literal is a wire constant: a device that signed the old bytes cannot
    // renew a token against a server expecting new ones. Spelled as raw bytes
    // so a change has to be made deliberately, in hex, not by editing a string.
    expect(hex(utf8(NONCE_SIGNING_DOMAIN))).toBe('62796f6b2d6e6f6e63652d76310a');
    expect(utf8(NONCE_SIGNING_DOMAIN)).toHaveLength(14);
    expect(NONCE_SIGNING_DOMAIN).toBe('byok-nonce-v1\n');
  });

  it('has no second definition left in the tree', () => {
    for (const site of FORMER_DEFINITION_SITES) {
      const source = readFileSync(new URL(site, PACKAGES_URL), 'utf8');

      // A local declaration is the drift this move exists to remove. Two copies
      // that happen to agree today are the state this repo was already in.
      //
      // Matched on the BINDING, not on a quote style: a re-declaration written
      // with double quotes, a backtick, or a computed value would be exactly as
      // much of a second authority, and can legally sit beside the re-export
      // line below without either check noticing.
      expect(
        /const\s+NONCE_SIGNING_DOMAIN\s*=/.test(source),
        `${site} re-declares the nonce domain instead of re-exporting core's`,
      ).toBe(false);

      // …and the public surface of each package is unchanged: the name still
      // resolves there, now as core's binding.
      expect(source, `${site} no longer exports NONCE_SIGNING_DOMAIN`).toMatch(
        /export\s*\{[^}]*NONCE_SIGNING_DOMAIN[^}]*\}\s*from\s*'@byok-sdk\/core'/,
      );
    }
  });

  it('is not a prefix of the device-proof domain, nor it of this one', () => {
    const nonce = utf8(NONCE_SIGNING_DOMAIN);
    const proof = utf8(DEVICE_PROOF_DOMAIN_PREFIX);
    expect(hex(proof.subarray(0, nonce.length))).not.toBe(hex(nonce));
    expect(hex(nonce.subarray(0, proof.length))).not.toBe(hex(proof));
    // The separation survives the concrete signing inputs, not just the tags.
    expect(hex(nonceSigningBytes('abc')).startsWith(hex(proof))).toBe(false);
  });
});

describe('nonceSigningBytes', () => {
  it('is the domain followed by the nonce, UTF-8', () => {
    expect(hex(nonceSigningBytes('n0nce'))).toBe(hex(utf8('byok-nonce-v1\nn0nce')));
    expect(hex(nonceSigningBytes(''))).toBe(hex(utf8(NONCE_SIGNING_DOMAIN)));
  });

  it('encodes non-ASCII nonces as UTF-8, never as UTF-16 code units', () => {
    // A nonce is base64url on every path that mints one, but the function is
    // total: if the encoding ever disagreed between two ends for a non-ASCII
    // input, the disagreement would be silent.
    expect(hex(nonceSigningBytes('é✓'))).toBe(hex(utf8(`${NONCE_SIGNING_DOMAIN}é✓`)));
  });

  it('returns bytes no caller can mutate into another caller', () => {
    const first = nonceSigningBytes('a');
    first[0] = 0;
    expect(hex(nonceSigningBytes('a'))).toBe(hex(utf8(`${NONCE_SIGNING_DOMAIN}a`)));
  });
});
