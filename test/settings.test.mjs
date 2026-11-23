import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAddOn } from '../tools/load.mjs';
import { VALID_KEY } from './fake-api.mjs';
import { fakeProperties, stateOf } from './fakes.mjs';

const addOn = loadAddOn();
const S = addOn.get('CsSettings');
const code = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
};

test('a pasted key is trimmed of spaces, quotes and "Bearer"; anything else is refused', () => {
  assert.equal(S.normaliseKey(`  ${VALID_KEY}\n`), VALID_KEY);
  assert.equal(S.normaliseKey(`"${VALID_KEY}"`), VALID_KEY);
  assert.equal(S.normaliseKey(`Bearer ${VALID_KEY}`), VALID_KEY);
  assert.equal(
    code(() => S.normaliseKey('cvs_live_short')),
    'badKey',
  );
  assert.equal(
    code(() => S.normaliseKey('sk-live-' + 'x'.repeat(32))),
    'badKey',
  );
  assert.equal(
    code(() => S.normaliseKey('')),
    'badKey',
  );
});

test('the key is shown masked, never whole', () => {
  assert.equal(S.maskKey(VALID_KEY), 'cvs_live_…O5p6');
  assert.equal(S.maskKey(null), '');
});

test('the credit limit is a whole number from 0 to 1000', () => {
  assert.equal(S.parseMaxCredits('20'), 20);
  assert.equal(S.parseMaxCredits(' 0 '), 0);
  assert.equal(S.parseMaxCredits('1000'), 1000);
  for (const bad of ['-1', '1.5', '1001', 'ten', ''])
    assert.equal(
      code(() => S.parseMaxCredits(bad)),
      'badMaxCredits',
    );
});

test('the API address: https, or a test server on this computer', () => {
  assert.equal(S.checkBaseUrl('https://converter.studio/api/'), 'https://converter.studio/api');
  assert.equal(S.checkBaseUrl('http://localhost:8080/api'), 'http://localhost:8080/api');
  assert.equal(S.checkBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  for (const bad of [
    'http://converter.studio/api',
    'ftp://x/api',
    'https://user:pw@x/api',
    'javascript:alert(1)',
  ])
    assert.equal(
      code(() => S.checkBaseUrl(bad)),
      'badBaseUrl',
    );
});

test('settings are read from the user’s properties, the address from the project’s', () => {
  const user = fakeProperties({ CS_API_KEY: VALID_KEY, CS_MAX_CREDITS: '5' });
  const script = fakeProperties({ CS_API_BASE_URL: 'http://localhost:8080/api' });
  assert.deepEqual(
    { ...S.read(user, script) },
    { apiKey: VALID_KEY, maxCredits: 5, baseUrl: 'http://localhost:8080/api' },
  );
  assert.deepEqual(
    { ...S.read(fakeProperties({ CS_MAX_CREDITS: 'junk' }), fakeProperties()) },
    { apiKey: null, maxCredits: 20, baseUrl: 'https://converter.studio/api' },
  );
});

test('saving keeps the old key when the field is left empty; forgetting deletes only the key', () => {
  const user = fakeProperties({ CS_API_KEY: VALID_KEY, CS_DRIVE_FOLDER_ID: 'f1' });
  S.save(user, { apiKey: '', maxCredits: '7' });
  assert.equal(user.getProperty('CS_API_KEY'), VALID_KEY);
  assert.equal(user.getProperty('CS_MAX_CREDITS'), '7');
  assert.equal(
    code(() => S.save(user, { apiKey: 'nope', maxCredits: '7' })),
    'badKey',
  );
  assert.equal(
    code(() => S.save(user, { apiKey: '', maxCredits: 'x' })),
    'badMaxCredits',
  );
  S.forget(user);
  assert.equal(user.getProperty('CS_API_KEY'), null);
  assert.equal(user.getProperty('CS_DRIVE_FOLDER_ID'), 'f1');
  assert.deepEqual([...stateOf(user).map.keys()].sort(), ['CS_DRIVE_FOLDER_ID', 'CS_MAX_CREDITS']);
});
