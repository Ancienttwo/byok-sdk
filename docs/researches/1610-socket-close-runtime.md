# Unix listener close probe for #1610

Issue: <https://github.com/Ancienttwo/byok-sdk/issues/1610>
Design discussion: <https://github.com/Ancienttwo/byok-sdk/issues/1610#issuecomment-6736651206>

The probe ran on macOS under Node v24.18.0, Bun 1.4.2, Bun 1.4.3, and executables compiled by both Bun versions. It holds an accepted connection open, closes the listening server, binds a successor at the same pathname before the old close callback completes, then releases the old connection.

All five executions reported:

```json
{"beforeClose":true,"afterCloseCall":false,"successorBoundBeforeOldCallback":true,"afterOldCloseCallback":true}
```

The Unix pathname disappeared synchronously before `server.close()` returned. Completing the old close callback left the successor pathname intact. These observations cover both the Node daemon runtime and Bun's compiled executable runtime on macOS.

The pinned Bun implementation also establishes the internal ordering. [`Listener::do_stop`](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/runtime/socket/Listener.rs#L859-L889) calls `unlink_unix_socket_path` before closing the listening socket. The [helper](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/runtime/socket/Listener.rs#L939-L950) explicitly documents matching Node/libuv's unlink-before-fd-close ordering to avoid this replacement race. The Unix implementation applies to macOS and Linux; Windows named pipes have no filesystem pathname to unlink.

Reproduce by saving the following as `close-probe.cjs`, then running `node close-probe.cjs`, `bun close-probe.cjs`, and `bun build --compile close-probe.cjs --outfile close-probe && ./close-probe`:

```javascript
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-close-probe-'));
const endpoint = path.join(dir, 's.sock');
const server = net.createServer((accepted) => {
  const result = {
    runtime: process.versions.bun ? 'Bun ' + process.versions.bun : process.version,
    beforeClose: fs.existsSync(endpoint),
  };
  server.close(() => {
    result.afterOldCloseCallback = fs.existsSync(endpoint);
    console.log(JSON.stringify(result));
    successor.close(() => fs.rmdirSync(dir));
  });
  result.afterCloseCall = fs.existsSync(endpoint);
  const successor = net.createServer();
  successor.listen(endpoint, () => {
    result.successorBoundBeforeOldCallback = fs.existsSync(endpoint);
    accepted.destroy();
    client.destroy();
  });
});
let client;
server.listen(endpoint, () => { client = net.createConnection(endpoint); });
```
