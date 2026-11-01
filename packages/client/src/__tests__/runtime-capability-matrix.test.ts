import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { GrokAdapter } from '../adapters/grok/grok-adapter';
import { HermesAdapter } from '../adapters/hermes/hermes-adapter';
import { toRuntimeInfoCapabilities } from '../daemon/runtime-capabilities';
import type { RuntimeAdapter, RuntimeCapabilities } from '../types';

/**
 * #1103: the capability matrix is only true on the wire if the hello/presence
 * projection carries every field the adapter descriptor declares, and if an
 * undeclared field stays absent instead of becoming an invented `false`.
 * This is the projection half of the generated docs table; the docs half is
 * scripts/docs/capability-matrix.test.mjs.
 */

const MATRIX_FIELDS = [
  'steer',
  'resume',
  'approvalInteractive',
  'mcpToolsets',
  'messageDraft',
  'toolAuthorizationAuto',
  'durableLane',
  'preparedLane',
  'isolation',
] as const;
/** Wire v4 still names the durable lane `durablePi`. */
const WIRE_FIELD = { durableLane: 'durablePi' } as const;

const adapters = (): ReadonlyArray<readonly [string, RuntimeAdapter]> => [
  ['pi', new PiAdapter()],
  ['pi (durableLane)', new PiAdapter({ durableLane: true })],
  ['claude', new ClaudeAdapter()],
  ['codex', new CodexAdapter()],
  ['grok', new GrokAdapter()],
  ['hermes', new HermesAdapter({ home: path.resolve('/byok-runtime-capability-matrix') })],
];

describe('runtime capability matrix projection to conn.hello / presence', () => {
  it.each(adapters())('%s carries every declared field with its descriptor value', (_name, adapter) => {
    const capabilities = adapter.descriptor.capabilities;
    const wire = toRuntimeInfoCapabilities(capabilities);
    for (const field of MATRIX_FIELDS) {
      if (field === 'isolation') {
        expect(wire.isolation, field).toEqual(capabilities.isolation);
        if (capabilities.isolation === undefined) expect('isolation' in wire, field).toBe(false);
        continue;
      }
      const onWire = (WIRE_FIELD as Record<string, string>)[field] ?? field;
      expect((wire as Record<string, unknown>)[onWire], field).toBe(capabilities[field]);
      if (capabilities[field] === undefined) expect(onWire in wire, field).toBe(false);
    }
    // Native interactions are local runtime control, not a matrix capability:
    // they are never projected onto the wire.
    expect('nativeInteractions' in wire).toBe(false);
  });

  it('omits every field the adapter does not declare instead of inventing false', () => {
    const wire = toRuntimeInfoCapabilities({ steer: false, resume: true, approvalInteractive: false });
    expect(wire).toEqual({ steer: false, resume: true, approvalInteractive: false });
    for (const field of ['mcpToolsets', 'messageDraft', 'toolAuthorizationAuto', 'durablePi', 'preparedLane', 'isolation'] as const) {
      expect(field in wire, field).toBe(false);
    }
  });

  it('drops an unknown capability instead of passing it through as a claim', () => {
    const wire = toRuntimeInfoCapabilities({
      ...new PiAdapter().descriptor.capabilities,
      futureCapability: true,
    } as unknown as RuntimeCapabilities);
    expect('futureCapability' in wire).toBe(false);
  });

  it('every capability field a bundled descriptor declares has a matrix projection', () => {
    const known = new Set<string>([...MATRIX_FIELDS, 'nativeInteractions']);
    for (const [name, adapter] of adapters()) {
      expect(Object.keys(adapter.descriptor.capabilities).filter((field) => !known.has(field)), name).toEqual([]);
    }
  });
});
