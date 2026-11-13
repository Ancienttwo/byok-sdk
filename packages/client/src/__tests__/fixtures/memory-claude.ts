/** An in-memory Claude stdio: written frames are captured, stdout lines and the exit are driven by the test. A write of the `refuse` request subtype throws, or its acknowledgement rejects later or never settles. */
export function memoryClaude(refuse?: string, how: 'throw' | 'reject' | 'hang' = 'throw') {
  const lines: Array<(line: string) => void> = [];
  const exits: Array<(code: number | null) => void> = [];
  const written: Array<{ request_id: string; request: { subtype: string } }> = [];
  let resolveExit!: (code: number | null) => void;
  let kills = 0;
  const refused = (text: string) => refuse !== undefined && JSON.parse(text).request?.subtype === refuse;
  const take = (text: string) => {
    if (refused(text)) throw new Error(`stdin refused ${refuse}`);
    written.push(JSON.parse(text));
  };
  const child = {
    spawned: Promise.resolve(), exited: new Promise<number | null>(resolve => { resolveExit = resolve; }),
    onLine: (handler: (line: string) => void) => { lines.push(handler); },
    onExit: (handler: (code: number | null) => void) => { exits.push(handler); },
    write: take,
    writeAcknowledged: (text: string): Promise<void> => {
      if (refused(text) && how === 'reject') return Promise.reject(new Error(`stdin refused ${refuse}`));
      if (refused(text) && how === 'hang') return new Promise(() => {});
      take(text); return Promise.resolve();
    },
    kill: () => { kills += 1; }, dispose: async () => {}, observeDescendants: () => {}, exitedOnItsOwn: true, exitError: () => new Error('exited'),
  };
  return {
    child, written, kills: () => kills,
    send: (frame: object) => { for (const handler of lines) handler(JSON.stringify(frame)); },
    exit: (code: number | null) => { for (const handler of exits) handler(code); resolveExit(code); },
  };
}
