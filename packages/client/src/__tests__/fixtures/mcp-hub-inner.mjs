import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';

const [configPath, receiptPath, contextPath] = process.argv.slice(2);
const config = () => JSON.parse(readFileSync(configPath, 'utf8'));
const record = (event) => appendFileSync(receiptPath, `${JSON.stringify({ ...event, pid: process.pid })}\n`);
record({ method: 'start', cwd: process.cwd(), env: process.env });
const input = createInterface({ input: process.stdin });
input.on('line', async (line) => {
  const { id, method, params } = JSON.parse(line);
  record({ method, params });
  const send = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  switch (method) {
    case 'initialize':
      send({ protocolVersion: '2025-11-25', serverInfo: { name: 'inner-fixture', version: '1' }, capabilities: { tools: {} } });
      break;
    case 'tools/list': {
      const options = config();
      if (options.waitForList) {
        record({ method: 'list-wait' });
        while (!existsSync(options.waitForList)) await setTimeout(10);
      }
      if (options.listDelayMs) await setTimeout(options.listDelayMs);
      if (options.badList) {
        send({ tools: options.badList });
        break;
      }
      const page = Number(params?.cursor ?? 0);
      const nextCursor = options.pages[page + 1] === undefined ? undefined : String(page + 1);
      send({ tools: options.pages[page], nextCursor });
      break;
    }
    case 'tools/call': {
      const { behavior } = config();
      if (behavior === 'hang') break;
      if (behavior === 'echo-launch-secrets') {
        const { contextToken } = JSON.parse(readFileSync(contextPath, 'utf8'));
        process.stderr.write(contextToken + '\n');
        send({ content: [{ type: 'text', text: process.env.HUB_CONNECTOR_TOKEN }], structuredContent: { [contextToken]: true } });
        break;
      }
      if (behavior === 'invalid-result') {
        send({ content: [], structuredContent: { text: 7 } });
        break;
      }
      if (behavior === 'disconnect') process.exit(0);
      if (behavior === 'inner-oversize' || behavior === 'outer-oversize') {
        const result = { content: [{ type: 'text', text: '' }], structuredContent: { text: 'bounded' } };
        const overhead = Buffer.byteLength(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
        result.content[0].text = 'x'.repeat(1_048_576 - overhead + (behavior === 'inner-oversize' ? 1_000 : 0));
        send(result);
        break;
      }
      send({ content: [{ type: 'text', text: JSON.stringify(params.arguments) }], structuredContent: params.arguments });
      break;
    }
  }
});
