import os from 'node:os';
import { beforeEach, vi } from 'vitest';
import { setLoginShellSnapshotSource } from '../login-shell-environment';
import { setWindowsLogonRegistrySource } from '../runtime/environment';
import { TEST_LOGIN_SHELL_SNAPSHOT, testWindowsLogonRegistry } from './fixtures/runtime-env';

// Unit-suite composition root for #1095 and #1317: the snapshot and the win32
// logon registry are the live test environment, never the developer's or CI
// runner's own login shell or registry. The same holds for the host name:
// pairing without a configured deviceName sends os.hostname(), which wire v7
// bounds to 64 UTF-16 units (#2045), and some CI runners' names are longer.
// A test of the hostname default stubs its own value.

beforeEach(() => {
  setLoginShellSnapshotSource(async () => TEST_LOGIN_SHELL_SNAPSHOT);
  setWindowsLogonRegistrySource(async () => testWindowsLogonRegistry());
  vi.spyOn(os, 'hostname').mockReturnValue('test-host');
});
