// Runtime source boundary for extension packages without consumable
// declarations. pi-web-access ships its own JS build (no `main`/`exports`), so
// it stays an external dependency; the vendored subagents source is bundled.
export { default as webExtension } from 'pi-web-access/dist/index.js';
export { default as subagentsExtension } from '../../vendor/pi-subagents/0.60.0/index.ts';
