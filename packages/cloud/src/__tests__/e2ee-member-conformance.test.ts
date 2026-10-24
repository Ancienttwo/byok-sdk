import { runE2eeMemberStoreConformance } from '../../../conformance/src/cloud/e2ee-member';
import { createMutableClock } from '@byok-sdk/core';
import { InMemoryE2eeMemberStore } from '../stores/in-memory/e2ee-member';
import { InMemoryRequestReceiptStore } from '../stores/in-memory/receipts';
runE2eeMemberStoreConformance('in-memory', {
  create: () => {
    const receipts = new InMemoryRequestReceiptStore(createMutableClock());
    return { store: new InMemoryE2eeMemberStore(receipts), receipts };
  },
});
