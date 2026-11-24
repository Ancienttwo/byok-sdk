import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBridgeContract } from '../src/bridge/protocol.ts';

const dir = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(dir, '../src/bridge/bridge-contract.json');
const write = process.argv.includes('--write');

const expected = `${JSON.stringify(buildBridgeContract(), null, 2)}\n`;

if (write) {
  writeFileSync(outPath, expected, 'utf8');
  console.log(`wrote ${outPath}`);
} else {
  const actual = readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n');
  if (actual !== expected) {
    console.error(`bridge-contract.json is out of date with src/bridge/protocol.ts; run \`node examples/desktop-bot-app/scripts/generate-bridge-contract.mjs --write\``);
    process.exit(1);
  }
  console.log('bridge-contract.json OK');
}
