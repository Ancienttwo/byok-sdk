import { describe, expect, it } from 'vitest';
import { walkTaskkillPidSet } from '../adapters/taskkill-pid-set';

// One synthetic tree, reused by every locale fixture below:
//   DAEMON_PID (this process) -> ROOT_PID -> DESCENDANT_PID -> GRANDCHILD_PID
const DAEMON_PID = 2604;
const ROOT_PID = 3712;
const DESCENDANT_PID = 4756;
const GRANDCHILD_PID = 9001;

/**
 * The rejected alternative the extractor must beat: taking every integer in
 * the output. Kept here (not in product code) so the hostile fixtures below
 * assert a real discrimination instead of merely passing.
 */
function naiveEveryInteger(text: string): Set<number> {
  return new Set([...text.matchAll(/\d+/g)].map((match) => Number(match[0])));
}

/**
 * taskkill writes the console OEM codepage, and `process-tree.ts` decodes
 * those bytes as latin1. Authoring the localized fixtures in UTF-8 and
 * decoding them the same way reproduces the only property that matters: every
 * non-ASCII byte (UTF-8 lead 0xC2-0xF4 / continuation 0x80-0xBF, DBCS lead
 * 0x81-0xFE / trail 0x40-0xFE) stays clear of the ASCII digit range
 * 0x30-0x39, so mojibake can never manufacture a pid.
 */
function asOemStream(text: string): string {
  return Buffer.from(text, 'utf8').toString('latin1');
}

const EN_US = [
  `SUCCESS: The process with PID ${GRANDCHILD_PID} (child process of PID ${DESCENDANT_PID}) has been terminated.`,
  `SUCCESS: The process with PID ${DESCENDANT_PID} (child process of PID ${ROOT_PID}) has been terminated.`,
  `SUCCESS: The process with PID ${ROOT_PID} (child process of PID ${DAEMON_PID}) has been terminated.`,
  '',
].join('\r\n');

const DE_DE = asOemStream([
  `ERFOLGREICH: Der Prozess mit PID ${GRANDCHILD_PID} (untergeordneter Prozess von PID ${DESCENDANT_PID}) wurde beendet.`,
  `ERFOLGREICH: Der Prozess mit PID ${DESCENDANT_PID} (untergeordneter Prozess von PID ${ROOT_PID}) wurde beendet.`,
  `ERFOLGREICH: Der Prozess mit PID ${ROOT_PID} (untergeordneter Prozess von PID ${DAEMON_PID}) wurde beendet.`,
  '',
].join('\r\n'));

const ZH_CN = asOemStream([
  `成功: 已终止 PID 为 ${GRANDCHILD_PID} 的进程(属于 PID ${DESCENDANT_PID} 子进程)。`,
  `成功: 已终止 PID 为 ${DESCENDANT_PID} 的进程(属于 PID ${ROOT_PID} 子进程)。`,
  `成功: 已终止 PID 为 ${ROOT_PID} 的进程(属于 PID ${DAEMON_PID} 子进程)。`,
  '',
].join('\r\n'));

const JA_JP = asOemStream([
  `成功: PID ${GRANDCHILD_PID} (PID ${DESCENDANT_PID} の子プロセス) のプロセスは強制終了されました。`,
  `成功: PID ${DESCENDANT_PID} (PID ${ROOT_PID} の子プロセス) のプロセスは強制終了されました。`,
  `成功: PID ${ROOT_PID} (PID ${DAEMON_PID} の子プロセス) のプロセスは強制終了されました。`,
  '',
].join('\r\n'));

describe('walkTaskkillPidSet', () => {
  it.each([
    { locale: 'en-US', output: EN_US },
    { locale: 'de-DE', output: DE_DE },
    { locale: 'zh-CN', output: ZH_CN },
    { locale: 'ja-JP', output: JA_JP },
  ])('walks the whole tree from $locale taskkill output without reading any localized word', ({ output }) => {
    const accepted = walkTaskkillPidSet(output, ROOT_PID, [DAEMON_PID]);
    expect([...accepted].sort((a, b) => a - b)).toEqual([ROOT_PID, DESCENDANT_PID, GRANDCHILD_PID].sort((a, b) => a - b));
  });

  it('does not accept an integer that never shares a line with an accepted pid', () => {
    const output = [
      `SUCCESS: The process with PID ${DESCENDANT_PID} (child process of PID ${ROOT_PID}) has been terminated.`,
      'ERROR: The process "8888" not found.',
      'INFO: 7777 handles were inspected.',
      '',
    ].join('\r\n');

    const accepted = walkTaskkillPidSet(output, ROOT_PID, [DAEMON_PID]);

    expect(accepted.has(8888)).toBe(false);
    expect(accepted.has(7777)).toBe(false);
    expect([...accepted].sort((a, b) => a - b)).toEqual([ROOT_PID, DESCENDANT_PID]);
    // The discrimination is real, not incidental: grabbing every integer accepts both strays.
    expect(naiveEveryInteger(output).has(8888)).toBe(true);
    expect(naiveEveryInteger(output).has(7777)).toBe(true);
  });

  it('never accepts the excluded parent that taskkill names on the root line', () => {
    const accepted = walkTaskkillPidSet(EN_US, ROOT_PID, [DAEMON_PID]);
    expect(accepted.has(DAEMON_PID)).toBe(false);
    // Without the exclusion the daemon's own pid enters the set and quiescence
    // becomes unreachable by construction — this is why it is passed in.
    expect(walkTaskkillPidSet(EN_US, ROOT_PID).has(DAEMON_PID)).toBe(true);
  });

  it('reaches the fixpoint regardless of line order', () => {
    const reversed = EN_US.split('\r\n').reverse().join('\r\n');
    expect([...walkTaskkillPidSet(reversed, ROOT_PID, [DAEMON_PID])].sort((a, b) => a - b))
      .toEqual([ROOT_PID, DESCENDANT_PID, GRANDCHILD_PID].sort((a, b) => a - b));
  });

  it('seeds the root pid even when taskkill reported nothing about it', () => {
    expect([...walkTaskkillPidSet('ERROR: The process "3712" not found.\r\n', ROOT_PID, [DAEMON_PID])]).toEqual([ROOT_PID]);
    expect([...walkTaskkillPidSet('', ROOT_PID, [DAEMON_PID])]).toEqual([ROOT_PID]);
  });

  it('cannot manufacture a pid out of double-byte OEM bytes', () => {
    // Every DBCS codepage taskkill can use starts its trail-byte range at 0x40,
    // so no double-byte sequence contains 0x30-0x39. Latin1-decoding arbitrary
    // lead/trail bytes therefore yields no digits at all.
    const dbcs = Buffer.from([0x81, 0x40, 0xfe, 0xfe, 0x90, 0xac, 0x8c, 0xf7]).toString('latin1');
    expect([...walkTaskkillPidSet(`${dbcs}\r\n`, ROOT_PID, [DAEMON_PID])]).toEqual([ROOT_PID]);
  });

  it('ignores integers that are not usable pids', () => {
    const output = `SUCCESS: 0 / 99999999999999999999 / ${DESCENDANT_PID} share a line with PID ${ROOT_PID}.\r\n`;
    const accepted = walkTaskkillPidSet(output, ROOT_PID, [DAEMON_PID]);
    expect([...accepted].sort((a, b) => a - b)).toEqual([ROOT_PID, DESCENDANT_PID]);
  });
});
