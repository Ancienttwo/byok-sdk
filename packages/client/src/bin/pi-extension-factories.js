// Runtime source boundary for packages which publish TS but no consumable
// declarations. Static exports keep bundling visible; no runtime resolver.
export { default as webExtension } from 'pi-web-access';
export { default as subagentsExtension } from '../../vendor/pi-subagents/0.60.0/index.ts';
