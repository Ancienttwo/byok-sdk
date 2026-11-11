/** An in-memory Claude stdio: written frames are captured, stdout lines and the exit are driven by the test. `refuse` makes a write of that request subtype throw. */
export function memoryClaude(refuse?: string) {
  const lines: Array<(line: string) => void> = [];
  const exits: Array<(code: number | null) => void> = [];
  const written: Array<{ request_id: string; request: { subtype: string } }> = [];
  let resolveExit!: (code: number | null) => void;
  const child = {
    spawned: Promise.resolve(), exited: new Promise<number | null>(resolve => { resolveExit = resolve; }),
    onLine: (handler: (line: string) => void) => { lines.push(handler); },
    onExit: (handler: (code: number | null) => void) => { exits.push(handler); },
    write: (text: string) => {
      const frame = JSON.parse(text);
      if (refuse !== undefined && frame.request?.subtype === refuse) throw new Error(`stdin refused ${refuse}`);
      written.push(frame);
    },
    writeAcknowledged: async (text: string) => { written.push(JSON.parse(text)); },
    kill: () => {}, dispose: async () => {}, observeDescendants: () => {}, exitedOnItsOwn: true, exitError: () => new Error('exited'),
  };
  return {
    child, written,
    send: (frame: object) => { for (const handler of lines) handler(JSON.stringify(frame)); },
    exit: (code: number | null) => { for (const handler of exits) handler(code); resolveExit(code); },
  };
}
