import { commitVectors } from '@byok-sdk/bot-collaboration/testing';
import { memorySubject } from './memory-subject.test-support';

// #793 D2a-0: the K8 package entries carry all that H needs to run the D1 commit vectors.
// D2a adds the Postgres subject next to this reference subject.
commitVectors('H reference: pure rules through the K8 package entries', memorySubject);
