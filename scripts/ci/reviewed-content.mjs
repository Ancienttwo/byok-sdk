import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseBunLock } from '../release/pi-runtime-identity.mjs';

// The nine published manifests. A contract test keeps this list equal to the
// non-private packages/*/package.json files.
export const publicManifests = Object.freeze([
  'client', 'cloud', 'cloud-dataplane', 'cloud-do', 'core', 'keys', 'protocol', 'server', 'ui-runtime',
].map(name => `packages/${name}/package.json`));

// #700 moves the exact undici pin from 8.11.2 to the patched 8.12.3. 8.12.2 is
// the first 8.x release that fixes the 2026-10-15 advisories. Each workspace
// below declares undici in exactly this manifest field.
const UNDICI_MOVE = { from: '8.11.2', to: '8.12.3' };
const UNDICI_FIELDS = { 'packages/client': 'dependencies', 'packages/cloud-dataplane': 'devDependencies' };
const UNDICI_LOCK = {
  from: ['undici@8.11.2', '', {}, 'sha512-u4UB2/IrKdU6lFxumHmmo1a3fCQO5tzQllRorfoRS63txhrB7xTpSn1PftwC4qEHkOaqP95fCWW4lJzwErwzhQ=='],
  to: ['undici@8.12.3', '', {}, 'sha512-+fdndUTwBP86cVjihTp21hZHo7d6oj1c/47XPA3lL8mM0XHs+C4EkcjmgRsFnFk2f/UONGDy9ItBItmXsLOQHw=='],
};
// Restore the reviewed old pin, so that the deep comparison still sees every other change.
function revertUndiciMove(before, after, field) {
  if (before?.[field]?.undici !== UNDICI_MOVE.from || after?.[field]?.undici !== UNDICI_MOVE.to) return false;
  after[field].undici = UNDICI_MOVE.from;
  return true;
}

// #1102: the upgrade-manifest gate, its test in test:scripts, and the client
// files entry that ships the manifest.
const UPGRADE_MANIFEST_GATE = 'node scripts/release/check-upgrade-manifest.mjs';
const UPGRADE_MANIFEST_TEST = 'scripts/release/check-upgrade-manifest.test.mjs';
const CLIENT_FILES = Object.freeze(['dist', 'README.md', 'LICENSE']);

// #925 wire v4: the protocol compatibility oracle moves to 0.30.2, the last
// v3 release, and the 0.27.0 floor alias goes. Only these exact edges and
// their two lock rows are admitted.
const PROTOCOL_ORACLE_URL = version => `https://registry.npmjs.org/@byok-sdk/protocol/-/protocol-${version}.tgz`;
const PROTOCOL_ORACLE = Object.freeze({ previous: { from: PROTOCOL_ORACLE_URL('0.26.1'), to: PROTOCOL_ORACLE_URL('0.30.2') }, floor: PROTOCOL_ORACLE_URL('0.27.0') });
export const PROTOCOL_ORACLE_LOCK = Object.freeze({
  previous: {
    from: [`@byok-sdk/protocol@${PROTOCOL_ORACLE.previous.from}`, { dependencies: { zod: '^4.4.3' } }, 'sha512-eUucLQqUNWtOn43Iv+8ZYiWzpf+yd8+M/wNIGWJdVQKOODyXBknxWDd/7Mmp/TPKfkl5BH0hfZ6Jl1xwx9NMXg=='],
    to: [`@byok-sdk/protocol@${PROTOCOL_ORACLE.previous.to}`, { dependencies: { '@cfworker/json-schema': '4.1.1', zod: '^4.4.3' } }, 'sha512-K3efRUJqxXo0F/reaZQU0LyOn3AsUwwh7zP4xkMda7J/NwfnRjPHX3EyWdVhFn504z21QqLWKwac2Tw/Rk5VZQ=='],
  },
  floor: [`@byok-sdk/protocol@${PROTOCOL_ORACLE.floor}`, { dependencies: { '@cfworker/json-schema': '4.1.1', zod: '^4.4.3' } }, 'sha512-fJvgAq/C1RKlb7QL+4yrrZvKP/Gn9ltw+kO0b0BFaBycHZmViid6hlOl0yMOHRHIusHMU1cudaiUqaC+uAfCZA=='],
});
// Restore the reviewed old edges, so that the deep comparison still sees every other change.
function revertProtocolOracleMove(before, after) {
  const from = before?.devDependencies, to = after?.devDependencies;
  if (from?.['byok-protocol-previous'] !== PROTOCOL_ORACLE.previous.from || to?.['byok-protocol-previous'] !== PROTOCOL_ORACLE.previous.to
    || from?.['byok-protocol-floor'] !== PROTOCOL_ORACLE.floor || to?.['byok-protocol-floor'] !== undefined) return false;
  to['byok-protocol-previous'] = PROTOCOL_ORACLE.previous.from;
  to['byok-protocol-floor'] = PROTOCOL_ORACLE.floor;
  return true;
}

// The Pi 1.4.0 ruling (docs/spec.md) moves the nine official Pi packages from
// exactly 1.3.0 to exactly 1.4.0 together: the root overrides, the client and
// cloud-do dependencies (with byok.piRuntimePin) and bun.lock. PI_LOCK holds the
// reviewed 1.4.0 lock rows, plus pi-tui's one new dependency.
const PI_MOVE = { from: '1.3.0', to: '1.4.0' };
export const PI_PACKAGES = ['chord', 'pi-agent-core', 'pi-ai', 'pi-codemode', 'pi-coding-agent', 'pi-durable', 'pi-mcp', 'pi-telemetry', 'pi-tui']
  .map(name => `@earendil-works/${name}`);
const PI_FIELDS = { 'packages/client': 'dependencies', 'packages/cloud-do': 'dependencies' };
export const PI_LOCK = {
  '@earendil-works/chord': ['@earendil-works/chord@1.4.0','',{'dependencies':{'@earendil-works/pi-telemetry':'1.4.0','typebox':'1.3.27'}},'sha512-dTbgyz4xgDS5KAUFx1bFENqj0Cr1N3tYxJJOYStc6g6HS78FSBZydyoCwLoddiQRF+VgRS0fpgAi+iKxjZ3BQA=='],
  '@earendil-works/pi-agent-core': ['@earendil-works/pi-agent-core@1.4.0','',{'dependencies':{'@earendil-works/pi-ai':'1.4.0','typebox':'1.3.27'}},'sha512-PoKY84SKUwnt7S5QBZaGUqfNO1kjP3KHpHUA9QpFTj4cOjaVWMYIcBPJ6FDRCdE8Zen9OSECQUd0uUfVgtSmgA=='],
  '@earendil-works/pi-ai': ['@earendil-works/pi-ai@1.4.0','',{'dependencies':{'@anthropic-ai/sdk':'0.129.0','@aws-sdk/client-bedrock-runtime':'3.1127.0','@earendil-works/pi-telemetry':'1.4.0','@google/genai':'2.21.0','@smithy/node-http-handler':'4.12.1','http-proxy-agent':'9.1.0','https-proxy-agent':'9.1.0','openai':'7.19.0','partial-json':'0.1.7','typebox':'1.3.27'},'bin':{'pi-ai':'dist/cli.js'}},'sha512-hQM/C4+1w8rHYACzDDf+0vQMnEnpzIop1tptIERVgR3ZeT/hHSzBNG8PaWPgxWQjqSeKCyBZSyp8uTT6eKK1pQ=='],
  '@earendil-works/pi-codemode': ['@earendil-works/pi-codemode@1.4.0','',{'dependencies':{'quickjs-wasi':'3.6.2'}},'sha512-23CNAXpS9DuLzPMyYuvrXVVio46x4YhffCgCqaWmF7F5H8PooqjrQvX4ucF6M0BhUd+x2tV6r1J0dv8cCME4Cg=='],
  '@earendil-works/pi-coding-agent': ['@earendil-works/pi-coding-agent@1.4.0','',{'dependencies':{'@earendil-works/pi-agent-core':'1.4.0','@earendil-works/pi-ai':'1.4.0','@earendil-works/pi-codemode':'1.4.0','@earendil-works/pi-mcp':'1.4.0','@earendil-works/pi-tui':'1.4.0','@silvia-odwyer/photon-node':'0.3.4','brace-expansion':'5.0.12','chalk':'6.0.0','cross-spawn':'7.0.6','diff':'8.0.4','grok-mermaid':'0.2.3','highlight.js':'10.7.3','hosted-git-info':'9.0.3','ignore':'7.0.8','jiti':'2.7.0','minimatch':'10.2.6','proper-lockfile':'4.1.2','quickjs-wasi':'3.6.2','semver':'7.8.5','typebox':'1.3.27','undici':'8.10.2','yaml':'2.9.0'},'bin':{'pi':'dist/bundle/cli.js'}},'sha512-Z41LpZ3yYHSC/UUps6Mr39UMFPwH8elhJBG9DY1P7kuzsE5qSK/6eMj2EHzO5evJRQWLbKSqUMw+4nCNtIyiQg=='],
  '@earendil-works/pi-durable': ['@earendil-works/pi-durable@1.4.0','',{'dependencies':{'@earendil-works/chord':'1.4.0','@earendil-works/pi-ai':'1.4.0','@earendil-works/pi-codemode':'1.4.0','@earendil-works/pi-telemetry':'1.4.0','@silvia-odwyer/photon':'0.3.3','diff':'8.0.4','typebox':'1.3.27'}},'sha512-EtIyXH1MBSXdJSkodmy+CYXuwfve3gPrD4GNCZ0XmuRWLPupwRlNQ7fdaXjRcLoKb6SWkT/yEzK+sMmrqvYK+Q=='],
  '@earendil-works/pi-mcp': ['@earendil-works/pi-mcp@1.4.0','',{'dependencies':{'cross-spawn':'7.0.6'}},'sha512-92aZmmGsUpHHknYuKXZHRINQfahntw5hU9If0I0ZM49GojOaFHpkl5/GF3/aatqpt7v7GjZbBfpfSygGKW+pnw=='],
  '@earendil-works/pi-telemetry': ['@earendil-works/pi-telemetry@1.4.0','',{},'sha512-MLIfowwUYIY65jSjMX82paZOrX/NTvLk6D08h+3Jq42a99RzUOewzuCR0zOlPul3D6UBfddat76VT6LvsHEs1w=='],
  '@earendil-works/pi-tui': ['@earendil-works/pi-tui@1.4.0','',{'dependencies':{'get-east-asian-width':'1.6.0','marked':'18.0.11','marked-cjk-friendly':'0.1.2'}},'sha512-4obPOjgOD7g4mGSlngIvxyujC1UPdmyI9zdVthbr8GufacFEX+Ce0+scPgHg++k2xj5+QjESM2d5TxvIuzCVmg=='],
  'marked-cjk-friendly': ['marked-cjk-friendly@0.1.2','',{'peerDependencies':{'marked':'>=15.0.0'}},'sha512-GUj8HjiEbur9yhgUo52FBgKizggF1QtT6gVdrYdWW6ZB4lVVjgS3EyyXPyfyRD0V4ghGRPlO7MO80rgSWbm0eA=='],
};
const PI_ADDED = ['marked-cjk-friendly'];
// Restore the old pins only when every Pi package in this field moves exactly.
function revertPiMove(before, after, field) {
  const from = before?.[field], to = after?.[field];
  if (!plain(from) || !plain(to)) return false;
  const names = PI_PACKAGES.filter(name => name in from || name in to);
  if (!names.length || names.some(name => from[name] !== PI_MOVE.from || to[name] !== PI_MOVE.to)) return false;
  for (const name of names) to[name] = PI_MOVE.from;
  return true;
}

// Pi extension move: pi-web-access 0.24.1 -> 0.45.0 becomes an ordinary
// external dependency, so the client drops the six pins it carried only for
// the inlined TS source; rpiv-i18n and rpiv-config move 2.8.0 -> 2.15.0 with
// the re-vendored rpiv-todo 2.15.0. EXTENSION_LOCK holds the reviewed changed
// rows and every added row: the @modelcontextprotocol/sdk 1.x and defuddle
// closures that pi-web-access 0.45.0 declares.
const EXTENSION_MOVE = Object.freeze({
  moved: Object.freeze({ 'pi-web-access': ['0.24.1', '0.45.0'], '@juicesharp/rpiv-i18n': ['2.8.0', '2.15.0'], '@juicesharp/rpiv-config': ['2.8.0', '2.15.0'] }),
  removed: Object.freeze({ '@mozilla/readability': '0.6.0', linkedom: '0.16.11', 'p-limit': '6.2.0', 'promise.try': '2.0.1', turndown: '7.2.4', unpdf: '1.8.1' }),
});
export const EXTENSION_LOCK = Object.freeze({
  changed: {
    '@juicesharp/rpiv-config': { from: ['@juicesharp/rpiv-config@2.8.0','',{dependencies:{typebox:'^1.1.24'}},'sha512-mVQWnXw3CO8B8X4eRXq7kwkmcAjsdYOhqpS+zyTteoiipF0z/wV49kSGIN9lOpF6D2Rb1fcXiaZciFBaE+vsVg=='], to: ['@juicesharp/rpiv-config@2.15.0','',{peerDependencies:{typebox:'*'}},'sha512-S2BAGX4dJjQ2AyNYOEjC6ha04p9f6CdEfmtxpdxzSKrfDMwqIvOjjO9HiHc1IPY7jDY1q2Q8cGCtpIZWV6Y8NQ=='] },
    '@juicesharp/rpiv-i18n': { from: ['@juicesharp/rpiv-i18n@2.8.0','',{dependencies:{'@juicesharp/rpiv-config':'^2.8.0'},peerDependencies:{'@earendil-works/pi-coding-agent':'*','@earendil-works/pi-tui':'*'}},'sha512-1qIxwN45JiyFMow7qk3OkrCAVIeH5avDbL7XJhGFyom0CSyAqptApQHPtGLQmNXQgNhu6xjN4ocNOA0IIFxUFw=='], to: ['@juicesharp/rpiv-i18n@2.15.0','',{dependencies:{'@juicesharp/rpiv-config':'^2.15.0'},peerDependencies:{'@earendil-works/pi-coding-agent':'*','@earendil-works/pi-tui':'*'}},'sha512-YpC8nN2dO/oi3slxMPvF2TQsitVY4IWdoLoT0C7EV7jxPVrySXx7Iucx9oeaP5zlO4pu2Mei5q3UFy3Ni2xwWw=='] },
    'content-type': { from: ['content-type@2.1.0','',{},'sha512-mj7UPXE0jaqaOsukNZRUEfEi2AcL7C/vwmwcHV0O97eO1E1pxBZuyjlZrx5seTaNBg1U6+o35wpa35Qfcc+7ag=='], to: ['content-type@1.0.5','',{},'sha512-nTjqfcBFEipKdXCv4YDQWCfmcLZKm81ldF0pAopTvyrFGVbcR6P/VAAd5G7N+0tTr8QqiU0tFadD6FK4NtJwOA=='] },
    'pi-web-access': { from: ['pi-web-access@0.24.1','',{dependencies:{'@mozilla/readability':'^0.6.0',linkedom:'^0.16.0','p-limit':'^6.1.0','promise.try':'^2.0.1',turndown:'^7.2.0',typebox:'^1.1.38',undici:'^8.9.0',unpdf:'^1.6.2'},peerDependencies:{'@earendil-works/pi-ai':'*','@earendil-works/pi-coding-agent':'*','@earendil-works/pi-tui':'*'}},'sha512-kNYVqPT2wbWbDKD2mfMsrCie1DyVsE/KYNVgpp7yqq072sG2PciKAB28PG4h0+klSO3MtCFRoPWAyA+l0CS7/A=='], to: ['pi-web-access@0.45.0','',{dependencies:{'@modelcontextprotocol/sdk':'1.32.1','@mozilla/readability':'^0.6.0',defuddle:'0.19.3',linkedom:'^0.16.0','p-limit':'^6.1.0','promise.try':'^2.0.1',turndown:'^7.2.0',undici:'^8.11.2',unpdf:'^1.6.2'},peerDependencies:{'@earendil-works/pi-ai':'*','@earendil-works/pi-coding-agent':'*','@earendil-works/pi-tui':'*',typebox:'*'},optionalPeers:['@earendil-works/pi-ai','@earendil-works/pi-coding-agent','@earendil-works/pi-tui'],bin:{'pi-web-access-mcp':'dist/mcp-cli.js'}},'sha512-AHgUKUas1vvBtdKbcv+7rWTPTIOl8xHR4E7s4dLBAz6soSGGPC4YNq1uVGuH5+bVrMx4X/fmPCm4rsOQIxexdQ=='] },
  },
  added: {
    '@acemir/cssom': ['@acemir/cssom@0.9.32','',{},'sha512-OijrAUu7rrJhSIoHNg6LMPS5e344nwUHA+1EFYYjrh64D+GmytUsfBQjci45TjT+rd5Spsp8B5xsZDT+TgyXXQ=='],
    '@modelcontextprotocol/sdk': ['@modelcontextprotocol/sdk@1.32.1','',{dependencies:{'@hono/node-server':'^1.19.9 || ^2.0.5',ajv:'^8.17.1','ajv-formats':'^3.0.1','content-type':'^1.0.5',cors:'^2.8.5','cross-spawn':'^7.0.5',eventsource:'^3.0.2','eventsource-parser':'^3.0.0',express:'^5.2.1','express-rate-limit':'^8.2.1',hono:'^4.11.4',jose:'^6.1.3','json-schema-typed':'^8.0.2','pkce-challenge':'^5.0.0','raw-body':'^3.0.0',zod:'^3.25 || ^4.0','zod-to-json-schema':'^3.25.1'},peerDependencies:{'@cfworker/json-schema':'^4.1.1'},optionalPeers:['@cfworker/json-schema']},'sha512-2DdE+SJDtzLEEWzY1ZjY7Q+VcPhcV1KisD3zI4u0XZyktsjHum1mwbMI+JaulUBi2OZk+KJAi2uPXzxichPkdw=='],
    '@xmldom/xmldom': ['@xmldom/xmldom@0.9.12','',{},'sha512-5AXjrcMClTryPe9LgZrygpB1lj7s0S9E0+W+AHaVKAVyHanafK86iPSvG5xHVSp/jC+VH1UXu0TAEmY279xH7A=='],
    'accepts': ['accepts@2.0.0','',{dependencies:{'mime-types':'^3.0.0',negotiator:'^1.0.0'}},'sha512-5cvg6CtKwfgdmVqY1WIiXKc3Q1bkRqGLi+2W/6ao+6Y7gu/RCwRuAhGEzh5B4KlszSuTLgZYuqFqo5bImjNKng=='],
    'ajv': ['ajv@8.20.0','',{dependencies:{'fast-deep-equal':'^3.1.3','fast-uri':'^3.0.1','json-schema-traverse':'^1.0.0','require-from-string':'^2.0.2'}},'sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA=='],
    'ajv-formats': ['ajv-formats@3.0.1','',{dependencies:{ajv:'^8.0.0'}},'sha512-8iUql50EUR+uUcdRQ3HDqa6EVyo3docL8g5WJ3FNcWmu62IbkGUue/pEyLBW8VGKKucTPgqeks4fIU1DA4yowQ=='],
    'body-parser': ['body-parser@2.4.0','',{dependencies:{bytes:'^3.1.2','content-type':'^2.1.0',debug:'^4.4.3','http-errors':'^2.0.1','iconv-lite':'^0.7.3','on-finished':'^2.4.1',qs:'^6.16.1','raw-body':'^3.0.2','type-is':'^2.1.0'}},'sha512-Ifk1KcLrxaGt1occQagQNFNNOqRt1LFuehEnHHzB8Z6cRgIxRU1TBaiIsUiCdA+gy5PL7Y1IX31DNKkRmxtXjQ=='],
    'body-parser/content-type': ['content-type@2.1.0','',{},'sha512-mj7UPXE0jaqaOsukNZRUEfEi2AcL7C/vwmwcHV0O97eO1E1pxBZuyjlZrx5seTaNBg1U6+o35wpa35Qfcc+7ag=='],
    'bytes': ['bytes@3.1.2','',{},'sha512-/Nf7TyzTx6S3yRJObOAV7956r8cr2+Oj8AC5dt8wSP3BQAoeX58NoHyCU8P8zGkNXStjTSi6fzO6F0pBdcYbEg=='],
    'content-disposition': ['content-disposition@2.0.1','',{},'sha512-e+H0ZXHSWYrENhQzw1LPuP4oF5MzVKmDU6d3hxlvaPEYLLg62MxtQNPRx4SYSuYJSBUgnQIG4HIN2tEtNv7Dog=='],
    'cookie-signature': ['cookie-signature@1.2.2','',{},'sha512-D76uU73ulSXrD1UXF4KE2TMxVVwhsnCgfAyTg9k8P6KGZjlXKrOLe4dJQKI3Bxi5wjesZoFXJWElNWBjPZMbhg=='],
    'cors': ['cors@2.8.6','',{dependencies:{'object-assign':'^4',vary:'^1'}},'sha512-tJtZBBHA6vjIAaF6EnIaq6laBBP9aq/Y3ouVJjEfoHbRBcHBAHYcMh/w8LDrk2PvIMMq8gmopa5D4V8RmbrxGw=='],
    'defuddle': ['defuddle@0.19.3','',{dependencies:{commander:'^12.1.0'},optionalDependencies:{linkedom:'^0.18.12','mathml-to-latex':'^1.8.0',temml:'^0.13.3',turndown:'^7.2.0'},bin:{defuddle:'dist/cli.js'}},'sha512-5ZbOQ/B+iiRRqSQWwmCx/zEuqZOA/5q7gxyE2/4O2Bxq7nUC0PgKw9EdyxqWbFF1nrrrYemSeR25jg4TmA2fsA=='],
    'defuddle/commander': ['commander@12.1.0','',{},'sha512-Vw8qHK3bZM9y/P10u3Vib8o/DdkvA2OtPtZvD871QKjy74Wj1WSKFILMPRPSdUSx5RFK1arlJzEtA4PkFgnbuA=='],
    'defuddle/linkedom': ['linkedom@0.18.14','',{dependencies:{'@acemir/cssom':'^0.9.32','css-select':'^7.0.0','html-escaper':'^3.0.3',htmlparser2:'^10.1.0',uhyphen:'^0.2.0'},peerDependencies:{canvas:'>= 2'},optionalPeers:['canvas']},'sha512-BRUnkOm4YR5vo+qI3j0EbungB0vZPSCue5AdnTQRaxAGSbsOZiBFRO0rh4zlo8qXUhli8pxvnpEXDklMnlq2Rg=='],
    'defuddle/linkedom/css-select': ['css-select@7.0.0','',{dependencies:{boolbase:'^2.0.0','css-what':'^8.0.0',domhandler:'^6.0.1',domutils:'^4.0.2','nth-check':'^3.0.1'}},'sha512-snmjEVXy+1LnwXdxhYvTMj1d9tOh4HxkA1YmoayVBeeyR2C14Pum7fcxJIm4SswYspVy866eYNwlH6xC3/VH5g=='],
    'defuddle/linkedom/css-select/boolbase': ['boolbase@2.0.0','',{},'sha512-DkVaaQHymRhpYEYo9x1oo7Q7B0Y6KJUsjm3c9eTyFDby4MHLBTwZ6ZDWBel5zrYxj1WsZgC5oLpiz+93MluXeA=='],
    'defuddle/linkedom/css-select/css-what': ['css-what@8.0.0','',{},'sha512-DH0Bqq3DNp5tdOReuNyAA+Ev4Y2GS5FMbZpeTLP6C4CDi0h5nL0BmUPChXw3o/qbHLDWHl49sbNqQVY7bMSDdw=='],
    'defuddle/linkedom/css-select/domhandler': ['domhandler@6.0.1','',{dependencies:{domelementtype:'^3.0.0'}},'sha512-gYzvtM72ZtxQO0T048kd6HWSbbGCNOUwcnfQ01cqIJ4X2IYKFFHZ5mKvrQETcFXxsRObZulDaKmy//R7TPtsBg=='],
    'defuddle/linkedom/css-select/domhandler/domelementtype': ['domelementtype@3.0.0','',{},'sha512-umCQid3jKbDmVjx8jGaW7uUykm4DEUeyV21hPxNMo2nV955DhUThwqyOIDtreepP31hl84X7G5U9ZfsWvIB3Pg=='],
    'defuddle/linkedom/css-select/domutils': ['domutils@4.0.2','',{dependencies:{'dom-serializer':'^3.0.0',domelementtype:'^3.0.0',domhandler:'^6.0.0'}},'sha512-qI4JLRKnSzqFqr7hAlS5xQDusBCjKSEG4t4+7aNrIQMHBcsC2TGEhuyABJdYkgSewL57PNLYEiibY2iPKhKpaA=='],
    'defuddle/linkedom/css-select/domutils/dom-serializer': ['dom-serializer@3.1.1','',{dependencies:{domelementtype:'^3.0.0',domhandler:'^6.0.0',entities:'^8.0.0'}},'sha512-4MEa38/QexBob6gFNwu+EGdWvhJ1OKuNwdYY3Y3NyeWDQfnGeDYQUDfIRzWu5B5gsv03so2Uxd28YC6zrsx3Lw=='],
    'defuddle/linkedom/css-select/domutils/dom-serializer/entities': ['entities@8.1.0','',{},'sha512-kxL7msIffSuh9aaFAMD7rxAIuTRMAHMeBtgHW2yUdWw732ZNh4MehkF2gdjvtdmikkaIP9bFDDJOPlsvm7avrA=='],
    'defuddle/linkedom/css-select/domutils/domelementtype': ['domelementtype@3.0.0','',{},'sha512-umCQid3jKbDmVjx8jGaW7uUykm4DEUeyV21hPxNMo2nV955DhUThwqyOIDtreepP31hl84X7G5U9ZfsWvIB3Pg=='],
    'defuddle/linkedom/css-select/nth-check': ['nth-check@3.0.1','',{dependencies:{boolbase:'^2.0.0'}},'sha512-GX0gsdbGVCgnRgbeGaubfjpBXyYRWOOCVeYh08bSQvDZqxz5ndXs1OTfAt/h36G1xvI94YIspsI0sVFqAV9+RQ=='],
    'defuddle/linkedom/htmlparser2': ['htmlparser2@10.1.0','',{dependencies:{domelementtype:'^2.3.0',domhandler:'^5.0.3',domutils:'^3.2.2',entities:'^7.0.1'}},'sha512-VTZkM9GWRAtEpveh7MSF6SjjrpNVNNVJfFup7xTY3UpFtm67foy9HDVXneLtFVt4pMz5kZtgNcvCniNFb1hlEQ=='],
    'defuddle/linkedom/htmlparser2/entities': ['entities@7.0.1','',{},'sha512-TWrgLOFUQTH994YUyl1yT4uyavY5nNB5muff+RtWaqNVCAK408b5ZnnbNAUEWLTCpum9w6arT70i1XdQ4UeOPA=='],
    'depd': ['depd@2.0.0','',{},'sha512-g7nH6P6dyDioJogAAGprGpCtVImJhpPk/roCzdb3fIh61/s/nPsfR6onyMwkCAR/OlC3yBC0lESvUoQEAssIrw=='],
    'ee-first': ['ee-first@1.1.1','',{},'sha512-WMwm9LhRUo+WUaRN+vRuETqG89IgZphVSNkdFgeb6sS/E4OrDIN7t48CAewSHXc6C8lefD8KKfr5vY61brQlow=='],
    'encodeurl': ['encodeurl@2.0.0','',{},'sha512-Q0n9HRi4m6JuGIV1eFlmvJB7ZEVxu93IrMyiMsGC0lrMJMWzRgx6WGquyfQgZVb31vhGgXnfmPNNXmxnOkRBrg=='],
    'escape-html': ['escape-html@1.0.3','',{},'sha512-NiSupZ4OeuGwr68lGIeym/ksIZMJodUGOSCZ/FSnTxcrekbvqrgdUxlJOMpijaKZVjAJrWrGs/6Jy8OMuyj9ow=='],
    'etag': ['etag@1.8.1','',{},'sha512-aIL5Fx7mawVa300al2BnEE4iNvo1qETxLrPI/o05L7z6go7fCw1J6EQmbK4FmJ2AS7kgVF/KEZWufBfdClMcPg=='],
    'express': ['express@5.3.0','',{dependencies:{accepts:'^2.0.0','body-parser':'^2.3.0','content-disposition':'^2.0.1','content-type':'^2.0.0',cookie:'^0.7.1','cookie-signature':'^1.2.1',debug:'^4.4.0',depd:'^2.0.0',encodeurl:'^2.0.0','escape-html':'^1.0.3',etag:'^1.8.1',finalhandler:'^2.1.0',fresh:'^2.0.0','http-errors':'^2.0.0','merge-descriptors':'^2.0.0','mime-types':'^3.0.0','on-finished':'^2.4.1',once:'^1.4.0',parseurl:'^1.3.3','proxy-addr':'^2.0.8',qs:'^6.16.0','range-parser':'^1.2.1',router:'^2.2.0',send:'^1.1.0','serve-static':'^2.2.0',statuses:'^2.0.1','type-is':'^2.1.0',vary:'^1.1.2'}},'sha512-qCqy1xSoaugxOD4IVHb1ZWdkvCF2W3aE2okKouWj8VwJ+ztskSiXoBnCSJqfKT+cVPJhuJqe9YLbY425+Zh00g=='],
    'express-rate-limit': ['express-rate-limit@8.7.1','',{dependencies:{debug:'^4.4.3','ip-address':'^10.2.0'},peerDependencies:{express:'>= 4.11'}},'sha512-2FXbqkygil3mZiXzEtM0IjE/UBmBNot0J1GEVrJT4JbrvwOSoEtqtO+wHbiMQELWe1eNvHoYRg2dkjOid+6JkA=='],
    'express/content-type': ['content-type@2.1.0','',{},'sha512-mj7UPXE0jaqaOsukNZRUEfEi2AcL7C/vwmwcHV0O97eO1E1pxBZuyjlZrx5seTaNBg1U6+o35wpa35Qfcc+7ag=='],
    'express/cookie': ['cookie@0.7.2','',{},'sha512-yki5XnKuf750l50uGTllt6kKILY4nQ1eNIQatoXEByZ5dWgnKqbnqmTrBE5B4N7lrMJKQ2ytWMiTO2o0v6Ew/w=='],
    'fast-deep-equal': ['fast-deep-equal@3.1.3','',{},'sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q=='],
    'fast-uri': ['fast-uri@3.1.9','',{},'sha512-hS/0Wt3Ya043oKXs0sIxrMpKQITXhMLIrVAKKXi4gozGC9v7YRWVnXIZzjNPTO02M9BdxLCWqK1yRXgNziVyJQ=='],
    'finalhandler': ['finalhandler@2.1.1','',{dependencies:{debug:'^4.4.0',encodeurl:'^2.0.0','escape-html':'^1.0.3','on-finished':'^2.4.1',parseurl:'^1.3.3',statuses:'^2.0.1'}},'sha512-S8KoZgRZN+a5rNwqTxlZZePjT/4cnm0ROV70LedRHZ0p8u9fRID0hJUZQpkKLzro8LfmC8sx23bY6tVNxv8pQA=='],
    'forwarded': ['forwarded@0.2.0','',{},'sha512-buRG0fpBtRHSTCOASe6hD258tEubFoRLb4ZNA6NxMVHNw2gOcwHo9wyablzMzOA5z9xA9L1KNjk/Nt6MT9aYow=='],
    'fresh': ['fresh@2.0.0','',{},'sha512-Rx/WycZ60HOaqLKAi6cHRKKI7zxWbJ31MhntmtwMoaTeF7XFH9hhBp8vITaMidfljRQ6eYWCKkaTK+ykVJHP2A=='],
    'http-errors': ['http-errors@2.0.1','',{dependencies:{depd:'~2.0.0',inherits:'~2.0.4',setprototypeof:'~1.2.0',statuses:'~2.0.2',toidentifier:'~1.0.1'}},'sha512-4FbRdAX+bSdmo4AUFuS0WNiPz8NgFt+r8ThgNWmlrjQjt1Q7ZR9+zTlce2859x4KSXrwIsaeTqDoKQmtP8pLmQ=='],
    'inherits': ['inherits@2.0.4','',{},'sha512-k/vGaX4/Yla3WzyMCvTQOXYeIHvqOKtnqBduzTHpzpQZzAskKMhZ2K+EnBiSM9zGSoIFeMpXKxa4dYeZIQqewQ=='],
    'ipaddr.js': ['ipaddr.js@1.9.1','',{},'sha512-0KI/607xoxSToH7GjN1FfSbLoU0+btTicjsQSWQlh/hZykN8KpmMf7uYwPW3R+akZ6R/w18ZlXSHBYXiYUPO3g=='],
    'is-promise': ['is-promise@4.0.0','',{},'sha512-hvpoI6korhJMnej285dSg6nu1+e6uxs7zG3BYAm5byqDsgJNWwxzM6z6iZiAgQR4TJ30JmBTOwqZUw3WlyH3AQ=='],
    'json-schema-traverse': ['json-schema-traverse@1.0.0','',{},'sha512-NM8/P9n3XjXhIZn1lLhkFaACTOURQXjWhV4BA/RnOv8xvgqtqpAX9IO4mRQxSx1Rlo4tqzeqb0sOlruaOy3dug=='],
    'json-schema-typed': ['json-schema-typed@8.0.2','',{},'sha512-fQhoXdcvc3V28x7C7BMs4P5+kNlgUURe2jmUT1T//oBRMDrqy1QPelJimwZGo7Hg9VPV3EQV5Bnq4hbFy2vetA=='],
    'mathml-to-latex': ['mathml-to-latex@1.8.0','',{dependencies:{'@xmldom/xmldom':'^0.9.10'}},'sha512-gQ0uK3zqB8HwlfaXJkEL5rgaZNbKUiBMmBP/B/W+b+t6KcseLSuYb1b0BjLgS9ZiQa24ePkqTX8/6FaQuDL7wQ=='],
    'media-typer': ['media-typer@1.1.1','',{},'sha512-yz3xRaG20c6/BOzvYoDaGtPmGscs7YivItZEEqe6GbwNfHuxu9YNmvnEkMzKldAGY4/80pRcQRZSEnhquk9XuQ=='],
    'merge-descriptors': ['merge-descriptors@2.0.0','',{},'sha512-Snk314V5ayFLhp3fkUREub6WtjBfPdCPY1Ln8/8munuLuiYhsABgBVWsozAG+MWMbVEvcdcpbi9R7ww22l9Q3g=='],
    'mime-db': ['mime-db@1.54.0','',{},'sha512-aU5EJuIN2WDemCcAp2vFBfp/m4EAhWJnUNSSw0ixs7/kXbd6Pg64EmwJkNdFhB8aWt1sH2CTXrLxo/iAGV3oPQ=='],
    'mime-types': ['mime-types@3.0.2','',{dependencies:{'mime-db':'^1.54.0'}},'sha512-Lbgzdk0h4juoQ9fCKXW4by0UJqj+nOOrI9MJ1sSj4nI8aI2eo1qmvQEie4VD1glsS250n15LsWsYtCugiStS5A=='],
    'negotiator/content-type': ['content-type@2.1.0','',{},'sha512-mj7UPXE0jaqaOsukNZRUEfEi2AcL7C/vwmwcHV0O97eO1E1pxBZuyjlZrx5seTaNBg1U6+o35wpa35Qfcc+7ag=='],
    'on-finished': ['on-finished@2.4.2','',{dependencies:{'ee-first':'1.1.1'}},'sha512-ATWUv387i+nLD49EiDoOft5scf32Vsdz3ktrQJG9bi7jRFmaXTssvyvj1EmeKVVgvesbqUtvQQvaS2TpTukAZQ=='],
    'once': ['once@1.4.0','',{dependencies:{wrappy:'1'}},'sha512-lNaJgI+2Q5URQBkccEKHTQOPaXdUxnZZElQTZY0MFUAuaEqe1E+Nyvgdz/aIyNi6Z9MzO5dv1H8n58/GELp3+w=='],
    'parseurl': ['parseurl@1.3.3','',{},'sha512-CiyeOxFT/JZyN5m0z9PfXw4SCBJ6Sygz1Dpl0wqjlhDEGGBP1GnsUVEL0p63hoG1fcj3fHynXi9NYO4nWOL+qQ=='],
    'proxy-addr': ['proxy-addr@2.0.8','',{dependencies:{forwarded:'0.2.0','ipaddr.js':'1.9.1'}},'sha512-5nnx0yGyVUcY6t9RnWcARWtwT9F1D8O9rt08htPvnd49W1IgZtmLkhu9WfMzQj1cFxjHIO6connUNVW5k7AVyQ=='],
    'qs': ['qs@6.17.0','',{dependencies:{'es-define-property':'^1.0.1','side-channel':'^1.1.1'}},'sha512-5LK5BZ2XDHMvcUJaf0CQ5HL3aVgKbpklvByC7qLSxYkfE8COEEbJg5xCHWCTqzqi0Gs4Jn5Mv5v3R38W6edscA=='],
    'range-parser': ['range-parser@1.3.0','',{},'sha512-hek2mFQpPuI4E1BBKrSto+BU3e3x4xuarsbiwr3+lf7p44juvFMV0XFWQAP3xUyqXA4RrXLIoaSUGbSt056ZMw=='],
    'raw-body': ['raw-body@3.0.2','',{dependencies:{bytes:'~3.1.2','http-errors':'~2.0.1','iconv-lite':'~0.7.0',unpipe:'~1.0.0'}},'sha512-K5zQjDllxWkf7Z5xJdV0/B0WTNqx6vxG70zJE4N0kBs4LovmEYWJzQGxC9bS9RAKu3bgM40lrd5zoLJ12MQ5BA=='],
    'require-from-string': ['require-from-string@2.0.2','',{},'sha512-Xf0nWe6RseziFMu+Ap9biiUbmplq6S9/p+7w7YXP/JBHhrUDDUhwa+vANyubuqfZWTveU//DYVGsDG7RKL/vEw=='],
    'router': ['router@2.2.0','',{dependencies:{debug:'^4.4.0',depd:'^2.0.0','is-promise':'^4.0.0',parseurl:'^1.3.3','path-to-regexp':'^8.0.0'}},'sha512-nLTrUKm2UyiL7rlhapu/Zl45FwNgkZGaCpZbIHajDYgwlJCOzLSk+cIPAnsEqV955GjILJnKbdQC1nVPz+gAYQ=='],
    'router/path-to-regexp': ['path-to-regexp@8.4.2','',{},'sha512-qRcuIdP69NPm4qbACK+aDogI5CBDMi1jKe0ry5rSQJz8JVLsC7jV8XpiJjGRLLol3N+R5ihGYcrPLTno6pAdBA=='],
    'send': ['send@1.2.1','',{dependencies:{debug:'^4.4.3',encodeurl:'^2.0.0','escape-html':'^1.0.3',etag:'^1.8.1',fresh:'^2.0.0','http-errors':'^2.0.1','mime-types':'^3.0.2',ms:'^2.1.3','on-finished':'^2.4.1','range-parser':'^1.2.1',statuses:'^2.0.2'}},'sha512-1gnZf7DFcoIcajTjTwjwuDjzuz4PPcY2StKPlsGAQ1+YH20IRVrBaXSWmdjowTJ6u8Rc01PoYOGHXfP1mYcZNQ=='],
    'serve-static': ['serve-static@2.2.1','',{dependencies:{encodeurl:'^2.0.0','escape-html':'^1.0.3',parseurl:'^1.3.3',send:'^1.2.0'}},'sha512-xRXBn0pPqQTVQiC8wyQrKs2MOlX24zQ0POGaj0kultvoOCstBQM5yvOhAVSUwOMjQtTvsPWoNCHfPGwaaQJhTw=='],
    'setprototypeof': ['setprototypeof@1.2.0','',{},'sha512-E5LDX7Wrp85Kil5bhZv46j8jOeboKq5JMmYM3gVGdGH8xFpPWXUMsNrlODCrkoxMEeNi/XZIwuRvY4XNwYMJpw=='],
    'statuses': ['statuses@2.0.2','',{},'sha512-DvEy55V3DB7uknRo+4iOGT5fP1slR8wQohVdknigZPMpMstaKJQWhwiYBACJE3Ul2pTnATihhBYnRhZQHGBiRw=='],
    'temml': ['temml@0.13.5','',{},'sha512-aPkDDgunanpLNL0ql32HbolqLep+w8DRcVXRql7rWrMt/PhczdLgL4UBYYVU3BYjCNjkGq4EqwIicu/zWr1iOg=='],
    'toidentifier': ['toidentifier@1.0.1','',{},'sha512-o5sSPKEkg/DIQNmH43V0/uerLrpzVedkUh8tGNvaeXpfpuwjKenlSox/2O/BTlZUtEe+JG7s5YhEz608PlAHRA=='],
    'type-is': ['type-is@2.1.0','',{dependencies:{'content-type':'^2.0.0','media-typer':'^1.1.0','mime-types':'^3.0.0'}},'sha512-faYHw0anBbc/kWF3zFTEnxSFOAGUX9GFbOBthvDdLsIlEoWOFOtS0zgCiQYwIskL9iGXZL3kAXD8OoZ4GmMATA=='],
    'type-is/content-type': ['content-type@2.1.0','',{},'sha512-mj7UPXE0jaqaOsukNZRUEfEi2AcL7C/vwmwcHV0O97eO1E1pxBZuyjlZrx5seTaNBg1U6+o35wpa35Qfcc+7ag=='],
    'unpipe': ['unpipe@1.0.0','',{},'sha512-pjy2bYhSsufwWlKwPc+l3cN7+wuJlK6uz0YdJEOlQDbl6jo/YlPi4mb8agUkVC8BF7V8NuzeyPNqRksA3hztKQ=='],
    'vary': ['vary@1.1.2','',{},'sha512-BNGbWLfd0eUPabhkXUVm0j8uuvREyTh5ovRa/dyow/BqAbZJyC+5fU+IzQOzmAKzYqYRAISoRhdQr3eIZ/PXqg=='],
    'wrappy': ['wrappy@1.0.2','',{},'sha512-l4Sp/DRseor9wL6EvV2+TuQn63dMkPjZ/sp9XkghTEbV9KlPS1xUsZ3u7/IQO4wxtcFB4bgpQPRcR3QCvezPcQ=='],
    'zod-to-json-schema': ['zod-to-json-schema@3.25.2','',{peerDependencies:{zod:'^3.25.28 || ^4'}},'sha512-O/PgfnpT1xKSDeQYSCfRI5Gy3hPf91mKVDuYLUHZJMiDFptvP41MSnWofm8dnCm0256ZNfZIM7DSzuSMAFnjHA=='],
  },
});
// Restore the reviewed old client edges only when every edge moves exactly.
function revertExtensionMove(before, after) {
  const from = before?.dependencies, to = after?.dependencies;
  if (!plain(from) || !plain(to)) return false;
  if (Object.entries(EXTENSION_MOVE.moved).some(([name, [old, next]]) => from[name] !== old || to[name] !== next)) return false;
  if (Object.entries(EXTENSION_MOVE.removed).some(([name, old]) => from[name] !== old || name in to)) return false;
  for (const [name, [old]] of Object.entries(EXTENSION_MOVE.moved)) to[name] = old;
  Object.assign(to, EXTENSION_MOVE.removed);
  return true;
}

// #927 drops the protocol version from the server description and declares
// the cloud-do test edge to client (its tests import client source).
const SERVER_DESCRIPTION = Object.freeze({
  from: 'BYOK SDK server: single-product, single-tenant embedded coordinator over @byok-sdk/cloud — wake-driven HTTP long-poll, protocol v2, memory or single-process SQLite storage.',
  to: 'BYOK SDK server: single-product, single-tenant embedded coordinator over @byok-sdk/cloud — wake-driven HTTP long-poll, memory or single-process SQLite storage.',
});
const CLOUD_DO_CLIENT_EDGE = '@byok-sdk/client';

const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// #793 D2 (owner O8): the private hosted (H) example. Its manifest has a fixed
// shape. It may only reuse workspaces and dependency specs that another
// workspace manifest already declares, so it adds no package and moves no version.
// #794 D3: the private Worker composition of H follows the same rule.
const HOSTED = Object.freeze({ dir: 'examples/hosted-bot-collaboration', name: '@byok-sdk/example-hosted-bot-collaboration' });
const HOSTED_WORKER = Object.freeze({ dir: 'examples/hosted-bot-collaboration-worker', name: '@byok-sdk/example-hosted-bot-collaboration-worker' });
const PRIVATE_HOSTED = Object.freeze([HOSTED, HOSTED_WORKER]);
const HOSTED_FIELDS = new Set(['name', 'version', 'private', 'type', 'description', 'scripts', 'dependencies', 'devDependencies']);
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'];
// #793 D2a-0: the K8 entries that the hosted example imports. There is no root
// entry, so H never loads the K8 host (src/host.ts). The K8 rules still import
// the K4 root, which loads HostLedger and node:sqlite.
const K8_HOSTED_EXPORTS = Object.freeze({
  './rules/commands': './src/rules/commands.ts',
  './rules/commit': './src/rules/commit.ts',
  './model': './src/model.ts',
  './coalesce': './src/coalesce.ts',
  './team': './src/team.ts',
  './test-support': './src/commit-vectors.test-support.ts',
});
// #884: the K4 entries before the I/O-free entry, and that entry. It exports only
// hash and canonical and imports only node:crypto, so K8 rules/ loads no ledger.
const K4_EXPORTS = Object.freeze({ '.': './src/index.ts', './test-support': './src/test-support.ts' });
const K4_CANONICAL_EXPORTS = Object.freeze({ './canonical': './src/canonical.ts' });
// #793 D2g: the K8 retention rule and its shared vectors, added to the hosted
// entries for H's retention slice (owner question §53d).
const K8_RETENTION_EXPORTS = Object.freeze({
  './retention': './src/retention.ts',
  './retention-vectors': './src/retention-vectors.test-support.ts',
});
// #793 D2f-1: the K8 Bot routine policy and its shared vectors, added to the
// hosted and retention entries. src/routines.ts does not load the K8 host.
const K8_ROUTINE_EXPORTS = Object.freeze({
  './routines': './src/routines.ts',
  './routine-vectors': './src/routine-vectors.test-support.ts',
});
// #793 D2b-out-1: the K8 channel and delivery rules and their shared vectors, added
// to the hosted, retention and routine entries (owner question §54b). They do not
// load the K8 host.
const K8_DELIVERY_EXPORTS = Object.freeze({
  './channel': './src/channel.ts',
  './delivery': './src/delivery.ts',
  './delivery-routing': './src/delivery-routing.ts',
  './delivery-vectors': './src/delivery-vectors.test-support.ts',
});
// #975 slice 2: the K8 owner switch format, added to the hosted, retention,
// routine and delivery entries. src/migration.ts has no I/O and does not load
// the K8 host.
const K8_MIGRATION_EXPORTS = Object.freeze({ './migration': './src/migration.ts' });
// #975 slice 5: the L side of the owner switch, added on top of the migration
// entry, so the H tests can import an H export into an L tenant
// (importForSwitch, commitImport). src/switch.ts loads the K4 root entry, and
// with it node:sqlite (ledger.ts) and node:async_hooks (core.ts); it does not
// load the K8 host. Only H tests import it; H's src does not.
const K8_SWITCH_EXPORTS = Object.freeze({ './switch': './src/switch.ts' });
/** The other workspace manifests, each with its dir. */
function otherWorkspaceManifests(cwd, self) {
  const manifests = [];
  for (const prefix of ['packages', 'examples']) {
    if (!existsSync(resolve(cwd, prefix))) continue;
    for (const name of readdirSync(resolve(cwd, prefix))) {
      const dir = `${prefix}/${name}`, file = resolve(cwd, dir, 'package.json');
      if (dir !== self && existsSync(file)) manifests.push({ dir, manifest: JSON.parse(readFileSync(file, 'utf8')) });
    }
  }
  return manifests;
}
function verifyHostedManifest(manifest, cwd, example) {
  if (!plain(manifest) || Object.keys(manifest).some(key => !HOSTED_FIELDS.has(key))
    || manifest.name !== example.name || manifest.private !== true || manifest.type !== 'module' || !version(manifest.version)
    || (manifest.description !== undefined && typeof manifest.description !== 'string')
    || !isDeepStrictEqual(manifest.scripts, { typecheck: 'tsc --noEmit', test: 'vitest run' })) {
    throw new Error('Reviewed CI mapping required: the hosted example manifest has an unreviewed shape');
  }
  const others = otherWorkspaceManifests(cwd, example.dir);
  // A third-party spec must come from a workspace outside the private hosted examples, so they cannot vouch for each other.
  const declaring = others.filter(other => !PRIVATE_HOSTED.some(hosted => hosted.dir === other.dir));
  for (const field of DEPENDENCY_FIELDS) {
    if (manifest[field] === undefined) continue;
    if (!plain(manifest[field])) throw new Error('Reviewed CI mapping required: the hosted example manifest has an unreviewed shape');
    for (const [name, spec] of Object.entries(manifest[field])) {
      const reused = name.startsWith('@byok-sdk/')
        ? spec === 'workspace:*' && others.some(other => other.manifest.name === name)
        : declaring.some(other => DEPENDENCY_FIELDS.some(declared => other.manifest[declared]?.[name] === spec));
      if (!reused) throw new Error(`Reviewed CI mapping required: the hosted example may only reuse a declared dependency spec (${name})`);
    }
  }
  return manifest;
}
/** Admits a private hosted example's own lock rows when they match its reviewed manifest. Every other lock byte stays compared. */
function admitHostedLock(before, after, cwd, example) {
  const entry = after.workspaces?.[example.dir];
  if (entry === undefined) return;
  const manifest = verifyHostedManifest(JSON.parse(readFileSync(resolve(cwd, example.dir, 'package.json'), 'utf8')), cwd, example);
  const expected = { name: manifest.name, version: manifest.version };
  for (const field of DEPENDENCY_FIELDS) if (manifest[field] !== undefined) expected[field] = manifest[field];
  const row = [`${example.name}@workspace:${example.dir}`];
  if (!isDeepStrictEqual(entry, expected) || !isDeepStrictEqual(after.packages?.[example.name], row)
    || (before.packages?.[example.name] !== undefined && !isDeepStrictEqual(before.packages[example.name], row))) {
    throw new Error('Reviewed CI mapping required: the hosted example lock rows differ from its manifest');
  }
  delete before.workspaces[example.dir]; delete after.workspaces[example.dir];
  if (before.packages) delete before.packages[example.name];
  delete after.packages[example.name];
}

/** Returns the workspaces whose suites must qualify a reviewed dependency move. */
export function verifyReviewedContent(path, { base, cwd = process.cwd() } = {}) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) throw new Error('Content-sensitive impact requires exact CI_BASE');
  const hosted = PRIVATE_HOSTED.find(example => path === `${example.dir}/package.json`);
  if (hosted) {
    // A new file has no base content, so the reviewed shape is the whole check.
    verifyHostedManifest(JSON.parse(readFileSync(resolve(cwd, path), 'utf8')), cwd, hosted);
    return [];
  }
  const beforeText = execFileSync('git', ['show', `${base}:${path}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const afterText = readFileSync(resolve(cwd, path), 'utf8');
  if (path === '.gitattributes') {
    // #603 pins both generated metadata and native build input bytes.
    // Admit only the reviewed additive LF rules, never unrelated attributes.
    const rule = 'packages/client/src/daemon/agent-memory-helper-release-pin.ts text eol=lf\n';
    const before = beforeText.replace(/\r\n/g, '\n');
    const after = afterText.replace(/\r\n/g, '\n');
    const nativeRules = 'packages/client/native/agent-memory-fs/*.go text eol=lf\n'
      + 'packages/client/native/agent-memory-fs/go.mod text eol=lf\n';
    const additions = [rule, nativeRules, rule + nativeRules];
    if (!additions.some(addition => after === before + addition
      && addition.trimEnd().split('\n').every(line => !before.split('\n').includes(line)))) {
      throw new Error('Reviewed CI mapping required: only the reviewed helper LF attributes may be added');
    }
    return [];
  }
  if (path === '.node-version') {
    // #702: every CI and release setup-node step reads this pin. Admit only one
    // exact X.Y.Z line: no range, alias, prefix, prerelease or second line.
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\n?$/.test(afterText)) {
      throw new Error('Reviewed CI mapping required: .node-version must hold one exact X.Y.Z version');
    }
    return [];
  }
  const parse = path === 'bun.lock' ? parseBunLock : JSON.parse;
  const qualify = [];
  const before = parse(beforeText), after = parse(afterText);
  if (path === 'bun.lock') {
    for (const example of PRIVATE_HOSTED) admitHostedLock(before, after, cwd, example);
    const piMoved = [];
    let oracleMoved = false;
    let extensionMoved = false;
    for (const [dir, record] of Object.entries(before.workspaces)) {
      if (dir === '') continue;
      const current = after.workspaces?.[dir];
      if (!current || !version(record.version) || !version(current.version)) throw new Error('Invalid workspace lock version');
      const manifest = JSON.parse(readFileSync(resolve(cwd, dir, 'package.json'), 'utf8'));
      if (current.version !== manifest.version) throw new Error('Lock version differs from workspace manifest');
      // #658 adds this existing workspace solely to the private mailbox fixture.
      // Normalize only that reviewed additive edge; all other lock bytes remain
      // subject to the deep comparison below (including resolved packages).
      if (dir === 'examples/bot-collaboration'
        && record.devDependencies?.['@byok-sdk/cloud'] === undefined
        && current.devDependencies?.['@byok-sdk/cloud'] === 'workspace:*'
        && manifest.private === true
        && manifest.devDependencies?.['@byok-sdk/cloud'] === 'workspace:*') {
        delete current.devDependencies['@byok-sdk/cloud'];
      }
      // #603 exposes the already resolved bundler to helper asset smoke tests.
      if (dir === 'packages/client'
        && record.devDependencies?.esbuild === undefined
        && current.devDependencies?.esbuild === '0.28.1'
        && manifest.devDependencies?.esbuild === '0.28.1') {
        delete current.devDependencies.esbuild;
      }
      if (dir === 'packages/cloud-do'
        && record.devDependencies?.[CLOUD_DO_CLIENT_EDGE] === undefined
        && current.devDependencies?.[CLOUD_DO_CLIENT_EDGE] === 'workspace:*'
        && manifest.devDependencies?.[CLOUD_DO_CLIENT_EDGE] === 'workspace:*') {
        delete current.devDependencies[CLOUD_DO_CLIENT_EDGE];
      }
      const undiciField = UNDICI_FIELDS[dir];
      if (undiciField && manifest[undiciField]?.undici === UNDICI_MOVE.to && revertUndiciMove(record, current, undiciField)) qualify.push(dir);
      if (dir === 'packages/protocol' && manifest.devDependencies?.['byok-protocol-previous'] === PROTOCOL_ORACLE.previous.to
        && revertProtocolOracleMove(record, current)) oracleMoved = true;
      const piField = PI_FIELDS[dir];
      if (piField && manifest[piField]?.['@earendil-works/pi-ai'] === PI_MOVE.to && revertPiMove(record, current, piField)) piMoved.push(dir);
      if (dir === 'packages/client' && manifest.dependencies?.['pi-web-access'] === EXTENSION_MOVE.moved['pi-web-access'][1]
        && revertExtensionMove(record, current)) extensionMoved = true;
      delete record.version; delete current.version;
    }
    // Both workspace pins and the resolved package move together, or nothing moves.
    if (qualify.length) {
      if (qualify.length !== Object.keys(UNDICI_FIELDS).length
        || !isDeepStrictEqual(before.packages?.undici, UNDICI_LOCK.from) || !isDeepStrictEqual(after.packages?.undici, UNDICI_LOCK.to)) {
        throw new Error('Reviewed CI mapping required: bun.lock must move both undici pins and the resolved undici entry together');
      }
      after.packages.undici = before.packages.undici;
    }
    // The workspace edges and both lock rows move together, or nothing moves.
    if (oracleMoved) {
      if (!isDeepStrictEqual(before.packages?.['byok-protocol-previous'], PROTOCOL_ORACLE_LOCK.previous.from)
        || !isDeepStrictEqual(after.packages?.['byok-protocol-previous'], PROTOCOL_ORACLE_LOCK.previous.to)
        || !isDeepStrictEqual(before.packages?.['byok-protocol-floor'], PROTOCOL_ORACLE_LOCK.floor)
        || after.packages?.['byok-protocol-floor'] !== undefined) {
        throw new Error('Reviewed CI mapping required: bun.lock must move the protocol oracle edges and both lock rows together');
      }
      after.packages['byok-protocol-previous'] = before.packages['byok-protocol-previous'];
      after.packages['byok-protocol-floor'] = before.packages['byok-protocol-floor'];
      qualify.push('packages/protocol');
    }
    // Every Pi pin, the overrides and the reviewed rows move together, or nothing moves.
    if (piMoved.length) {
      const rows = PI_PACKAGES.every(name => before.packages?.[name]?.[0] === `${name}@${PI_MOVE.from}` && isDeepStrictEqual(after.packages?.[name], PI_LOCK[name]))
        && PI_ADDED.every(name => before.packages?.[name] === undefined && isDeepStrictEqual(after.packages?.[name], PI_LOCK[name]));
      if (piMoved.length !== Object.keys(PI_FIELDS).length || !revertPiMove(before, after, 'overrides') || !rows) {
        throw new Error('Reviewed CI mapping required: bun.lock must move every Pi pin, the overrides and the reviewed Pi lock rows together');
      }
      for (const name of PI_PACKAGES) after.packages[name] = before.packages[name];
      for (const name of PI_ADDED) delete after.packages[name];
      qualify.push(...piMoved);
    }
    // The client edges, the changed rows and every added row move together, or nothing moves.
    if (extensionMoved) {
      const rows = Object.entries(EXTENSION_LOCK.changed).every(([name, { from, to }]) =>
        isDeepStrictEqual(before.packages?.[name], from) && isDeepStrictEqual(after.packages?.[name], to))
        && Object.entries(EXTENSION_LOCK.added).every(([name, row]) =>
          before.packages?.[name] === undefined && isDeepStrictEqual(after.packages?.[name], row));
      if (!rows) throw new Error('Reviewed CI mapping required: bun.lock must move the Pi extension pins and every reviewed extension lock row together');
      for (const name of Object.keys(EXTENSION_LOCK.changed)) after.packages[name] = before.packages[name];
      for (const name of Object.keys(EXTENSION_LOCK.added)) delete after.packages[name];
      qualify.push('packages/client');
    }
  } else if (path === 'examples/bot-collaboration/package.json') {
    if (before.private !== true || after.private !== true) throw new Error('The bot collaboration fixture must stay private');
    // #658: the private fixture cloud edge.
    if (before.devDependencies?.['@byok-sdk/cloud'] === undefined && after.devDependencies?.['@byok-sdk/cloud'] === 'workspace:*') {
      delete after.devDependencies['@byok-sdk/cloud'];
    }
    // #793 D2a-0: the K8 entries for the hosted example.
    if (before.exports === undefined && isDeepStrictEqual(after.exports, K8_HOSTED_EXPORTS)) delete after.exports;
    // #793 D2g: the retention entries, only on top of exactly the hosted entries.
    if (isDeepStrictEqual(before.exports, K8_HOSTED_EXPORTS) && isDeepStrictEqual(after.exports, { ...K8_HOSTED_EXPORTS, ...K8_RETENTION_EXPORTS })) {
      after.exports = before.exports;
    }
    // #793 D2f-1: the routine entries, only on top of exactly the hosted and retention entries.
    const retained = { ...K8_HOSTED_EXPORTS, ...K8_RETENTION_EXPORTS };
    if (isDeepStrictEqual(before.exports, retained) && isDeepStrictEqual(after.exports, { ...retained, ...K8_ROUTINE_EXPORTS })) {
      after.exports = before.exports;
    }
    // #793 D2b-out-1: the delivery entries, only on top of exactly the hosted, retention and routine entries.
    const routed = { ...retained, ...K8_ROUTINE_EXPORTS };
    if (isDeepStrictEqual(before.exports, routed) && isDeepStrictEqual(after.exports, { ...routed, ...K8_DELIVERY_EXPORTS })) {
      after.exports = before.exports;
    }
    // #975 slice 2: the migration entry, only on top of exactly the hosted, retention, routine and delivery entries.
    const delivered = { ...routed, ...K8_DELIVERY_EXPORTS };
    if (isDeepStrictEqual(before.exports, delivered) && isDeepStrictEqual(after.exports, { ...delivered, ...K8_MIGRATION_EXPORTS })) {
      after.exports = before.exports;
    }
    // #975 slice 5: the switch entry, only on top of exactly the entries up to and including the migration entry.
    const migrated = { ...delivered, ...K8_MIGRATION_EXPORTS };
    if (isDeepStrictEqual(before.exports, migrated) && isDeepStrictEqual(after.exports, { ...migrated, ...K8_SWITCH_EXPORTS })) {
      after.exports = before.exports;
    }
  } else if (path === 'examples/host-execution-core/package.json') {
    if (before.private !== true || after.private !== true) throw new Error('The host execution core example must stay private');
    // #884: only the ./canonical entry, only on top of exactly the existing entries.
    if (isDeepStrictEqual(before.exports, K4_EXPORTS) && isDeepStrictEqual(after.exports, { ...K4_EXPORTS, ...K4_CANONICAL_EXPORTS })) {
      after.exports = before.exports;
    }
  } else if (path === 'package.json') {
    // repo-harness owns its generated command scripts. Admit additions, removals
    // and edits whose old and new values both invoke repo-harness; every other
    // script and field stays in the deep comparison below.
    const harnessScript = value => typeof value === 'string' && value.startsWith('repo-harness ');
    for (const name of new Set([...Object.keys(before.scripts ?? {}), ...Object.keys(after.scripts ?? {})])) {
      const oldValue = before.scripts?.[name], newValue = after.scripts?.[name];
      if ((oldValue === undefined || harnessScript(oldValue)) && (newValue === undefined || harnessScript(newValue))) {
        delete before.scripts?.[name]; delete after.scripts?.[name];
      }
    }
    // #1102: the upgrade-manifest gate command, exactly.
    if (before.scripts?.['check:upgrade-manifest'] === undefined
      && after.scripts?.['check:upgrade-manifest'] === UPGRADE_MANIFEST_GATE) delete after.scripts['check:upgrade-manifest'];
    // #1094: admit only the exact additive setup-doc generator/check commands.
    for (const [name, command] of Object.entries({
      'docs:device-setup': 'node scripts/docs/device-setup.mjs --write',
      'check:device-setup': 'node scripts/docs/device-setup.mjs',
    })) {
      if (before.scripts?.[name] === undefined && after.scripts?.[name] === command) delete after.scripts[name];
    }
    const oldCommand = before.scripts?.['test:scripts'], newCommand = after.scripts?.['test:scripts'];
    const prefix = 'node --test --test-concurrency=1 ';
    if (!oldCommand?.startsWith(prefix) || !newCommand?.startsWith(prefix)) throw new Error('Unreviewed test command');
    const oldTests = oldCommand.slice(prefix.length).split(' '), newTests = newCommand.slice(prefix.length).split(' ');
    let index = 0;
    for (const test of newTests) {
      if (test === oldTests[index]) { index++; continue; }
      if (!(/^scripts\/ci\/[a-z0-9-]+\.test\.mjs$/.test(test) || test === UPGRADE_MANIFEST_TEST || test === 'scripts/architecture/dependency-graph.test.mjs' || test === 'scripts/docs/device-setup.test.mjs')
        || oldTests.includes(test) || !existsSync(resolve(cwd, test))) throw new Error('Only existing CI contract tests may be added');
    }
    if (index !== oldTests.length || new Set(newTests).size !== newTests.length) throw new Error('Existing tests must remain in order without duplicates');
    delete before.scripts['test:scripts']; delete after.scripts['test:scripts'];
    if (revertPiMove(before, after, 'overrides')) qualify.push(...Object.keys(PI_FIELDS));
  } else {
    if (!version(before.version) || !version(after.version)) throw new Error('Invalid package version');
    if (path === 'packages/client/package.json'
      && before.devDependencies?.esbuild === undefined
      && after.devDependencies?.esbuild === '0.28.1') {
      delete after.devDependencies.esbuild;
    }
    if (path === 'packages/client/package.json') {
      const key = '#byok-hermes-session';
      const entry = { types: './dist/adapters/hermes/hermes-session-runtime.d.ts', default: './dist/adapters/hermes/hermes-session-runtime.js' };
      if (before.imports?.[key] === undefined && isDeepStrictEqual(after.imports?.[key], entry)) delete after.imports[key];
      const smoke = ' && node scripts/check-hermes-session-entry.mjs';
      if (typeof before.scripts?.build === 'string' && after.scripts?.build === before.scripts.build + smoke) after.scripts.build = before.scripts.build;
      // #1102 ships the upgrade manifest in the client tarball: exactly one appended files entry.
      if (isDeepStrictEqual(before.files, CLIENT_FILES) && isDeepStrictEqual(after.files, [...CLIENT_FILES, 'upgrade-manifest.json'])) {
        after.files = before.files;
      }
      // #1094 ships the generated DaemonConfig schema beside the upgrade manifest: exactly one appended files entry.
      if (isDeepStrictEqual(before.files, [...CLIENT_FILES, 'upgrade-manifest.json'])
        && isDeepStrictEqual(after.files, [...CLIENT_FILES, 'upgrade-manifest.json', 'daemon-config.schema.json'])) {
        after.files = before.files;
      }
      // #635 adds the public transport-free test-double entry; its bundle is checked by check-adapters-entry.mjs.
      const testing = { types: './dist/testing/index.d.ts', import: './dist/testing/index.js' };
      if (before.exports?.['./testing'] === undefined && isDeepStrictEqual(after.exports?.['./testing'], testing)) delete after.exports['./testing'];
    }
    if (path === 'packages/keys/package.json') {
      // #636 adds one subpath for the generated pinned pi-ai catalog lookup.
      const key = './pi-catalog';
      const entry = { types: './dist/pi-catalog.d.ts', import: './dist/pi-catalog.js' };
      if (before.exports?.[key] === undefined && isDeepStrictEqual(after.exports?.[key], entry)) delete after.exports[key];
      // The browser-safe headless model-route subpath.
      const route = { types: './dist/model-route.d.ts', import: './dist/model-route.js' };
      if (before.exports?.['./model-route'] === undefined && isDeepStrictEqual(after.exports?.['./model-route'], route)) delete after.exports['./model-route'];
    }
    if (path === 'packages/core/package.json') {
      // #654 adds one subpath for sealed payload v1, so the root bundle does not grow.
      const key = './sealed-payload';
      const entry = { types: './dist/sealed-payload/index.d.ts', import: './dist/sealed-payload/index.js' };
      if (before.exports?.[key] === undefined && isDeepStrictEqual(after.exports?.[key], entry)) delete after.exports[key];
    }
    if (path === 'packages/server/package.json'
      && before.description === SERVER_DESCRIPTION.from && after.description === SERVER_DESCRIPTION.to) {
      after.description = before.description;
    }
    if (path === 'packages/cloud-do/package.json'
      && before.devDependencies?.[CLOUD_DO_CLIENT_EDGE] === undefined
      && after.devDependencies?.[CLOUD_DO_CLIENT_EDGE] === 'workspace:*') {
      delete after.devDependencies[CLOUD_DO_CLIENT_EDGE];
      qualify.push('packages/cloud-do');
    }
    // #702 raises the public Node floor with the Node 24.22.1 pin. Admit only
    // this exact engines.node edit in a public manifest. Any other engines value
    // or key, and any other field, still fails the comparison below.
    if (publicManifests.includes(path)
      && before.engines?.node === '>=24.15.0'
      && after.engines?.node === '>=24.22.1') {
      after.engines.node = before.engines.node;
    }
    const dir = path.slice(0, -'/package.json'.length);
    if (UNDICI_FIELDS[dir] && revertUndiciMove(before, after, UNDICI_FIELDS[dir])) qualify.push(dir);
    if (dir === 'packages/protocol' && revertProtocolOracleMove(before, after)) qualify.push(dir);
    if (dir === 'packages/client' && revertExtensionMove(before, after)) qualify.push(dir);
    if (PI_FIELDS[dir] && revertPiMove(before, after, PI_FIELDS[dir])) {
      qualify.push(dir);
      if (dir === 'packages/client') {
        if (before.byok?.piRuntimePin !== PI_MOVE.from || after.byok?.piRuntimePin !== PI_MOVE.to) {
          throw new Error('Reviewed CI mapping required: packages/client/package.json must move byok.piRuntimePin with the Pi pins');
        }
        after.byok.piRuntimePin = PI_MOVE.from;
      }
    }
    delete before.version; delete after.version;
  }
  if (!isDeepStrictEqual(before, after)) throw new Error(`Reviewed CI mapping required: ${path} changes more than the reviewed fields`);
  return qualify;
}

/** A `bin:<name>` entry belongs to the one workspace package whose manifest declares that bin. */
function binOwner(name, cwd) {
  const owners = readdirSync(resolve(cwd, 'packages')).filter(dir => {
    const manifest = resolve(cwd, 'packages', dir, 'package.json');
    return existsSync(manifest) && Object.hasOwn(JSON.parse(readFileSync(manifest, 'utf8')).bin ?? {}, name);
  });
  if (owners.length !== 1) throw new Error(`Reviewed CI mapping required: unmapped API entry bin:${name}`);
  return `packages/${owners[0]}`;
}

export function changedApiOwners({ base, cwd = process.cwd() } = {}) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) throw new Error('API impact requires exact CI_BASE');
  const before = JSON.parse(execFileSync('git', ['show', `${base}:api-surface/entries.json`], { cwd, encoding: 'utf8' }));
  const after = JSON.parse(readFileSync(resolve(cwd, 'api-surface/entries.json'), 'utf8'));
  const owners = new Set();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(before[key], after[key])) continue;
    const bin = /^bin:([a-z0-9-]+)$/.exec(key);
    if (bin) { owners.add(binOwner(bin[1], cwd)); continue; }
    const match = /^@byok-sdk\/([a-z-]+)(?:[/#]|$)/.exec(key);
    if (!match) throw new Error(`Reviewed CI mapping required: unmapped API entry ${key}`);
    owners.add(`packages/${match[1]}`);
  }
  return [...owners];
}
