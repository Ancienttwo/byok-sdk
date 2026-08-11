/**
 * Capability declaration (ADR-010).
 *
 * The rule being protected is "declare, do not sniff". `assertCapability` is
 * the enforcement point: a caller that asks first gets a named failure, instead
 * of issuing the request and having to decide whether a 404 meant "not built",
 * "wrong URL", or "proxy".
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_DECLARATION_SCHEMA_ID,
  assertCapability,
  hasCapability,
  parseCapabilityDeclaration,
} from '../capabilities';
import { isCoreError } from '../errors';

const declaration = {
  schema: CAPABILITY_DECLARATION_SCHEMA_ID,
  version: 3,
  capabilities: ['board.sse', 'storage.reservations', 'truth.manifest'],
};

function captureError(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (caught: unknown) {
    return caught;
  }
}

describe('capability declaration', () => {
  it('parses a well-formed declaration', () => {
    const parsed = parseCapabilityDeclaration(declaration);
    expect(parsed.version).toBe(3);
    expect(hasCapability(parsed, 'board.sse')).toBe(true);
    expect(hasCapability(parsed, 'board.websocket')).toBe(false);
  });

  it('fails closed on a wrong schema id, a bad name, a duplicate, and a negative version', () => {
    const broken: unknown[] = [
      { ...declaration, schema: 'byok-capabilities-v2' },
      { ...declaration, capabilities: ['Board.SSE'] },
      { ...declaration, capabilities: ['board.sse', 'board.sse'] },
      { ...declaration, capabilities: [''] },
      { ...declaration, version: -1 },
      { ...declaration, version: 1.5 },
    ];
    for (const input of broken) {
      const error = captureError(() => parseCapabilityDeclaration(input));
      expect(isCoreError(error, 'capability_declaration_invalid')).toBe(true);
    }
  });

  it('names the missing capability rather than leaving the caller to guess a status code', () => {
    const parsed = parseCapabilityDeclaration(declaration);
    expect(() => assertCapability(parsed, 'board.sse')).not.toThrow();

    const error = captureError(() => assertCapability(parsed, 'storage.presign'));
    expect(isCoreError(error, 'capability_unavailable')).toBe(true);
    expect((error as Error).message).toContain('storage.presign');
  });

  it('does not treat an unknown capability as available', () => {
    const parsed = parseCapabilityDeclaration({ ...declaration, capabilities: [] });
    expect(hasCapability(parsed, 'anything')).toBe(false);
  });
});
