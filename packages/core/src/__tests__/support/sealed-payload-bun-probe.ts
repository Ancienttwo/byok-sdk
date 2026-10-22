/**
 * Executed directly by Bun (`bun <this file>`) from `sealed-payload-bun.test.ts`,
 * so the sealed-payload v1 vectors also run under Bun's WebCrypto. The device
 * daemon is a Bun-compiled binary and opens these contents. Prints one JSON
 * line; any failure exits non-zero.
 */
import golden from '../golden/sealed-payload-v1.json';
import { checkSealedPayloadVectors, type SealedPayloadVectors } from './sealed-payload-vectors';

const bunVersion = (globalThis as { Bun?: { version: string } }).Bun?.version;
const counts = await checkSealedPayloadVectors(golden as unknown as SealedPayloadVectors);
process.stdout.write(`${JSON.stringify({ ok: true, runtime: bunVersion === undefined ? 'not-bun' : `bun ${bunVersion}`, counts })}\n`);
