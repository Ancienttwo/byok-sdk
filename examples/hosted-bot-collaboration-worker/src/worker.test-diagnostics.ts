/** Counts diagnostic lines, not unique outages: a disconnect may have more than one logged stack frame. */
export function proxyDiagnostics(output: string) {
  const lines = output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  return {
    recoveries: lines.filter(line => /ProxyWorker: .* recovered on attempt \d+ after a dropped connection/.test(line)),
    disconnects: lines.filter(line => /Network connection lost|stream disconnected prematurely/.test(line)),
  };
}
