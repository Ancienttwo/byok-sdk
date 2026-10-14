// DOM-level check of public/index.html (#418): the runtime <select> is built
// from the runtimes that connected machines report in `/api/machines`, not from
// fixed markup. The page's inline script runs here against a linkedom document
// with a scripted `fetch`, so the options a browser would render are asserted
// directly.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

const pagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'index.html');

// The example's tsconfig has no DOM lib, so the few element members used are typed here.
interface Opt { value: string; textContent: string | null; selected: boolean }
interface SelectEl { disabled: boolean; options: Iterable<Opt> }
interface ButtonEl { disabled: boolean }
interface InputEl { value: string }
interface FormEl { dispatchEvent(event: unknown): boolean }

interface Machine {
  deviceId: string;
  deviceName: string;
  connected: boolean;
  runtimes?: Array<{ id: string; version?: string; authPresent?: boolean }>;
}

async function loadPage(initial: Machine[]) {
  const html = await readFile(pagePath, 'utf8');
  const { document, window } = parseHTML(html);
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  if (script === undefined) throw new Error('index.html has no inline script');
  let machines = initial;
  const requests: Array<{ url: string; body?: string }> = [];
  let tick: (() => Promise<void>) | undefined;
  const fakeFetch = vi.fn(async (url: string, init?: { body?: string }) => {
    requests.push({ url, ...(init?.body === undefined ? {} : { body: init.body }) });
    if (url === '/api/machines') return { ok: true, json: async () => machines };
    if (url === '/api/tasks') return { ok: true, json: async () => ({ taskId: 'task-1' }) };
    return { ok: true, json: async () => ({}) };
  });
  const run = new Function('document', 'fetch', 'setInterval', 'EventSource', 'prompt', script);
  run(
    document,
    fakeFetch,
    (fn: () => Promise<void>) => { tick = fn; return 0; },
    class { close() {} },
    () => undefined,
  );
  const select = document.getElementById('runtime') as unknown as SelectEl;
  const dispatch = document.getElementById('dispatch-btn') as unknown as ButtonEl;
  /** Pick an option the way a user does; linkedom's `select.value` is read-only. */
  const choose = (value: string) => {
    for (const option of [...select.options]) option.selected = option.value === value;
  };
  return {
    choose,
    selected: () => [...select.options].find((option) => option.selected)?.value,
    document,
    window,
    select,
    dispatch,
    requests,
    options: () => [...select.options].map((option) => ({ value: option.value, text: option.textContent })),
    /** Re-run the page's 2s machine refresh with a new `/api/machines` answer. */
    async refresh(next: Machine[]) {
      machines = next;
      await tick!();
    },
    /** Wait for the refresh the page runs on load. */
    async settled() {
      await vi.waitFor(() => expect(requests.some((request) => request.url === '/api/machines')).toBe(true));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

const device = (id: string, connected: boolean, runtimes?: Machine['runtimes']): Machine => ({
  deviceId: id, deviceName: id, connected, ...(runtimes === undefined ? {} : { runtimes }),
});

describe('examples/basic page runtime list', () => {
  it('ships no fixed runtime options', async () => {
    const html = await readFile(pagePath, 'utf8');
    expect(html.match(/<option/g)).toHaveLength(1);
    expect(html).not.toMatch(/<option[^>]*value="(pi|claude|codex)"/);
  });

  it('gives every element id once, so the script finds the element it means', async () => {
    const html = await readFile(pagePath, 'utf8');
    const ids = [...html.matchAll(/<[a-z0-9]+[^>]*\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it('offers nothing and disables Dispatch while no machine is connected', async () => {
    const page = await loadPage([device('d1', false, [{ id: 'pi' }])]);
    await page.settled();
    expect(page.options()).toEqual([{ value: '', text: 'no connected machine' }]);
    expect(page.select.disabled).toBe(true);
    expect(page.dispatch.disabled).toBe(true);
  });

  it('renders pi, claude and codex when the device reports all three', async () => {
    const page = await loadPage([device('d1', true, [
      { id: 'pi', version: '1.2.0', authPresent: true },
      { id: 'claude', version: '2.0.0', authPresent: true },
      { id: 'codex', version: '0.9.0', authPresent: true },
    ])]);
    await page.settled();
    expect(page.options()).toEqual([
      { value: 'pi', text: 'pi' },
      { value: 'claude', text: 'claude' },
      { value: 'codex', text: 'codex' },
    ]);
    expect(page.select.disabled).toBe(false);
    expect(page.dispatch.disabled).toBe(false);
  });

  it('lists only the reported runtimes and marks missing credentials', async () => {
    const page = await loadPage([device('d1', true, [{ id: 'codex', authPresent: false }, { id: 'pi', authPresent: true }])]);
    await page.settled();
    expect(page.options()).toEqual([
      { value: 'codex', text: 'codex (no credentials detected)' },
      { value: 'pi', text: 'pi' },
    ]);
  });

  it('unions connected machines, ignores disconnected ones and keeps the selection across refreshes', async () => {
    const page = await loadPage([
      device('d1', true, [{ id: 'pi', authPresent: false }]),
      device('d2', true, [{ id: 'pi', authPresent: true }, { id: 'claude' }]),
      device('d3', false, [{ id: 'codex' }]),
    ]);
    await page.settled();
    expect(page.options()).toEqual([{ value: 'pi', text: 'pi' }, { value: 'claude', text: 'claude' }]);
    page.choose('claude');
    await page.refresh([device('d2', true, [{ id: 'pi' }, { id: 'claude' }, { id: 'codex' }])]);
    expect(page.options().map((option) => option.value)).toEqual(['pi', 'claude', 'codex']);
    expect(page.selected()).toBe('claude');
    await page.refresh([device('d2', true, [{ id: 'pi' }])]);
    expect(page.selected()).toBe('pi');
    await page.refresh([]);
    expect(page.dispatch.disabled).toBe(true);
  });

  it('dispatches the selected runtime, and omits it when a connected machine reports none', async () => {
    const page = await loadPage([device('d1', true, [{ id: 'pi' }, { id: 'claude' }])]);
    await page.settled();
    (page.document.getElementById('instruction') as unknown as InputEl).value = 'say hi';
    page.choose('claude');
    const devices = page.document.getElementById('device') as unknown as SelectEl;
    for (const option of [...devices.options]) option.selected = option.value === 'd1';
    const submit = () => (page.document.getElementById('task-form') as unknown as FormEl)
      .dispatchEvent(new page.window.Event('submit', { cancelable: true }));
    submit();
    await vi.waitFor(() => expect(page.requests.some((request) => request.url === '/api/tasks')).toBe(true));
    expect(JSON.parse(page.requests.find((request) => request.url === '/api/tasks')!.body!)).toEqual({ instruction: 'say hi', runtime: 'claude', deviceId: 'd1' });

    await page.refresh([device('d1', true, [])]);
    expect(page.options()).toEqual([{ value: '', text: 'no runtime reported' }]);
    expect(page.select.disabled).toBe(true);
    expect(page.dispatch.disabled).toBe(false);
  });
});
