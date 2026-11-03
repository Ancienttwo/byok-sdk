import { beforeEach } from 'vitest';
import { setLoginShellSnapshotSource } from '../login-shell-environment';
import { setWindowsLogonRegistrySource } from '../runtime/environment';
import { TEST_LOGIN_SHELL_SNAPSHOT, testWindowsLogonRegistry } from './fixtures/runtime-env';

// Unit-suite composition root for #1095 and #1317: the snapshot and the win32
// logon registry are the live test environment, never the developer's or CI
// runner's own login shell or registry.
beforeEach(() => {
  setLoginShellSnapshotSource(async () => TEST_LOGIN_SHELL_SNAPSHOT);
  setWindowsLogonRegistrySource(async () => testWindowsLogonRegistry());
});
