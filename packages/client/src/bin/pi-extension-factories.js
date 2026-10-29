// Runtime source boundary for extension packages without consumable
// declarations. pi-web-access ships its own JS build (no `main`/`exports`), so
// it stays an external dependency.
export { default as webExtension } from 'pi-web-access/dist/index.js';
