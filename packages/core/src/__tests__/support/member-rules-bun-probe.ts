/**
 * Executed directly by Bun (`bun <this file>`) from `member-rules-bun.test.ts`,
 * so the member rule vectors also run under Bun's WebCrypto. The device daemon
 * is a Bun-compiled binary and computes these fingerprints, MACs and chain
 * checks. Prints one JSON line; any failure exits non-zero.
 */
import golden from '../golden/member-rules-v1.json';
import { checkMemberRulesVectors, type MemberRulesVectors } from './member-rules-vectors';

const bunVersion = (globalThis as { Bun?: { version: string } }).Bun?.version;
const counts = await checkMemberRulesVectors(golden as unknown as MemberRulesVectors);
process.stdout.write(`${JSON.stringify({ ok: true, runtime: bunVersion === undefined ? 'not-bun' : `bun ${bunVersion}`, counts })}\n`);
