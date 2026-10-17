import { createMutableClock } from '@byok-sdk/core';
import { runAgentMessageDraftConformance } from '../../../conformance/src/cloud/agent-message-draft';
import { InMemoryAgentMessageDraftStore } from '../stores/in-memory/agent-message-draft';
runAgentMessageDraftConformance('in-memory', {
  create() {
    const clock = createMutableClock();
    return { store: new InMemoryAgentMessageDraftStore(clock), clock, advanceTime: ms => clock.advance(ms) };
  },
});
