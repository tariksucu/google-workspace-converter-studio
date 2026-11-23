import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAddOn } from '../tools/load.mjs';
import { ADA, AUDIENCE, SESSION, fakeApi } from './fake-api.mjs';
import {
  SCOPE,
  fakeBlob,
  fakeConsent,
  fakeIdToken,
  fakeProperties,
  fakeUrlFetch,
  fakeUtilities,
} from './fakes.mjs';

const BASE = 'https://converter.studio/api';

/**
 * CsApi with a fake UrlFetchApp in front of the fake API, signed in through CsSession (stored
 * session SESSION; renewals exchange an identity token for `google`); no other Apps Script service.
 */
function setup({ signedIn = true, google = ADA, partBytes, handler, budgetMs = 24000 } = {}) {
  const clock = { now: Date.UTC(2026, 10, 23, 9) };
  const api = fakeApi({ clock, partBytes });
  const net = fakeUrlFetch(handler ? (r) => handler(r, api) : api.handler);
  const addOn = loadAddOn();
  const utilities = fakeUtilities(clock);
  const user = fakeProperties(
    signedIn
      ? { CS_SESSION: JSON.stringify({ token: SESSION, expiresAt: clock.now + 3600_000 }) }
      : {},
  );
  const identityTokens = [];
  let client = null;
  const session = addOn.get('CsSession').create({
    user,
    identityToken: () => {
      const now = Math.floor(clock.now / 1000);
      const token = fakeIdToken({
        aud: AUDIENCE,
        sub: google.sub,
        email: google.email,
        email_verified: true,
        iat: now,
        exp: now + 3600,
      });
      identityTokens.push(token);
      return token;
    },
    exchange: (idToken) => client.exchange(idToken),
    now: () => clock.now,
  });
  client = addOn.get('CsApi').createClient({
    session,
    baseUrl: BASE,
    version: '1.0.0',
    urlFetch: net.urlFetch,
    newKey: () => utilities.getUuid(),
    now: () => clock.now,
    sleep: (ms) => utilities.sleep(ms),
    deadline: clock.now + budgetMs,
  });
  return { client, session, user, api, clock, requests: net.requests, addOn, identityTokens };
}

const storedToken = (user) => JSON.parse(user.getProperty('CS_SESSION')).token;

const blob = (text, name = null) => fakeBlob(Buffer.from(text), 'application/octet-stream', name);
const caught = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('did not throw');
};

test('the formats list needs no sign-in; every request names the add-on and its version', () => {
  const { client, requests } = setup({ signedIn: false });
  assert.equal(client.formats().formats.length, 67);
  assert.equal(requests[0].url, `${BASE}/v1/formats`);
  assert.equal(requests[0].headers['X-Converter-Studio-Client'], 'google-workspace/1.0.0');
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(caught(() => client.account()).code, 'notSignedIn');
  assert.equal(requests.length, 1, 'signed out, nothing else is sent');
});

test('signing in: the identity token goes once, without a session; the answer is kept', () => {
  const { session, user, requests, identityTokens, clock } = setup({
    signedIn: false,
    google: { sub: '2002', email: 'new@gmail.com' },
  });
  const started = session.signIn();
  assert.equal(started.newAccount, true);
  const [exchange] = requests;
  assert.equal(exchange.url, `${BASE}/v1/google-workspace/session`);
  assert.equal(exchange.method, 'POST');
  assert.equal(exchange.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(exchange.body), { idToken: identityTokens[0] });
  assert.deepEqual(JSON.parse(user.getProperty('CS_SESSION')), {
    token: started.token,
    expiresAt: clock.now + 3600_000,
  });
  // Again: the same account.
  assert.equal(session.signIn().newAccount, false);
});

test('a session about to end is renewed before the request, without a click', () => {
  // One client over the hour (each click has its own in the add-on).
  const { client, user, clock, requests, identityTokens } = setup({ budgetMs: 2 * 3600_000 });
  clock.now += 54 * 60_000;
  client.account();
  assert.equal(identityTokens.length, 0, 'six minutes left: kept');
  clock.now += 2 * 60_000;
  assert.equal(client.account().email, ADA.email);
  assert.equal(identityTokens.length, 1);
  const renewed = storedToken(user);
  assert.notEqual(renewed, SESSION);
  assert.deepEqual(
    requests.slice(-2).map((r) => [r.url.slice(BASE.length), r.headers.Authorization ?? null]),
    [
      ['/v1/google-workspace/session', null],
      ['/v1/account', `Bearer ${renewed}`],
    ],
  );
});

test('a refused session is renewed once and the request sent again: one conversion, one charge', () => {
  let ended = false;
  const { client, user, api, requests } = setup({
    // Converter Studio stops accepting the session just before the conversion starts.
    handler: (r, api) => {
      if (r.url.endsWith('/v1/conversions') && !ended) {
        ended = true;
        api.state.sessions.delete(SESSION);
      }
      return api.handler(r);
    },
  });
  const up = client.upload(blob('heic bytes'), 'IMG_0001.HEIC', 10);
  const view = client.start({ uploadId: up.id, to: 'jpg', maxCredits: 20 });
  assert.equal(view.status, 'queued');
  const starts = requests.filter((r) => r.url.endsWith('/v1/conversions'));
  assert.equal(starts.length, 2);
  assert.equal(starts[0].headers['Idempotency-Key'], starts[1].headers['Idempotency-Key']);
  assert.equal(starts[0].headers.Authorization, `Bearer ${SESSION}`);
  assert.equal(starts[1].headers.Authorization, `Bearer ${storedToken(user)}`);
  assert.equal(api.state.conversions.size, 1);
  assert.equal(api.state.exchanges.length, 1);
});

test('a renewal Converter Studio refuses is shown with its message, and not tried again', () => {
  const { client, api } = setup({ google: { sub: '3003', email: '' } });
  api.state.sessions.clear();
  const e = caught(() => client.account());
  assert.equal(e.code, 'googleSignInFailed');
  assert.equal(e.status, 401);
  assert.equal(
    e.message,
    "Signing in with Google didn't work. Please try again. If it keeps failing, sign in at converter.studio.",
  );
  assert.equal(api.state.exchanges.length, 1);
});

test('the sign-in switched off on the server, or no identity token from Google: said plainly', () => {
  const off = setup({ signedIn: false });
  off.api.state.signInOff = true;
  const e = caught(() => off.session.signIn());
  assert.equal(e.code, 'signInOff');
  assert.match(e.message, /not available right now/);

  const addOn = loadAddOn();
  const user = fakeProperties();
  const session = addOn.get('CsSession').create({
    user,
    identityToken: () => null,
    exchange: () => assert.fail('nothing to exchange'),
  });
  assert.equal(caught(() => session.signIn()).code, 'noIdentity');
  assert.equal(user.getProperty('CS_SESSION'), null);
});

test('a conversion: the session goes to the API only, never to the upload or download link', () => {
  const { client, requests } = setup();
  const up = client.upload(blob('heic bytes'), 'IMG_0001.HEIC', 10);
  assert.equal(up.format, 'heic');
  const view = client.settle(client.start({ uploadId: up.id, to: 'jpg', maxCredits: 20 }));
  assert.equal(view.status, 'done');
  assert.equal(view.outputName, 'IMG_0001.jpg');
  const result = client.download(view.downloadUrl);
  assert.equal(result.getDataAsString(), 'converted IMG_0001.HEIC to jpg');

  const [slot, put, start] = requests;
  assert.equal(slot.method, 'POST');
  assert.deepEqual(JSON.parse(slot.body), { fileName: 'IMG_0001.HEIC', size: 10 });
  assert.equal(slot.headers.Authorization, `Bearer ${SESSION}`);
  assert.equal(put.method, 'PUT');
  assert.equal(put.headers['Content-Type'], 'application/octet-stream');
  assert.equal(put.body.toString(), 'heic bytes');
  assert.equal(start.headers['Idempotency-Key'].length, 36);
  assert.deepEqual(JSON.parse(start.body), { uploadId: up.id, to: 'jpg', maxCredits: 20 });
  for (const r of requests) {
    assert.equal(r.headers['X-Converter-Studio-Client'], 'google-workspace/1.0.0');
    assert.equal(r.muteHttpExceptions, true);
    assert.equal(r.followRedirects, false);
    assert.ok(r.timeoutSeconds >= 1 && r.timeoutSeconds <= 24, `timeout ${r.timeoutSeconds}`);
    const keyed = r.url.includes('/uploads/') || r.url.includes('/download');
    if (keyed) assert.equal(r.headers.Authorization, undefined, r.url);
  }
  assert.ok(
    requests.some((r) => r.url.includes('?wait=')),
    'waits with ?wait=',
  );
});

test('a lost answer is sent again with the same Idempotency-Key: one conversion, one charge', () => {
  const { client, api, requests } = setup();
  const up = client.upload(blob('mov'), 'clip.mov', 3);
  api.state.failNext = 'POST /v1/conversions';
  const view = client.start({ uploadId: up.id, to: 'mp4', maxCredits: 20 });
  const starts = requests.filter((r) => r.url.endsWith('/v1/conversions'));
  assert.equal(starts.length, 2);
  assert.equal(starts[0].headers['Idempotency-Key'], starts[1].headers['Idempotency-Key']);
  assert.equal(api.state.conversions.size, 1);
  assert.equal(view.id, up.id);
});

test('a dropped upload is sent again; the API overwrites it', () => {
  const { client, api, requests } = setup();
  api.state.dropNext = 'PUT';
  client.upload(blob('pdf'), 'a.pdf', 3);
  assert.equal(requests.filter((r) => r.method === 'PUT').length, 2);
});

test('large files go in parts with Upload-Offset when the API asks for smaller requests', () => {
  const { client, requests } = setup({ partBytes: 4 });
  const up = client.upload(blob('0123456789'), 'notes.txt', 10);
  const puts = requests.filter((r) => r.method === 'PUT');
  assert.deepEqual(
    puts.map((p) => [p.headers['Upload-Offset'], p.body.toString()]),
    [
      ['0', '0123'],
      ['4', '4567'],
      ['8', '89'],
    ],
  );
  assert.equal(up.format, 'txt');
});

test("the API's own error message is shown: too large, failed conversion", () => {
  const { client } = setup();
  const big = caught(() => client.upload(blob('x'), 'film.mov', 60_000_000));
  assert.equal(big.code, 'sourceTooLarge');
  const plan = setup({
    handler: (r, api) =>
      r.url.endsWith('/v1/uploads')
        ? {
            status: 413,
            headers: {},
            body: {
              error: {
                code: 'fileTooLarge',
                message: 'This file is larger than 10 MB, the limit on your plan.',
              },
            },
          }
        : api.handler(r),
  });
  assert.equal(
    caught(() => plan.client.upload(blob('x'), 'a.pdf', 20_000_000)).message,
    'This file is larger than 10 MB, the limit on your plan.',
  );

  const up = client.upload(blob('docx'), 'broken.docx', 4);
  const failed = client.settle(client.start({ uploadId: up.id, to: 'pdf', maxCredits: 20 }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.message, 'This file is damaged and could not be read.');
});

test('a proxy error page (not JSON) is tried again, then reported in plain words', () => {
  const { client, requests } = setup({
    handler: () => ({
      status: 502,
      headers: { 'Content-Type': 'text/html' },
      body: '<html>Bad gateway</html>',
    }),
  });
  const e = caught(() => client.account());
  assert.equal(e.code, 'serverBusy');
  assert.equal(e.message, 'Converter Studio is busy; try again in a few minutes.');
  assert.equal(requests.length, 3);
});

test('links to another address are refused (upload slot, download)', () => {
  const { client } = setup({
    handler: (r, api) => {
      const res = api.handler(r);
      if (r.url.endsWith('/v1/uploads'))
        res.body.uploadUrl = 'https://evil.example/api/v1/uploads/x';
      return res;
    },
  });
  assert.equal(caught(() => client.upload(blob('x'), 'a.pdf', 1)).code, 'foreignLink');
  assert.equal(
    caught(() => client.download('https://converter.studio.evil.example/api/jobs/1/download')).code,
    'foreignLink',
  );
});

test('a slow conversion: the client stops waiting before the 30 seconds are up', () => {
  const { client, clock } = setup();
  const started = clock.now;
  const up = client.upload(blob('mov'), 'slow-video.mov', 3);
  const view = client.settle(client.start({ uploadId: up.id, to: 'mp4', maxCredits: 20 }));
  assert.equal(view.status, 'processing');
  assert.ok(clock.now - started <= 24000, `${clock.now - started} ms`);
  assert.ok(clock.now - started >= 15000, 'it did wait');
});

test('with no time left nothing is sent', () => {
  const { client, requests } = setup({ budgetMs: 1000 });
  assert.equal(caught(() => client.account()).code, 'outOfTime');
  assert.equal(requests.length, 0);
});

test('a conversion over the limit waits for a go-ahead, then runs', () => {
  const { client } = setup();
  const up = client.upload(blob('mov'), 'quote-long.mov', 3);
  const quoted = client.settle(client.start({ uploadId: up.id, to: 'mp4', maxCredits: 20 }));
  assert.equal(quoted.status, 'quoted');
  assert.equal(quoted.credits, 30);
  assert.equal(client.settle(client.confirm(quoted.id)).status, 'done');
});

test('UrlFetchApp refused for want of its permission: logged, Google asked, never "network"', () => {
  const clock = { now: Date.UTC(2026, 10, 23, 9) };
  const api = fakeApi({ clock });
  const consent = fakeConsent();
  consent.revoke(SCOPE.fetch);
  const addOn = loadAddOn();
  const Errors = addOn.get('CsErrors');
  const lines = [];
  const asked = [];
  let missing = true;
  const stop = new Error('Google ends the execution here');
  const client = addOn.get('CsApi').createClient({
    session: null,
    baseUrl: BASE,
    version: '1.1.1',
    urlFetch: fakeUrlFetch(api.handler, { consent }).urlFetch,
    newKey: () => 'k',
    now: () => clock.now,
    sleep: (ms) => (clock.now += ms),
    deadline: clock.now + 24000,
    checkPermission: (scopes) => {
      asked.push([...scopes]);
      if (missing) throw Errors.googleStop(stop);
    },
    log: (text) => lines.push(text),
  });
  assert.equal(
    caught(() => client.formats()),
    stop,
  );
  assert.deepEqual(asked, [[SCOPE.fetch]]);
  assert.deepEqual(lines, [
    `request not sent (GET ${BASE}/v1/formats, attempt 1): Exception: UrlFetchApp.fetch işlevini çağırma izniniz yok. Gerekli izinler: ${SCOPE.fetch}`,
  ]);
  // When Apps Script says nothing is missing, it is a network failure after all: tried again.
  missing = false;
  const e = caught(() => client.formats());
  assert.equal(e.code, 'network');
  assert.equal(e.message, 'Converter Studio could not be reached. Try again in a moment.');
  assert.equal(lines.length, 4);
});

test("Google's exception passes the catches it meets; the log never holds a token", () => {
  const Errors = loadAddOn().get('CsErrors');
  const stop = new Error('x');
  assert.equal(Errors.isGoogleStop(stop), false);
  assert.equal(Errors.googleStop(stop), stop);
  assert.equal(Errors.isGoogleStop(stop), true);
  assert.equal(
    caught(() => Errors.passGoogleStop(stop)),
    stop,
  );
  assert.doesNotThrow(() => Errors.passGoogleStop(new Error('other')));
  assert.equal(Errors.asCsError(new Error('internals')).message, 'Something went wrong.');

  const jwt = `${fakeIdToken({ sub: '1' })}`;
  const text = Errors.scrub(
    `GET https://converter.studio/api/v1/uploads/up1?token=tok_up1#x failed; Authorization: Bearer cvs_gws_${'a'.repeat(40)} ya29.a0AfH6SM-xyz ${jwt} cvs_live_${'b'.repeat(32)}`,
  );
  assert.equal(
    text,
    'GET https://converter.studio/api/v1/uploads/up1?… failed; Authorization: Bearer … ya29.… (token) cvs_…',
  );
  assert.equal(
    Errors.describe(
      Object.assign(new Error('boom https://x.example/a?key=1'), { name: 'Exception' }),
    ),
    'Exception: boom https://x.example/a?…',
  );
  assert.equal(Errors.describe('plain'), 'plain');
  assert.equal(Errors.describe(new Error('y'.repeat(5000))).length, 2000);
});

test('addresses: origins without the URL class Apps Script lacks', () => {
  const A = loadAddOn().get('CsApi');
  assert.equal(A.originOf('https://Converter.Studio:443/api/x?y'), 'https://converter.studio');
  assert.equal(A.originOf('http://localhost:8080/api'), 'http://localhost:8080');
  assert.equal(A.originOf('https://converter.studio@evil.example/'), null);
  assert.equal(A.originOf('javascript:alert(1)'), null);
  assert.equal(A.uploadName('a'.repeat(300) + '.pdf').length, 255);
  assert.ok(A.uploadName('a'.repeat(300) + '.pdf').endsWith('.pdf'));
  assert.equal(A.uploadName(' \n '), 'file');
});
