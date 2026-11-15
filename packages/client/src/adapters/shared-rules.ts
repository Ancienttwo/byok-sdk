export const BASE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.py': 'text/x-python',
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
  '.csv': 'text/csv',
};

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return record(value) ? value : undefined;
}
