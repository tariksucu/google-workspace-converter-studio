import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { loadAddOn } from '../tools/load.mjs';
import { MANIFEST } from './fakes.mjs';
import {
  AUDIENCE,
  SCOPE,
  button,
  cardOf,
  driveEvent,
  gmailEvent,
  item,
  notificationOf,
  render,
  world,
} from './harness.mjs';

/**
 * Google's granular consent (seen in a real account on 2026-11-23): the consent screen lists the
 * manifest's scopes as boxes, unticked, and the user may allow any of them. Every entry point asks
 * Google for what it uses before doing anything (`ScriptApp.requireScopes`, outside any try), so
 * Google shows its own "Authorization required" card and runs the same function again after the
 * user allows it. The fakes refuse each service call without its scope, as Google does.
 */

const G = SCOPE.gmail;
const CS = [SCOPE.fetch, SCOPE.openid, SCOPE.email];
const sha1 = (text) => createHash('sha1').update(text).digest('hex');
/** The scopes in the manifest's order (the order the add-on asks in). */
const ordered = (scopes) => MANIFEST.oauthScopes.filter((s) => scopes.includes(s));

/** A conversion made beforehand, with every permission granted: its result card's parameters. */
function converted(w, kind, params, inputs) {
  const event =
    kind === 'drive'
      ? driveEvent({ params, inputs })
      : gmailEvent({ messageId: params.messageId, params, inputs });
  const card = cardOf(
    w.click(kind === 'drive' ? 'onConvertDriveFile' : 'onConvertAttachment', event),
  );
  const first = card.sections[0].widgets
    .flatMap((x) => (x.kind === 'ButtonSet' ? x.buttons : [x]))
    .map((x) => x.onClickAction ?? x.composeAction?.[0] ?? x.button?.onClickAction)
    .find((a) => a?.parameters?.id);
  return first.parameters;
}

/**
 * Every entry point of the manifest and the cards: how it is called, what it needs, and what it
 * shows when it works. `user`: the user's properties (default: signed in). `setup`: work done
 * beforehand with every permission (a conversion), returning what the event needs.
 */
const CASES = [
  {
    name: 'onHomepage',
    label: 'in Gmail, signed in',
    trigger: true,
    event: () => gmailEvent(),
    needs: [G, ...CS],
    works: (r) => cardOf(r).name === 'home',
  },
  {
    name: 'onHomepage',
    label: 'in Gmail, signed out',
    user: {},
    trigger: true,
    event: () => gmailEvent(),
    needs: [G],
    works: (r) => cardOf(r).name === 'home',
  },
  {
    name: 'onHomepage',
    label: 'in Drive, signed in',
    trigger: true,
    event: () => driveEvent(),
    needs: CS,
    works: (r) => cardOf(r).name === 'home',
  },
  {
    name: 'onHomepage',
    label: 'in Drive, signed out',
    user: {},
    trigger: true,
    event: () => driveEvent(),
    needs: [],
    works: (r) => cardOf(r).name === 'home',
  },
  {
    name: 'onGmailMessageOpen',
    label: '',
    trigger: true,
    event: () => gmailEvent(),
    needs: [G],
    works: (r) => cardOf(r).name === 'message',
  },
  {
    name: 'onDriveItemsSelected',
    label: 'signed in',
    trigger: true,
    event: (w) => driveEvent({ selected: [item(w, 'heic')] }),
    needs: [SCOPE.selection, ...CS],
    works: (r) => cardOf(r).name === 'convert',
  },
  {
    name: 'onDriveItemsSelected',
    label: 'signed out',
    user: {},
    trigger: true,
    event: (w) => driveEvent({ selected: [item(w, 'heic')] }),
    needs: [SCOPE.selection],
    works: (r) => cardOf(r).name === 'home',
  },
  {
    name: 'onShowSettings',
    label: '(universal action)',
    event: () => gmailEvent(),
    needs: [G, ...CS],
    works: (r) => cardOf(r).name === 'home',
  },
  {
    name: 'onShowSettingsCard',
    label: '',
    event: () => gmailEvent(),
    needs: [G, ...CS],
    works: (r) => cardOf(r).name === 'home',
  },
  {
    name: 'onSignIn',
    label: 'in Gmail',
    user: {},
    event: () => gmailEvent(),
    needs: [G, ...CS],
    works: (r) => /^Signed in\./.test(notificationOf(r)),
  },
  {
    name: 'onSignIn',
    label: 'in Drive, beside a selected file',
    user: {},
    event: (w) => driveEvent({ selected: [item(w, 'heic')] }),
    needs: [SCOPE.selection, ...CS],
    works: (r) => cardOf(r).name === 'convert',
  },
  {
    name: 'onSignOut',
    label: '',
    event: () => gmailEvent(),
    needs: [G],
    works: (r) => notificationOf(r) === 'Signed out of Converter Studio.',
  },
  {
    name: 'onSaveSettings',
    label: '',
    event: () => gmailEvent({ inputs: { maxCredits: '5' } }),
    needs: [G, ...CS],
    works: (r) => notificationOf(r) === 'Settings saved.',
  },
  {
    name: 'onShowAttachments',
    label: '',
    event: () => gmailEvent(),
    needs: [G, SCOPE.message, ...CS],
    works: (r) => cardOf(r).name === 'attachments',
  },
  {
    name: 'onPickAttachment',
    label: '',
    event: () => gmailEvent({ params: { index: '0', hash: sha1('heic bytes') } }),
    needs: [G, SCOPE.message, ...CS],
    works: (r) => cardOf(r).name === 'convert',
  },
  {
    name: 'onConvertAttachment',
    label: '',
    event: () =>
      gmailEvent({ params: { index: '0', hash: sha1('heic bytes') }, inputs: { to: 'jpg' } }),
    needs: [G, SCOPE.message, ...CS],
    works: (r) => cardOf(r).name === 'result',
  },
  {
    name: 'onSaveToDrive',
    label: '',
    setup: (w) => converted(w, 'gmail', { index: '0', hash: sha1('heic bytes') }, { to: 'jpg' }),
    event: (w, params) => gmailEvent({ params }),
    needs: [G, SCOPE.driveFile, ...CS],
    works: (r) => notificationOf(r) === 'Saved to Google Drive: IMG_0001.jpg',
  },
  {
    name: 'onReplyWithResult',
    label: '(compose action)',
    setup: (w) => converted(w, 'gmail', { index: '0', hash: sha1('heic bytes') }, { to: 'jpg' }),
    event: (w, params) => gmailEvent({ params }),
    needs: [G, SCOPE.message, SCOPE.compose, ...CS],
    works: (r, w) =>
      render(r).kind === 'ComposeActionResponse' && w.gmail.drafts.at(-1).attachments.length === 1,
  },
  {
    name: 'onPickDriveFile',
    label: '',
    event: (w) =>
      driveEvent({ selected: [item(w, 'heic'), item(w, 'doc')], params: { fileId: 'doc' } }),
    needs: [SCOPE.selection, ...CS],
    works: (r) => cardOf(r).name === 'convert',
  },
  {
    name: 'onRequestFileAccess',
    label: '',
    event: (w) => driveEvent({ selected: [item(w, 'secret')], params: { fileId: 'secret' } }),
    needs: [SCOPE.selection],
    works: (r) => render(r).requestFileScope === 'secret',
  },
  {
    name: 'onConvertDriveFile',
    label: '',
    event: () => driveEvent({ params: { fileId: 'heic' }, inputs: { to: 'jpg' } }),
    needs: [SCOPE.driveFile, ...CS],
    works: (r) => cardOf(r).name === 'result',
  },
  {
    name: 'onSaveBesideOriginal',
    label: '',
    setup: (w) => converted(w, 'drive', { fileId: 'heic' }, { to: 'jpg' }),
    event: (w, params) => driveEvent({ params }),
    needs: [SCOPE.driveFile, ...CS],
    works: (r) => notificationOf(r) === 'Saved next to the original: beach.jpg',
  },
  {
    name: 'onCheckConversion',
    label: '',
    setup: (w) =>
      converted(w, 'gmail', { messageId: 'slow', index: '0', hash: sha1('mov') }, { to: 'mp4' }),
    event: (w, params) => gmailEvent({ messageId: 'slow', params }),
    needs: [G, ...CS],
    works: (r) => cardOf(r).name === 'result',
  },
  {
    name: 'onConfirmConversion',
    label: '',
    setup: (w) =>
      converted(w, 'gmail', { messageId: 'other', index: '0', hash: sha1('mov') }, { to: 'mp4' }),
    event: (w, params) => gmailEvent({ messageId: 'other', params }),
    needs: [G, ...CS],
    works: (r) => cardOf(r).name === 'result',
  },
];

/** A world for a case, after its setup: the call to make, and what it may not have changed. */
function prepare(c) {
  const w = world(c.user ? { user: c.user } : {});
  const params = c.setup ? c.setup(w) : undefined;
  w.consent.asked.length = 0;
  w.logs.length = 0;
  const call = () => w[c.trigger ? 'trigger' : 'click'](c.name, c.event(w, params));
  const snapshot = () =>
    JSON.stringify({
      requests: w.requests.length,
      drafts: w.gmail.drafts.length,
      files: Object.keys(w.drive.files).length,
      user: w.user.getProperties(),
      exchanges: w.api.state.exchanges.length,
    });
  return { w, call, snapshot };
}

const isStop = (w) => (error) => w.consent.stops.includes(error);

test('every function the manifest and the cards name is covered below', () => {
  const common = MANIFEST.addOns.common;
  const named = new Set([
    common.homepageTrigger.runFunction,
    ...common.universalActions.filter((a) => a.runFunction).map((a) => a.runFunction),
    ...MANIFEST.addOns.gmail.contextualTriggers.map((t) => t.onTriggerFunction),
    MANIFEST.addOns.drive.onItemsSelectedTrigger.runFunction,
  ]);
  const addOn = loadAddOn();
  // The cards' callbacks: every top-level `on…` function of the scripts.
  for (const name of Object.getOwnPropertyNames(addOn.context))
    if (/^on[A-Z]/.test(name) && typeof addOn.context[name] === 'function') named.add(name);
  assert.deepEqual([...named].sort(), [...new Set(CASES.map((c) => c.name))].sort());
});

for (const c of CASES) {
  const title = `${c.name}${c.label ? ' ' + c.label : ''}`;

  test(`${title}: asks Google first, for exactly what it uses`, () => {
    const { w, call } = prepare(c);
    const response = call();
    assert.ok(c.works(response, w), 'it works with every permission');
    const expected = ordered(c.needs);
    if (expected.length)
      assert.deepEqual(w.consent.asked[0], {
        mode: 'AuthMode.FULL',
        scopes: expected,
        missing: [],
      });
    else assert.equal(w.consent.asked.length, 0, 'nothing to ask for');
    assert.deepEqual(
      w.logs.filter(([level]) => level === 'error'),
      [],
    );
  });

  test(`${title}: works with only its own permissions`, () => {
    const { w, call } = prepare(c);
    w.consent.only(c.needs);
    const response = call();
    assert.ok(c.works(response, w));
    assert.equal(w.consent.stops.length, 0);
    assert.deepEqual(
      w.logs.filter(([level]) => level === 'error'),
      [],
    );
  });

  for (const scope of c.needs) {
    const short = scope.replace('https://www.googleapis.com/auth/', '');
    test(`${title}: without ${short}, Google's card before anything is done; after it, the same call works`, () => {
      const { w, call, snapshot } = prepare(c);
      w.consent.revoke(scope);
      const before = snapshot();
      assert.throws(call, isStop(w), "Google's own exception, never a message of ours");
      assert.deepEqual(w.consent.asked.at(-1).missing, [scope]);
      assert.equal(snapshot(), before, 'nothing sent, saved, drafted or changed');
      // The user allows it on Google's card; Google runs the same function again.
      w.consent.grant();
      assert.ok(c.works(call(), w));
    });
  }
}

/** The user withdraws `scope` right after the entry point's own check (or a check forgot it). */
function withdrawAfterCheck(w, scope) {
  const push = w.consent.asked.push.bind(w.consent.asked);
  w.consent.asked.push = (entry) => {
    w.consent.asked.push = push;
    const n = push(entry);
    w.consent.revoke(scope);
    return n;
  };
}

test('a permission gone after the check: Google is asked again, its exception passes every catch', () => {
  const cases = [
    // UrlFetchApp refuses (send) under the formats list, and under the home card's account.
    [SCOPE.fetch, 'click', 'onShowAttachments', () => gmailEvent()],
    [SCOPE.fetch, 'trigger', 'onHomepage', () => gmailEvent()],
    [
      SCOPE.fetch,
      'trigger',
      'onDriveItemsSelected',
      (w) => driveEvent({ selected: [item(w, 'heic')] }),
    ],
    // GmailApp refuses (openMessage).
    [SCOPE.message, 'click', 'onShowAttachments', () => gmailEvent()],
    // Drive refuses while saving (the app folder, then the file).
    [
      SCOPE.driveFile,
      'click',
      'onConvertDriveFile',
      () => driveEvent({ params: { fileId: 'heic' }, inputs: { to: 'jpg' } }),
    ],
  ];
  for (const [scope, kind, name, event] of cases) {
    const w = world();
    withdrawAfterCheck(w, scope);
    assert.throws(() => w[kind](name, event(w)), isStop(w), `${name} without ${scope}`);
    assert.ok(
      w.consent.looked.some((l) => l.missing.includes(scope)),
      'Apps Script was asked, not the exception text read',
    );
    assert.ok(!JSON.stringify(w.logs).includes('could not be reached'));
    w.consent.grant();
    assert.doesNotThrow(() => w[kind](name, event(w)));
  }
});

test('Drive refusing while saving, and Gmail refusing the reply draft: Google is asked again', () => {
  // Saving to Drive: the app folder is looked up and made through the Drive service.
  const w = world();
  const params = converted(w, 'gmail', { index: '0', hash: sha1('heic bytes') }, { to: 'jpg' });
  withdrawAfterCheck(w, SCOPE.driveFile);
  assert.throws(() => w.click('onSaveToDrive', gmailEvent({ params })), isStop(w));
  assert.equal(Object.values(w.drive.files).filter((f) => f.byApp).length, 0);
  // The reply draft: createDraftReply refuses; no draft "could not attach" is made instead.
  withdrawAfterCheck(w, SCOPE.compose);
  assert.throws(() => w.click('onReplyWithResult', gmailEvent({ params })), isStop(w));
  assert.equal(w.gmail.drafts.length, 0);
  w.consent.grant();
  assert.equal(
    render(w.click('onReplyWithResult', gmailEvent({ params }))).kind,
    'ComposeActionResponse',
  );
  assert.equal(w.gmail.drafts[0].attachments.length, 1);
});

test('the first real run: UrlFetchApp refused at sign-in is no longer "could not be reached"', () => {
  // A check that forgot the permission (as 1.1.0, which had none): only the second look is left.
  const w = world({ user: {} });
  withdrawAfterCheck(w, SCOPE.fetch);
  const started = w.clock.now;
  assert.throws(() => w.click('onSignIn', gmailEvent()), isStop(w));
  // At once: no retries, no sleeps (1.1.0 slept 3 s before saying "could not be reached").
  assert.equal(w.clock.now, started);
  // Google's exception is in the project's log, in the user's language, with the address only.
  const lines = w.logs.filter(([level]) => level === 'error').map(([, text]) => text);
  assert.deepEqual(lines, [
    'Converter Studio add-on: request not sent (POST https://converter.studio/api/v1/google-workspace/session, attempt 1): Exception: UrlFetchApp.fetch işlevini çağırma izniniz yok. Gerekli izinler: https://www.googleapis.com/auth/script.external_request',
  ]);
  assert.equal(w.user.getProperty('CS_SESSION'), null);
  w.consent.grant();
  assert.match(notificationOf(w.click('onSignIn', gmailEvent())), /^Signed in\./);
});

test('the identity token while renewing: without openid, Google asks for it (not "sign in again")', () => {
  const w = world();
  // Two minutes left: the next request renews the session first.
  w.user.setProperty(
    'CS_SESSION',
    JSON.stringify({ token: 'cvs_gws_old', expiresAt: w.clock.now + 2 * 60_000 }),
  );
  withdrawAfterCheck(w, SCOPE.openid);
  assert.throws(() => w.trigger('onHomepage', gmailEvent()), isStop(w));
  assert.equal(w.google.tokens, 0);
});

test('Google gives no identity token although openid is allowed: the add-on says so', () => {
  const w = world({ user: {} });
  w.google.granted = false;
  assert.equal(
    notificationOf(w.click('onSignIn', gmailEvent())),
    'Google did not give the add-on your sign-in. Open the add-on again and allow the permissions it asks for.',
  );
  assert.equal(w.consent.stops.length, 0);
});

test('a network failure is logged without tokens, then "could not be reached"', () => {
  const w = world();
  w.api.handler = (request) => {
    w.clock.now += 100;
    if (request.url.startsWith('https://converter.studio/api/')) throw { network: true };
    return null;
  };
  const response = w.click('onShowAttachments', gmailEvent());
  assert.equal(
    notificationOf(response),
    'Converter Studio could not be reached. Try again in a moment.',
  );
  const lines = w.logs.filter(([level]) => level === 'error').map(([, text]) => text);
  assert.deepEqual(lines, [
    'Converter Studio add-on: request not sent (GET https://converter.studio/api/v1/formats, attempt 1): Error: Exception: Address unavailable: https://converter.studio/api/v1/formats',
    'Converter Studio add-on: request not sent (GET https://converter.studio/api/v1/formats, attempt 2): Error: Exception: Address unavailable: https://converter.studio/api/v1/formats',
    'Converter Studio add-on: request not sent (GET https://converter.studio/api/v1/formats, attempt 3): Error: Exception: Address unavailable: https://converter.studio/api/v1/formats',
  ]);
  assert.equal(w.consent.looked.length, 3, 'Apps Script was asked each time: nothing missing');
  assert.equal(w.consent.stops.length, 0);
});

test('an upload link that fails is logged without its token', () => {
  const w = world();
  const handler = w.api.handler;
  w.api.handler = (request) => {
    if (request.method === 'PUT') throw { network: true };
    return handler(request);
  };
  const response = w.click(
    'onConvertAttachment',
    gmailEvent({ params: { index: '0', hash: sha1('heic bytes') }, inputs: { to: 'jpg' } }),
  );
  assert.equal(
    notificationOf(response),
    'The upload to Converter Studio did not arrive whole. Try again.',
  );
  const text = JSON.stringify(w.logs);
  assert.match(
    text,
    /request not sent \(PUT https:\/\/converter\.studio\/api\/v1\/uploads\/up\d+\?…, attempt 1\)/,
  );
  assert.ok(!text.includes('tok_'), 'no upload token in the log');
});

test("the sign-in's identity token as Apps Script gives it (no azp) signs in; one from another client does not", () => {
  const w = world({ user: {} });
  assert.match(notificationOf(w.click('onSignIn', gmailEvent())), /^Signed in\./);
  const [claims] = w.api.state.exchanges;
  assert.equal(claims.azp, undefined, 'no azp, as in the real account');
  assert.equal(claims.aud, AUDIENCE);
  assert.equal(claims.iss, 'https://accounts.google.com');
  assert.equal(claims.exp - claims.iat, 3600);
  // A token that names our client as azp works too; one that names another client is refused.
  w.user.deleteProperty('CS_SESSION');
  w.google.claims = { azp: AUDIENCE };
  assert.match(notificationOf(w.click('onSignIn', gmailEvent())), /^Signed in\./);
  w.user.deleteProperty('CS_SESSION');
  w.google.claims = { azp: '999-other.apps.googleusercontent.com' };
  assert.match(
    notificationOf(w.click('onSignIn', gmailEvent())),
    /^Signing in with Google didn't work/,
  );
  assert.equal(w.user.getProperty('CS_SESSION'), null);
});

test('without userinfo.email the token has no e-mail: Google is asked for it at sign-in', () => {
  const w = world({ user: {}, granted: MANIFEST.oauthScopes.filter((s) => s !== SCOPE.email) });
  assert.throws(() => w.click('onSignIn', gmailEvent()), isStop(w));
  assert.equal(w.api.state.exchanges.length, 0);
});

test('a Gmail-only user (Drive permissions unticked) signs in, converts and replies, never asked about Drive', () => {
  const w = world({
    user: {},
    granted: [G, SCOPE.message, SCOPE.compose, ...CS],
  });
  w.click('onSignIn', gmailEvent());
  const done = cardOf(
    w.click(
      'onConvertAttachment',
      gmailEvent({ params: { index: '0', hash: sha1('heic bytes') }, inputs: { to: 'jpg' } }),
    ),
  );
  const reply = button(done, 'Reply with the file attached');
  w.click('onReplyWithResult', gmailEvent({ params: reply.compose.parameters }));
  assert.equal(w.gmail.drafts.length, 1);
  assert.equal(w.consent.stops.length, 0);
  const asked = new Set(w.consent.asked.flatMap((a) => a.scopes));
  assert.ok(!asked.has(SCOPE.driveFile) && !asked.has(SCOPE.selection));
  // Saving to Drive is the click that asks for Drive.
  const save = button(done, 'Save to Google Drive');
  assert.throws(
    () => w.click('onSaveToDrive', gmailEvent({ params: save.action.parameters })),
    isStop(w),
  );
  assert.deepEqual(w.consent.asked.at(-1).missing, [SCOPE.driveFile]);
});
