import { createMutableClock } from '@byok-sdk/core';
import {
  runApprovalTimelineConformance,
  type ApprovalTimelineCompositionFactory,
} from '../../../conformance/src/cloud/approval-timeline';
import { InMemoryApprovalTimelineStore } from '../stores/in-memory/approval-timeline';

const factory: ApprovalTimelineCompositionFactory = {
  create() {
    const clock = createMutableClock();
    return {
      store: new InMemoryApprovalTimelineStore(clock),
      advanceTime: (ms) => clock.advance(ms),
    };
  },
};

runApprovalTimelineConformance('in-memory', factory);
