import { describe, expect, it } from 'vitest';
import { admitCloudPayload, prepareCloudGuard } from '../src/input-guard';

describe('the production operation guard JSON boundary', () => {
  it('admits the same dense decoded JSON arrays as the async payload guard', async () => {
    const guard = await prepareCloudGuard({});
    try {
      for (const wire of ['[null,1,"ordinary"]', '{"rows":[[],[true,false],{"value":2}]}']) {
        const decoded: unknown = JSON.parse(wire);
        await expect(admitCloudPayload({}, decoded)).resolves.toBeUndefined();
        expect(JSON.parse(guard.guardPayload(wire))).toEqual(decoded);
      }
    } finally { guard.dispose(); }
  });

  it('rejects hole and accessor syntax because neither is JSON', async () => {
    const guard = await prepareCloudGuard({});
    try {
      for (const wire of ['[,1]', '[1,,2]', '[1,]', '[get value(){return 1}]']) {
        expect(() => guard.guardPayload(wire)).toThrow('CLOUD_REQUEST_INVALID');
      }
    } finally { guard.dispose(); }
  });

  it('rejects non-string sparse/accessor values without invoking or coercing them', async () => {
    let reads = 0;
    const sparse = new Array(1);
    const accessor = Object.defineProperty([], '0', { enumerable: true, get() { reads++; return 'ordinary'; } });
    const coercion = { toString() { reads++; return '[]'; } };
    const guard = await prepareCloudGuard({});
    try {
      for (const value of [sparse, accessor, coercion]) {
        expect(() => guard.guardPayload(value as unknown as string)).toThrow('CLOUD_REQUEST_INVALID');
      }
      await expect(admitCloudPayload({}, sparse)).rejects.toThrow('CLOUD_REQUEST_INVALID');
      await expect(admitCloudPayload({}, accessor)).rejects.toThrow('CLOUD_REQUEST_INVALID');
      expect(reads).toBe(0);
      // A caller that serializes a sparse JS array has already replaced its holes with JSON nulls.
      const wire = JSON.stringify(sparse);
      expect(wire).toBe('[null]');
      await expect(admitCloudPayload({}, JSON.parse(wire))).resolves.toBeUndefined();
      expect(guard.guardPayload(wire)).toBe('[null]');
    } finally { guard.dispose(); }
  });
});
