import { WIRE_ADDITIONS } from '@byok-sdk/protocol';

/**
 * Every device flag a `WIRE_ADDITIONS` row names. A TaskRunner test that is not
 * about the advertised-flag check (#925 O4) advertises all of them, so the
 * check admits every offer the test sends.
 */
export const EVERY_DEVICE_FLAG: readonly string[] = [...new Set(
  WIRE_ADDITIONS.flatMap((row) => (row.kind === 'envelope' && row.rule === 'gated' && row.advertisedBy === 'device' ? [row.capability] : [])),
)];

export const advertiseEveryDeviceFlag = (): readonly string[] => EVERY_DEVICE_FLAG;
