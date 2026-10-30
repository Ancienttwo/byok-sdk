import { beforeEach } from 'vitest';
import { setLoginShellSnapshotSource } from '../login-shell-environment';
import { TEST_LOGIN_SHELL_SNAPSHOT } from './fixtures/runtime-env';

// Unit-suite composition root for #1095: the snapshot is the live test
// environment, never the developer's or CI runner's own login shell.
beforeEach(() => setLoginShellSnapshotSource(async () => TEST_LOGIN_SHELL_SNAPSHOT));
