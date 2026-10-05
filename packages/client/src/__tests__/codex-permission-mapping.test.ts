import { describe, expect, it } from 'vitest';
import { mapPermissionPolicyToCodexArgs } from '../adapters/codex/permission-mapping';
describe('Codex YOLO-only effective-policy admission', () => {
  it.each(['readonly', 'confirm', 'plan'] as const)(
    'refuses %s before generating args',
    (mode) => {
      expect(mapPermissionPolicyToCodexArgs({ mode })).toMatchObject({
        ok: false,
        args: [],
      });
    },
  );
  it('refuses network:false', () => {
    expect(
      mapPermissionPolicyToCodexArgs({ mode: 'auto', network: false }),
    ).toMatchObject({ ok: false, args: [] });
  });
  it.each([undefined, true])('allows auto with network=%s', (network) => {
    expect(
      mapPermissionPolicyToCodexArgs({
        mode: 'auto',
        ...(network === undefined ? {} : { network }),
      }),
    ).toEqual({ ok: true, args: [] });
  });
  it.each([
    { allowTools: ['Bash'] },
    { denyTools: ['Read'] },
    { allowTools: ['Bash'], denyTools: ['Read'] },
  ])('refuses unfulfillable tool restrictions %j', (restriction) => {
    expect(
      mapPermissionPolicyToCodexArgs({ mode: 'auto', ...restriction }),
    ).toMatchObject({ ok: false, args: [] });
  });
  it('empty restrictions do not silently manufacture exec flags', () => {
    expect(
      mapPermissionPolicyToCodexArgs({
        mode: 'auto',
        allowTools: [],
        denyTools: [],
      }),
    ).toEqual({ ok: true, args: [] });
  });
});
