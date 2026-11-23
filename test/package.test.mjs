import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { SRC, loadAddOn, scriptFiles } from '../tools/load.mjs';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('one version: package.json and the X-Converter-Studio-Client header', () => {
  const config = loadAddOn().get('CS_CONFIG');
  assert.equal(config.version, pkg.version);
  assert.equal(config.clientName, 'google-workspace');
  assert.match(read('CHANGELOG.md'), new RegExp(`## ${pkg.version.replace(/\./g, '\\.')}`));
});

test('the files load in any order, as Apps Script may load them', () => {
  const forward = loadAddOn();
  const backward = loadAddOn({}, { reverse: true });
  for (const name of [
    'CS_CONFIG',
    'CsApi',
    'CsCards',
    'CsDrive',
    'CsErrors',
    'CsFlow',
    'CsFormats',
    'CsGmail',
    'CsSession',
    'CsSettings',
    'CsViews',
    'onHomepage',
  ])
    assert.equal(typeof backward.get(name), typeof forward.get(name), name);
});

test('the scripts use only what Apps Script has', () => {
  for (const name of scriptFiles()) {
    const code = read(`src/${name}`).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    // No modules, no browser or Node APIs, no syntax newer than Apps Script's V8 is known to run.
    for (const [pattern, why] of [
      [/^\s*(import|export)\s/m, 'ES modules'],
      [/\brequire\(/, 'require'],
      [/\bnew URL\(|\bURLSearchParams\b/, 'URL class'],
      [/(^|[^.\w])fetch\(/, 'fetch'],
      [/\bsetTimeout\b|\bsetInterval\b/, 'timers'],
      [/\bBuffer\b|\bTextEncoder\b|\bTextDecoder\b|\bcrypto\./, 'Node or browser APIs'],
      [/\?\.|\?\?/, 'optional chaining or ??'],
      [/\bDriveApp\b/, 'DriveApp (drive.file works through the Drive API only)'],
    ])
      assert.doesNotMatch(code, pattern, `${name}: ${why}`);
  }
});

test('only Gmail.js, Cards.js and Main.js name Apps Script services; the rest gets them passed in', () => {
  const services =
    /\b(CardService|UrlFetchApp|GmailApp|PropertiesService|CacheService|ScriptApp|Utilities|LockService|Session)\b/;
  for (const name of [
    'Api.js',
    'Config.js',
    'Errors.js',
    'Flow.js',
    'Formats.js',
    'Session.js',
    'Settings.js',
    'Views.js',
    'Drive.js',
  ])
    assert.doesNotMatch(
      read(`src/${name}`).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
      services,
      name,
    );
});

test('the clasp project is src/: the manifest and the scripts, nothing else', () => {
  assert.deepEqual(readdirSync(SRC).sort(), ['appsscript.json', ...scriptFiles()].sort());
  const clasp = JSON.parse(read('.clasp.json.example'));
  assert.equal(clasp.rootDir, 'src');
  assert.equal(clasp.scriptId, 'PASTE_THE_SCRIPT_ID');
});

test('public files: MIT licence by Converter Studio, privacy link, repository fields', () => {
  assert.match(read('LICENSE'), /^MIT License/);
  assert.match(read('LICENSE'), /Copyright \(c\) 2026 Converter Studio/);
  const readme = read('README.md');
  assert.match(readme, /https:\/\/converter\.studio\/privacy/);
  assert.match(readme, /\[Converter Studio\]\(https:\/\/converter\.studio\)/);
  assert.equal(
    pkg.repository.url,
    'git+https://github.com/tariksucu/google-workspace-converter-studio.git',
  );
  assert.equal(
    pkg.bugs.url,
    'https://github.com/tariksucu/google-workspace-converter-studio/issues',
  );
  assert.equal(pkg.homepage, 'https://converter.studio');
  assert.equal(pkg.license, 'MIT');
});
