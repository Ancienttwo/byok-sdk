#!/usr/bin/env node
// Echoes every raw stdin frame back as a correlated `response`, base64-encoded
// so the exact bytes cross back unaltered.
//
// It exists for one assertion: the bytes `PiRpcClient` writes for a
// `prompt_prepared` command are the bytes the shared builder
// (`adapters/pi/prepared-prompt-frame.ts`) produced — the same bytes the
// preparation service measured against the runtime's frame cap. A test that
// re-serialized the command itself would be comparing its own guess about the
// transport, not the transport.
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\n');
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    let id;
    try {
      id = JSON.parse(line).id;
    } catch {
      id = undefined;
    }
    process.stdout.write(
      `${JSON.stringify({
        type: 'response',
        success: true,
        id,
        // The frame INCLUDING its LF terminator, exactly as it was received.
        data: { frameBase64: Buffer.from(`${line}\n`, 'utf8').toString('base64') },
      })}\n`,
    );
  }
});
