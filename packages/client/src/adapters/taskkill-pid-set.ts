/**
 * Windows-only: recovers the process-tree PID set that `taskkill /T /F`
 * reports it walked, so `process-tree.ts` can MEASURE quiescence instead of
 * trusting taskkill's exit status.
 *
 * Two constraints shape this parser:
 *
 * - taskkill's messages are LOCALIZED (the same run prints
 *   `SUCCESS: The process with PID ...` on en-US and a translated sentence on
 *   de-DE/zh-CN/ja-JP), so no word, prefix, or field label may be matched.
 *   Only the integers and their CO-OCCURRENCE on one line are stable: every
 *   line taskkill emits for a walked process names that process and its
 *   parent together. Seeding with the root pid and closing over co-occurrence
 *   therefore reaches exactly the walked tree, in any locale.
 * - the text arrives in the console OEM codepage, not UTF-8. It is decoded as
 *   latin1 (byte-preserving) rather than guessed: every OEM codepage taskkill
 *   can use encodes ASCII digits as single bytes 0x30-0x39, and no DBCS trail
 *   byte (CP932/CP936/CP949/CP950 all start their trail range at 0x40) can
 *   land in that range. Undecodable non-ASCII bytes become mojibake, which is
 *   irrelevant: they can never manufacture a digit.
 *
 * Line ORDER is deliberately not relied on (taskkill emits children before
 * parents today); the walk iterates to a fixpoint instead.
 */

const INTEGER_PATTERN = /\d+/g;

function isCandidatePid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Returns the PID set reachable from `rootPid` by co-occurrence over `text`.
 *
 * `excludedPids` removes integers that must never enter the set even when
 * they share a line with an accepted pid — taskkill names the ROOT's own
 * parent (this daemon process) on the root's line, and accepting it would
 * make quiescence unreachable by construction. `rootPid` is always seeded and
 * is never subject to exclusion.
 */
export function walkTaskkillPidSet(text: string, rootPid: number, excludedPids: Iterable<number> = []): Set<number> {
  const excluded = new Set(excludedPids);
  const accepted = new Set<number>();
  if (isCandidatePid(rootPid)) accepted.add(rootPid);

  const lines = text.split(/\r?\n/).map((line) => {
    const pids: number[] = [];
    for (const match of line.matchAll(INTEGER_PATTERN)) {
      const pid = Number(match[0]);
      if (isCandidatePid(pid) && !excluded.has(pid)) pids.push(pid);
    }
    return pids;
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (const pids of lines) {
      if (!pids.some((pid) => accepted.has(pid))) continue;
      for (const pid of pids) {
        if (accepted.has(pid)) continue;
        accepted.add(pid);
        changed = true;
      }
    }
  }
  return accepted;
}
