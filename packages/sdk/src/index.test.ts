import { describe, expect, it } from 'vitest';
import * as sdk from './index';

describe('byok-sdk umbrella', () => {
  it('exports every dispatch package as a namespace and excludes keys', () => {
    expect(Object.keys(sdk).sort()).toEqual([
      'client',
      'cloud',
      'cloudDataplane',
      'core',
      'protocol',
      'server',
    ]);
    expect('keys' in sdk).toBe(false);
  });
});
