// DIAG #1317 -- do not merge. E1g: keeps every CPU busy until killed.
import os from 'node:os';
import { Worker } from 'node:worker_threads';

for (let i = 0; i < os.availableParallelism(); i += 1) new Worker('for (;;) {}', { eval: true });
console.log(`[e1g] stress on ${os.availableParallelism()} CPUs`);
