import { runE2eeMemberStoreConformance } from '../../../conformance/src/cloud/e2ee-member';
import { InMemoryE2eeMemberStore } from '../stores/in-memory/e2ee-member';
runE2eeMemberStoreConformance('in-memory', { create: () => ({ store: new InMemoryE2eeMemberStore() }) });
