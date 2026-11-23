import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAddOn } from '../tools/load.mjs';
import { fakeProperties, stateOf } from './fakes.mjs';

const addOn = loadAddOn();
const S = addOn.get('CsSettings');
const Session = addOn.get('CsSession');
const code = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
};

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
  const user = fakeProperties({ CS_MAX_CREDITS: '5' });
  const script = fakeProperties({ CS_API_BASE_URL: 'http://localhost:8080/api' });
  assert.deepEqual(
    { ...S.read(user, script) },
    { maxCredits: 5, baseUrl: 'http://localhost:8080/api' },
  );
  assert.deepEqual(
    { ...S.read(fakeProperties({ CS_MAX_CREDITS: 'junk' }), fakeProperties()) },
    { maxCredits: 20, baseUrl: 'https://converter.studio/api' },
  );
});

test('saving keeps the limit when the field is left empty, refuses a bad one', () => {
  const user = fakeProperties({ CS_MAX_CREDITS: '7' });
  S.save(user, { maxCredits: '' });
  assert.equal(user.getProperty('CS_MAX_CREDITS'), '7');
  S.save(user, { maxCredits: '3' });
  assert.equal(user.getProperty('CS_MAX_CREDITS'), '3');
  assert.equal(
    code(() => S.save(user, { maxCredits: 'x' })),
    'badMaxCredits',
  );
});

/** A session over fake properties; `exchange` answers like the API. */
function session(initial = {}, clock = { now: 1_000_000 }) {
  const user = fakeProperties(initial);
  const exchanged = [];
  let n = 0;
  const s = Session.create({
    user,
    identityToken: () => 'id-token-' + n,
    exchange: (idToken) => {
      exchanged.push(idToken);
      n++;
      return { token: 'cvs_gws_' + n, expiresIn: 3600, newAccount: n === 1 };
    },
    now: () => clock.now,
  });
  return { s, user, exchanged, clock };
}

test('the session: kept while fresh, renewed in its last five minutes, gone after sign-out', () => {
  const { s, user, exchanged, clock } = session();
  assert.equal(s.signedIn(), false);
  assert.equal(s.token(), null, 'signed out: no silent sign-in');
  assert.deepEqual(exchanged, []);
  assert.deepEqual({ ...s.signIn() }, { token: 'cvs_gws_1', newAccount: true });
  assert.equal(s.signedIn(), true);
  clock.now += 55 * 60_000 - 1;
  assert.equal(s.token(), 'cvs_gws_1');
  clock.now += 1;
  assert.equal(s.token(), 'cvs_gws_2');
  assert.deepEqual(exchanged, ['id-token-0', 'id-token-1']);
  assert.equal(s.renew(), 'cvs_gws_3');
  user.setProperty('CS_DRIVE_FOLDER_ID', 'f1');
  s.signOut();
  assert.equal(s.renew(), null, 'signed out: nothing renewed');
  assert.deepEqual([...stateOf(user).map.keys()], ['CS_DRIVE_FOLDER_ID']);
});

test('a renewal that fails in the last minutes keeps the old session until it ends', () => {
  const clock = { now: 1_000_000 };
  const user = fakeProperties({
    CS_SESSION: JSON.stringify({ token: 'cvs_gws_old', expiresAt: clock.now + 60_000 }),
  });
  const s = Session.create({
    user,
    identityToken: () => 'id-token',
    exchange: () => {
      throw new (addOn.get('CsErrors').CsError)('network');
    },
    now: () => clock.now,
  });
  assert.equal(s.token(), 'cvs_gws_old');
  clock.now += 60_000;
  assert.equal(
    code(() => s.token()),
    'network',
  );
});

test('a stored session that is not one reads as signed out', () => {
  for (const raw of ['{', '"x"', '{"token":1}', '{"token":"a"}'])
    assert.equal(session({ CS_SESSION: raw }).s.signedIn(), false, raw);
});
