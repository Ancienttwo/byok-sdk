import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundled = await build({
  stdin: { contents: `import {createElement} from 'react'; import {createRoot} from 'react-dom/client'; import {KeysSection} from './src/renderer/keys/keys-section.tsx'; createRoot(document.getElementById('root')).render(createElement(KeysSection));`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"development"' },
});

for (const replacing of [false, true]) test(`${replacing ? 'replacement' : 'configuration'} clears the mounted input before sending`, { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.evaluate(replacing => {
      const stored = { profile_ref: 'writer', display_name: 'Writer', provider_kind: 'zai', adapter: 'openai_compatible',
        auth_mode: 'bearer', base_url: 'https://api.z.ai/api/paas/v4', model: 'glm-4.7', capabilities: [], enabled: false,
        secret_configured: true, configuration_pending: false, profile_revision: 'r1', profile_hash: 'hash' };
      window.byok = {
        onStateChanged: () => () => {},
        call: async (method, change) => {
          if (method === 'keys.list') return replacing ? [stored] : [];
          if (method === 'k8.view') return { busy: false, models: [] };
          if (method === 'keys.submit') {
            window.atSend = { passwords: [...document.querySelectorAll('input[type=password]')].map(input => input.value),
              receivedKey: change.secret === 'synthetic-pending-key' };
            return new Promise((_resolve, reject) => { window.refuseSave = () => reject(new Error('Reload stored providers')); });
          }
          throw new Error(method);
        },
      };
    }, replacing);
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    if (replacing) {
      await page.getByRole('button', { name: /^Writer \(writer\)/ }).click();
      await page.getByLabel(/^New API key/).fill('synthetic-pending-key');
    } else {
      await page.getByLabel(/^Profile id/).fill('zai-main');
      await page.getByLabel(/^Name/).fill('GLM main');
      await page.getByLabel(/^Provider/).selectOption('zai');
      await page.locator('label').filter({ hasText: /^Model/ }).locator('input').fill('glm-4.7');
      await page.locator('input[type=password]').fill('synthetic-pending-key');
    }
    await page.getByRole('button', { name: replacing ? 'Replace key' : 'Save', exact: true }).click();
    const atSend = await page.evaluate(() => window.atSend);
    assert.equal(atSend.receivedKey, true);
    assert.ok(atSend.passwords.length > 0);
    assert.ok(atSend.passwords.every(value => value === ''), 'password inputs must be empty at bridge invocation');
    assert.equal(await page.getByRole('button', { name: 'Reload', exact: true }).isDisabled(), true);
    await page.evaluate(() => window.refuseSave());
    await page.getByRole('alert').waitFor();
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'Reload').disabled);
    assert.ok((await page.locator('input[type=password]').evaluateAll(inputs => inputs.map(input => input.value))).every(value => value === ''));
  } finally { await browser.close(); }
});
