import { createMutableClock } from '@byok-sdk/core';
import {
  runActivityConformance,
  type ActivityCompositionFactory,
} from '../../../conformance/src/cloud/activity';
import { InMemoryActivityStore } from '../stores/in-memory/activity';

const factory: ActivityCompositionFactory = {
  create() {
    const clock = createMutableClock();
    return {
      store: new InMemoryActivityStore(clock),
      advanceTime: (ms) => clock.advance(ms),
    };
  },
};

runActivityConformance('in-memory', factory);
