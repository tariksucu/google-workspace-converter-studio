/**
 * Loads the add-on's scripts (src/*.js) the way Apps Script does: every file into one shared
 * global scope, nothing else in it. The context starts with ECMAScript's own built-ins only, so a
 * script that used something Apps Script lacks (`URL`, `fetch`, `setTimeout`, `Buffer`,
 * `TextEncoder`, `require`…) fails here as it would there. Apps Script's services are passed in
 * (`globals`): fakes in the unit tests, a real HTTP shim for UrlFetchApp against the real API.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** The scripts in src/, in the order clasp pushes them (by name). */
export function scriptFiles() {
  return readdirSync(SRC)
    .filter((name) => name.endsWith('.js'))
    .sort();
}

/**
 * @param {Record<string, unknown>} [globals] Apps Script services and anything else the scripts
 *   may see (`console` is Apps Script's too).
 * @returns {{ context: object, get: (name: string) => any, call: (name: string, ...args: unknown[]) => any }}
 */
export function loadAddOn(globals = {}, { reverse = false } = {}) {
  const context = vm.createContext({ ...globals });
  const files = scriptFiles();
  // Apps Script's order of files is the project's; nothing may depend on it (test/package.test.mjs).
  if (reverse) files.reverse();
  for (const name of files) {
    const code = readFileSync(join(SRC, name), 'utf8');
    new vm.Script(code, { filename: join(SRC, name) }).runInContext(context);
  }
  /** A top-level name of the scripts (`const` names are not properties of the global object). */
  const get = (name) => new vm.Script(name).runInContext(context);
  return {
    context,
    get,
    call: (name, ...args) => get(name)(...args),
  };
}
