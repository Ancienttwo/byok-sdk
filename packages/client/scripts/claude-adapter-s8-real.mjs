if (process.env.BYOK_REAL_CLAUDE !== '1') { console.log(JSON.stringify({ status: 'skipped', turns: 0, reason: 'BYOK_REAL_CLAUDE=1 required' })); process.exit(0); }
const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { spawn } = await import('node:child_process');
const { ClaudeAdapter } = await import('../src/adapters/claude/claude-adapter.ts');
const { buildRuntimeEnv } = await import('../src/daemon/environment.ts');
const { logger, deferred, bounded, startAdapter, collect, tapChild } = await import('./real-s8-utils.mjs');
const emit = logger(process.env.BYOK_REAL_LOG ?? '/tmp/byok-s8-claude.jsonl');
const report = { turns: 0, cases: [], baseline: '4b9485e6' };
const env = buildRuntimeEnv({ ambient: process.env, requirements: { credentialNames: [] } });
const workspace = await mkdtemp(join(tmpdir(), 'byok-s8-claude-'));
let child, tool, frames, interruptRequest, ack, currentCase;
const adapter = new ClaudeAdapter({ spawnFn: (command, args, options) => {
  child = spawn(command, currentCase === 'streaming-interrupt' ? [...args, '--include-partial-messages'] : args, options);
  tapChild(child, frame => {
    if (currentCase === 'streaming-interrupt' && frame.type === 'stream_event' && frame.event?.type === 'content_block_delta' && frame.event.delta?.type === 'text_delta') {
      emit({ kind: 'native.text_delta', delta: frame.event.delta }); tool?.resolve(frame.event.delta);
    }
    if (frame.type === 'assistant') {
      for (const content of frame.message?.content ?? []) if (content.type === 'tool_use') {
        emit({ kind: 'native.tool_use', content }); tool?.resolve(content);
      }
    }
    if (['result', 'control_response'].includes(frame.type)) {
      const data = frame.type === 'result'
        ? { type: frame.type, subtype: frame.subtype, terminal_reason: frame.terminal_reason, is_error: frame.is_error, modelUsage: frame.modelUsage, usage: frame.usage, result: frame.result, errors: frame.errors }
        : { type: frame.type, response: frame.response };
      frames.push(data); emit({ kind: 'native', data });
      if (frame.type === 'control_response' && frame.response?.request_id === interruptRequest?.request_id) ack = { response: frame.response, latencyMs: Date.now() - interruptRequest.time };
    }
  }, frame => {
    if (frame.type === 'control_request' && frame.request?.subtype === 'interrupt') {
      interruptRequest = { ...frame, time: Date.now() }; emit({ kind: 'interrupt.write', frame });
    }
  });
  return child;
} });
try {
  report.detection = await adapter.detect(); emit({ kind: 'detection', result: report.detection });
  if (report.detection.kind !== 'available' || !report.detection.authPresent) throw new Error('Claude login/detection unavailable');
  const cases = [
    ['interrupt', 'Run Bash command sleep 8, then reply S8_CANCEL_FINISHED; do nothing else.'],
    ['context', 'Reply exactly S8_CLAUDE_OK without using tools.'],
    ['streaming-interrupt', 'Reply with eight short numbered sentences about clouds, without tools.'],
  ];
  for (const [name, prompt] of cases.filter(([name]) => !process.env.BYOK_REAL_CLAUDE_S8_CASE || name === process.env.BYOK_REAL_CLAUDE_S8_CASE)) {
    if (report.turns >= 3) throw new Error('Claude turn budget exceeded');
    currentCase = name; frames = []; tool = deferred(); interruptRequest = undefined; ack = undefined; child = undefined;
    report.turns++; emit({ kind: 'turn.submit', name, ordinal: report.turns, prompt });
    let session;
    try {
      session = await bounded(startAdapter(adapter, prompt, workspace, env, `real-s8-claude-${name}`), 'Claude session start');
      const events = collect(session, emit);
      let cancellation;
      if (name === 'interrupt' || name === 'streaming-interrupt') {
        const signal = await bounded(Promise.race([tool.promise.then(content => ({ content })), events.then(result => ({ result }))]), 'Claude mid-turn signal');
        if (signal.content) {
          const start = Date.now(); emit({ kind: 'interrupt.submit', pid: child.pid });
          await bounded(session.interrupt(), 'ClaudeAdapter interrupt', 15000);
          cancellation = { durationMs: Date.now() - start, ack, processAliveAfterInterrupt: child.exitCode === null && child.signalCode === null, pid: child.pid };
          emit({ kind: 'interrupt.return', cancellation });
        } else cancellation = { notSent: 'turn completed before a tool-use signal' };
      }
      const result = await bounded(events, 'Claude result', 30000);
      const usage = result.events.find(event => event.type === 'usage');
      const aborted = frames.find(frame => frame.type === 'result' && frame.terminal_reason === 'aborted_streaming');
      report.cases.push({ name, cancellation, ...result, nativeResults: frames.filter(frame => frame.type === 'result'),
        abortedStreaming: !!aborted, abortedHandledWithoutError: !!aborted && !result.error && !result.events.some(event => event.type === 'error') && result.events.some(event => event.type === 'turn_end'),
        contextVerified: usage?.contextSource === 'provider' && usage.contextWindow > 0 });
      emit({ kind: 'case', result: report.cases.at(-1) });
    } catch (error) { report.cases.push({ name, error: String(error), ack, nativeResults: frames }); emit({ kind: 'case', result: report.cases.at(-1) }); }
    finally { await session?.close(); }
  }
} catch (error) { report.error = String(error); }
finally { await rm(workspace, { recursive: true, force: true }); }
emit({ kind: 'summary', report }); console.log(JSON.stringify(report, null, 2));
process.exitCode = report.cases.length === (process.env.BYOK_REAL_CLAUDE_S8_CASE ? 1 : 3) ? 0 : 1;
