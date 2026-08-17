import { InMemoryDeviceAssertionReplayAuthority } from '@byok-sdk/core';
import { runDeviceAssertionReplayConformance } from '../device-assertion-replay';

runDeviceAssertionReplayConformance('in-memory', {
  create: () => ({ replay: new InMemoryDeviceAssertionReplayAuthority() }),
});
