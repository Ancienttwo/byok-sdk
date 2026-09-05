// Probe transport only: JSON lines <-> native app-server WebSocket.
import { createInterface } from 'node:readline';
const ws = new WebSocket(process.argv[2]);
await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('websocket connect failed')); });
ws.onmessage = e => process.stdout.write(String(e.data) + '\n');
ws.onclose = () => process.exit(0);
for await (const line of createInterface({ input: process.stdin })) ws.send(line);
ws.close();
