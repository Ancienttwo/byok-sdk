// Bun loads the revision's TypeScript; Node verification never reimplements
// the strict ledger parser or the existence-aware I4 state machine (#998).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJson } from './evidence.mjs';
const [repo, operation] = process.argv.slice(2);
if (repo === undefined) throw new Error('repository path required');
let text = '';
for await (const chunk of process.stdin) text += chunk;
const input = parseJson(text, 'strict checker input');
const load = (file) => import(pathToFileURL(path.join(repo, file)).href);
if (operation === 'check') {
  const { checkCut } = await load('packages/client/src/__tests__/agent-memory-powercut/checker.ts');
  process.stdout.write(JSON.stringify(checkCut(input.snapshot, input.journal)));
} else if (operation === 'serialize') {
  const { serializeAgentMemoryIntentLedger } = await load('packages/client/src/daemon/agent-memory-intent.ts');
  process.stdout.write(JSON.stringify(serializeAgentMemoryIntentLedger(input.records)));
} else throw new Error('bridge operation must be check or serialize');
