import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SRC, loadAddOn, scriptFiles } from '../tools/load.mjs';
import { SCOPES, prefixProblems, scopeTable, validate } from '../tools/validate-manifest.mjs';
import { MANIFEST } from './fakes.mjs';

const functions = (() => {
  const addOn = loadAddOn();
  const out = new Set();
  for (const name of scriptFiles())
    for (const m of readFileSync(`${SRC}/${name}`, 'utf8').matchAll(
      /^function ([A-Za-z_$][\w$]*)\(/gm,
    ))
      if (addOn.get(`typeof ${m[1]}`) === 'function') out.add(m[1]);
  return out;
})();

test("the manifest passes the rules of Google's reference, with every named function present", () => {
  const { errors, warnings } = validate(MANIFEST, { functions });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('the scopes: per-message and per-file only, never full Gmail or Drive', () => {
  assert.deepEqual(
    scopeTable(MANIFEST).map((r) => [r.scope, r.class]),
    [
      ['gmail.addons.execute', 'not classed in Google docs'],
      ['gmail.addons.current.message.action', 'non-sensitive'],
      ['gmail.addons.current.action.compose', 'non-sensitive'],
      ['drive.addons.metadata.readonly', 'not classed in Google docs'],
      ['drive.file', 'non-sensitive'],
      ['script.external_request', 'sensitive'],
    ],
  );
  for (const broad of [
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/gmail.readonly',
  ]) {
    const { errors } = validate(
      { ...MANIFEST, oauthScopes: [...MANIFEST.oauthScopes, broad] },
      { functions },
    );
    assert.ok(
      errors.some((e) => e.includes('broader')),
      broad,
    );
  }
  assert.equal(
    Object.keys(SCOPES).length,
    MANIFEST.oauthScopes.length,
    'no scope is explained but unused',
  );
});

test('the validator catches what Google refuses', () => {
  const broken = structuredClone(MANIFEST);
  broken.addOns.common.homepageTrigger.runFunction = 'onNothing';
  broken.addOns.gmail.contextualTriggers.push({
    unconditional: {},
    onTriggerFunction: 'onGmailMessageOpen',
  });
  broken.addOns.common.universalActions.push({
    label: 'x',
    openLink: 'https://example.com/',
    runFunction: 'onShowSettings',
  });
  broken.urlFetchWhitelist.push('https://*.example.com/x');
  broken.oauthScopes = broken.oauthScopes.filter((s) => !s.endsWith('script.external_request'));
  const { errors } = validate(broken, { functions });
  assert.ok(errors.some((e) => e.includes('no function onNothing')));
  assert.ok(errors.some((e) => e.includes('exactly one trigger')));
  assert.ok(errors.some((e) => e.includes('one of them')));
  assert.ok(errors.some((e) => e.includes('no wildcards in UrlFetch')));
  assert.ok(errors.some((e) => e.includes('script.external_request')));
  assert.deepEqual(prefixProblems('https://converter.studio', { wildcard: false }), [
    'https://converter.studio: must be https:// with a non-empty path (https://example.com/)',
  ]);
  assert.deepEqual(prefixProblems('https://converter.studio/api/', { wildcard: false }), []);
});

test('links and fetches stay on Converter Studio and Drive', () => {
  assert.deepEqual(MANIFEST.urlFetchWhitelist, [
    'https://converter.studio/api/',
    'https://www.googleapis.com/drive/v3/files/',
  ]);
  assert.deepEqual(MANIFEST.addOns.common.openLinkUrlPrefixes, [
    'https://converter.studio/',
    'https://drive.google.com/',
  ]);
  // The name matches the OAuth consent screen and the listing ("Converter Studio").
  assert.equal(MANIFEST.addOns.common.name, 'Converter Studio');
});
