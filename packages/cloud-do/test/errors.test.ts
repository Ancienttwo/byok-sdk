import { describe, expect, it } from 'vitest';
import { CloudDoError, safeCloudError, type CloudDoErrorCode } from '../src/errors';

describe('fixed cloud error normalization', () => {
  it('rejects an unregistered code even when the error has the cloud subclass', () => {
    const malformed = new CloudDoError('ghp_unregistered_error_code' as CloudDoErrorCode);
    expect(safeCloudError(malformed).code).toBe('CLOUD_MODEL_REQUEST_FAILED');
  });

  it('does not invoke an upstream message getter', () => {
    let reads = 0;
    const error = Object.defineProperty(new Error(), 'message', { get() { reads++; throw new Error('raw-private-error'); } });
    expect(safeCloudError(error).code).toBe('CLOUD_MODEL_REQUEST_FAILED');
    expect(reads).toBe(0);
  });

  it('keeps a valid fixed code without retaining the original cause or object', () => {
    const original = new CloudDoError('CLOUD_TOOL_FAILED');
    const normalized = safeCloudError(original);
    expect(normalized).not.toBe(original);
    expect(normalized.code).toBe('CLOUD_TOOL_FAILED');
    expect(normalized.cause).toBeUndefined();
  });
});
