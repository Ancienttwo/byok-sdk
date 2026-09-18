// Loaded only after host usage, binding and all locale assets are verified.
import todoExtension from '../../vendor/rpiv-todo/2.8.0/index.js';
import { I18N_NAMESPACE } from '../../vendor/rpiv-todo/2.8.0/state/i18n-bridge.js';
import { registerLocalesFromDir } from '@juicesharp/rpiv-i18n/loader';

/**
 * @param {string} verifiedLocaleAnchor URL of the verified extension directory.
 * @returns {import('@earendil-works/pi-coding-agent').ExtensionFactory}
 */
export function createTodoExtension(verifiedLocaleAnchor) {
  registerLocalesFromDir(I18N_NAMESPACE, verifiedLocaleAnchor, { label: 'rpiv-todo' });
  return todoExtension;
}
