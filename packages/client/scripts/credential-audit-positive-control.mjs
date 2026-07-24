#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalCanaryPaths } from './credential-audit-core.mjs';

const homeIndex = process.argv.indexOf('--home');
const home = homeIndex === -1 ? process.env.HOME : process.argv[homeIndex + 1];
if (!home) {
  process.stderr.write('positive control requires --home\n');
  process.exit(2);
}

const paths = canonicalCanaryPaths(path.resolve(home));
const contents = Object.fromEntries(
  Object.entries(paths).map(([runtime, file]) => [runtime, readFileSync(file, 'utf8')]),
);
process.stdout.write(`${JSON.stringify({ opened: Object.keys(contents).sort() })}\n`);
