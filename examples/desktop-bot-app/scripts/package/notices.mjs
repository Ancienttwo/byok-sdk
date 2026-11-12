// The third-party notices file of the packaged app (#1923), written from the
// license gate's inventory (license-gate.mjs): for each package its name,
// version, declared license, the text of each license file, and a NOTICE file
// when it has one. A package without a license file needs a declared license
// whose standard text this script holds; otherwise the build fails.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The file name in the app's resources directory. */
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';

/** Electron's license and Chromium's notices, where electron-builder puts them (app-builder-lib retainElectronLicenseFiles); package-smoke.mjs checks them. */
export const ELECTRON_NOTICES = Object.freeze(['LICENSE.electron.txt', 'LICENSES.chromium.html']);

const RULE = '='.repeat(80);
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.-].*)?$/i;
const NOTICE_FILE = /^notice(?:\..*)?$/i;

// Standard texts (opensource.org) for the declared licenses of packages that publish no license file.
const HELD_TEXTS = {
  MIT: `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
  ISC: `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
};

/** The heading line of a package's section; package-smoke.mjs looks for it. */
export const noticeHeading = entry => `${entry.name}@${entry.version}`;

/** The heading line of the Host SEA's Node runtime section; package-smoke.mjs looks for it. */
export const nodeHeading = version => `Node.js ${version}`;

function authorOf(pkg) {
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  return typeof author === 'string' ? author : undefined;
}

/**
 * One section per inventoried package (`licenseInventory(...).packages`, `where` relative to `root`), the Host SEA's
 * Node runtime (`node`: `seaNodeLicense()`), then the first-party files of resources/host/ that need none; throws
 * naming each package that has no license text.
 */
export function noticesText({ root, packages, node, firstParty }) {
  const missing = [];
  const sections = packages.map(entry => {
    const dir = path.join(root, entry.where);
    const names = readdirSync(dir).sort();
    const read = name => `--- ${name} ---\n${readFileSync(path.join(dir, name), 'utf8').trimEnd()}`;
    const licenses = names.filter(name => LICENSE_FILE.test(name)).map(read);
    if (licenses.length === 0) {
      const held = HELD_TEXTS[entry.license];
      if (held === undefined) {
        missing.push(`${noticeHeading(entry)} ${JSON.stringify(entry.license ?? null)}`);
        return '';
      }
      const author = authorOf(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')));
      licenses.push(`--- ${entry.license} (the package publishes no license file; standard text) ---\n${author ? `Author (package.json): ${author}\n\n` : ''}${held}`);
    }
    return [RULE, noticeHeading(entry), `License: ${entry.license}`, RULE, ...licenses, ...names.filter(name => NOTICE_FILE.test(name)).map(read), ''].join('\n');
  });
  if (missing.length > 0) throw new Error(`Third-party notices: no license file and no held text for ${missing.join(', ')}`);
  const runtime = [RULE, nodeHeading(node.version), 'The runtime inside the Host executable (resources/host/). Its LICENSE includes the licenses of the code Node bundles.', RULE,
    `--- LICENSE ---\n${readFileSync(node.licenseFile, 'utf8').trimEnd()}`, ''].join('\n');
  const own = [RULE, 'First-party files in resources/host/ (this repository, no third-party notice):', RULE, ...[...firstParty].sort(), ''].join('\n');
  return `Third-party notices for the npm packages and the Node.js runtime this app ships. Electron and Chromium are covered by ${ELECTRON_NOTICES.join(' and ')}, which electron-builder ships beside the app executable (macOS: in Contents/Resources).\n\n${sections.join('\n')}\n${runtime}\n${own}`;
}
