import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAddOn } from '../tools/load.mjs';
import { VALID_KEY, fakeApi } from './fake-api.mjs';
import { fakeBlob, fakeUrlFetch, fakeUtilities } from './fakes.mjs';

const BASE = 'https://converter.studio/api';

/** CsApi with a fake UrlFetchApp in front of the fake API; no other Apps Script service. */
function setup({ apiKey = VALID_KEY, partBytes, handler, budgetMs = 24000 } = {}) {
  const clock = { now: Date.UTC(2026, 10, 23, 9) };
  const api = fakeApi({ clock, partBytes });
  const net = fakeUrlFetch(handler ? (r) => handler(r, api) : api.handler);
  const addOn = loadAddOn();
  const utilities = fakeUtilities(clock);
  const client = addOn.get('CsApi').createClient({
    apiKey,
    baseUrl: BASE,
    version: '1.0.0',
    urlFetch: net.urlFetch,
    newKey: () => utilities.getUuid(),
    now: () => clock.now,
    sleep: (ms) => utilities.sleep(ms),
    deadline: clock.now + budgetMs,
  });
  return { client, api, clock, requests: net.requests, addOn };
}

const blob = (text, name = null) => fakeBlob(Buffer.from(text), 'application/octet-stream', name);
const caught = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('did not throw');
};

test('the formats list needs no key; every request names the add-on and its version', () => {
  const { client, requests } = setup({ apiKey: null });
  assert.equal(client.formats().formats.length, 67);
  assert.equal(requests[0].url, `${BASE}/v1/formats`);
  assert.equal(requests[0].headers['X-Converter-Studio-Client'], 'google-workspace/1.0.0');
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(caught(() => client.account()).code, 'notConfigured');
});

test('a conversion: the key goes to the API only, never to the upload or download link', () => {
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
  assert.equal(slot.headers.Authorization, `Bearer ${VALID_KEY}`);
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

test("the API's own error message is shown: wrong key, too large, failed conversion", () => {
  const wrong = setup({ apiKey: 'cvs_live_' + 'z'.repeat(32) });
  const e = caught(() => wrong.client.account());
  assert.equal(e.code, 'invalidApiKey');
  assert.equal(e.status, 401);
  assert.equal(
    e.message,
    'This API key does not work. Create one on your account page at converter.studio.',
  );
  assert.ok(!e.message.includes('cvs_live_'));

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
