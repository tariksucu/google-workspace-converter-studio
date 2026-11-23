import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADA,
  SESSION,
  button,
  cardOf,
  driveEvent,
  gmailEvent,
  item,
  notificationOf,
  render,
  textOf,
  world,
} from './harness.mjs';

/** The add-on's requests to Converter Studio, as [path, Authorization]. */
const sent = (w) =>
  w.requests
    .filter((r) => r.url.startsWith('https://converter.studio/api/'))
    .map((r) => [
      r.url.slice('https://converter.studio/api'.length),
      r.headers.Authorization ?? null,
    ]);

test('Continue with Google beside an open message: a new free account, then the message card', () => {
  const w = world({ user: {} });
  w.google.account = { sub: '2002', email: 'new@gmail.com' };
  assert.equal(cardOf(w.trigger('onGmailMessageOpen', gmailEvent())).name, 'home');
  const response = w.click('onSignIn', gmailEvent());
  assert.equal(
    notificationOf(response),
    'Your free Converter Studio account is ready. Plan: guest · 13 credits left',
  );
  assert.equal(cardOf(response).name, 'message', 'carries on with the open message');
  const { token } = JSON.parse(w.user.getProperty('CS_SESSION'));
  assert.deepEqual(sent(w), [
    ['/v1/google-workspace/session', null],
    ['/v1/account', `Bearer ${token}`],
  ]);
  const [exchange] = w.requests;
  assert.equal(exchange.headers['X-Converter-Studio-Client'], 'google-workspace/1.1.2');
  assert.equal(w.api.state.exchanges[0].sub, '2002');
  assert.equal(w.api.state.accounts.get('2002').email, 'new@gmail.com');
});

test('an existing account signs in from the homepage, then signs out; nothing renews after', () => {
  const w = world({ user: { CS_MAX_CREDITS: '7' } });
  // The homepage's button: no message open.
  const homepage = {
    commonEventObject: { hostApp: 'GMAIL', platform: 'WEB', parameters: {}, formInputs: {} },
  };
  const response = w.click('onSignIn', homepage);
  assert.equal(notificationOf(response), 'Signed in. Plan: pro · 480 credits left');
  const home = cardOf(response);
  assert.equal(home.name, 'home');
  assert.equal(home.sections[1].widgets[0].topLabel, `Signed in as ${ADA.email}`);
  assert.equal(w.api.state.accounts.size, 1, 'no second account');

  const out = w.click('onSignOut', gmailEvent());
  assert.equal(notificationOf(out), 'Signed out of Converter Studio.');
  assert.equal(w.user.getProperty('CS_SESSION'), null);
  assert.equal(w.user.getProperty('CS_MAX_CREDITS'), '7', 'the settings stay');
  assert.ok(button(cardOf(out), 'Continue with Google'));

  const before = w.requests.length;
  const tokens = w.google.tokens;
  w.clock.now += 2 * 3600_000;
  assert.equal(cardOf(w.trigger('onGmailMessageOpen', gmailEvent())).name, 'home');
  const refused = w.click('onShowAttachments', gmailEvent());
  // Listing attachments needs only the formats; converting needs the sign-in.
  const pick = cardOf(refused).sections[0].widgets[0].button.onClickAction;
  const form = cardOf(w.click(pick.functionName, gmailEvent({ params: pick.parameters })));
  const go = button(form, 'Convert').action;
  const convert = w.click(
    go.functionName,
    gmailEvent({ params: go.parameters, inputs: { to: 'jpg' } }),
  );
  assert.equal(
    notificationOf(convert),
    'Sign in to Converter Studio with your Google account first.',
  );
  assert.equal(w.google.tokens, tokens, 'signed out: no identity token is used');
  assert.ok(
    w.requests.slice(before).every((r) => !r.headers.Authorization),
    'nothing signed in is sent',
  );
});

test('signing in from a selected Drive file carries on to its "Convert to" form', () => {
  const w = world({ user: {} });
  const selected = [item(w, 'heic')];
  assert.equal(cardOf(w.trigger('onDriveItemsSelected', driveEvent({ selected }))).name, 'home');
  const response = w.click('onSignIn', driveEvent({ selected }));
  assert.equal(cardOf(response).name, 'convert');
  assert.equal(cardOf(response).header.title, 'beach.heic');
});

test('the hour runs out between two clicks: the next click renews it unnoticed', () => {
  const w = world();
  w.clock.now += 59 * 60_000;
  const home = cardOf(w.trigger('onHomepage', gmailEvent()));
  assert.equal(home.sections[1].widgets[0].text, 'Plan: pro · 480 credits left');
  const { token } = JSON.parse(w.user.getProperty('CS_SESSION'));
  assert.notEqual(token, SESSION);
  assert.equal(w.google.tokens, 1);
  assert.deepEqual(sent(w), [
    ['/v1/google-workspace/session', null],
    ['/v1/account', `Bearer ${token}`],
  ]);
});

test('what can go wrong at sign-in is said plainly, and nothing is kept', () => {
  const w = world({ user: {} });
  // An account with this e-mail exists whose address was never verified.
  w.api.state.notLinked.add(ADA.email);
  assert.match(
    notificationOf(w.click('onSignIn', gmailEvent())),
    /already exists at converter\.studio, but the address isn't verified yet/,
  );
  w.api.state.notLinked.clear();
  // Google gives no identity token although `openid` is allowed (without it, Google is asked:
  // test/permissions.test.mjs).
  w.google.granted = false;
  assert.equal(
    notificationOf(w.click('onSignIn', gmailEvent())),
    'Google did not give the add-on your sign-in. Open the add-on again and allow the permissions it asks for.',
  );
  w.google.granted = true;
  // Converter Studio has the add-on's sign-in switched off.
  w.api.state.signInOff = true;
  assert.equal(
    notificationOf(w.click('onSignIn', gmailEvent())),
    'Signing in to Converter Studio from this add-on is not available right now. Try again later.',
  );
  assert.equal(w.user.getProperty('CS_SESSION'), null);
});

test('neither the identity token nor the session appears in a card, a notification or the log', () => {
  const w = world({ user: {} });
  const shown = [];
  shown.push(textOf(render(w.click('onSignIn', gmailEvent()))));
  shown.push(textOf(cardOf(w.trigger('onHomepage', gmailEvent()))));
  w.api.state.sessions.clear();
  w.api.state.signInOff = true;
  shown.push(textOf(cardOf(w.trigger('onHomepage', gmailEvent()))));
  const secrets = [
    JSON.parse(w.user.getProperty('CS_SESSION')).token,
    ...w.requests
      .filter((r) => r.url.endsWith('/v1/google-workspace/session'))
      .map((r) => JSON.parse(r.body).idToken),
  ];
  assert.equal(secrets.length, 3);
  for (const secret of secrets) {
    for (const text of shown) assert.ok(!text.includes(secret));
    assert.ok(!JSON.stringify(w.logs).includes(secret));
  }
});

test('the API key 1.0.0 kept is deleted from the user’s properties at the first click', () => {
  const w = world({ user: { CS_API_KEY: 'cvs_live_' + 'a'.repeat(32), CS_MAX_CREDITS: '7' } });
  assert.equal(cardOf(w.trigger('onHomepage', gmailEvent())).name, 'home');
  assert.equal(w.user.getProperty('CS_API_KEY'), null);
  assert.equal(w.user.getProperty('CS_MAX_CREDITS'), '7', 'the settings stay');
  assert.ok(
    w.requests.every((r) => !JSON.stringify(r).includes('cvs_live_')),
    'never sent anywhere',
  );
});

test('an account deleted since the sign-in is not made again by a renewal: the add-on signs out', () => {
  const w = world();
  // Deleted on converter.studio: the session no longer works.
  w.api.state.accounts.delete(ADA.sub);
  const response = w.click('onShowAttachments', gmailEvent());
  const pick = cardOf(response).sections[0].widgets[0].button.onClickAction;
  const form = cardOf(w.click(pick.functionName, gmailEvent({ params: pick.parameters })));
  const go = button(form, 'Convert').action;
  const convert = w.click(
    go.functionName,
    gmailEvent({ params: go.parameters, inputs: { to: 'jpg' } }),
  );
  assert.equal(
    notificationOf(convert),
    'Your Converter Studio account no longer exists, so the add-on signed out. Click Continue with Google to make a new free account.',
  );
  assert.equal(w.api.state.accounts.size, 0, 'no account made');
  const renewal = w.requests.filter((r) => r.url.endsWith('/v1/google-workspace/session'));
  assert.equal(renewal.length, 1);
  assert.equal(JSON.parse(renewal[0].body).signUp, false);
  assert.equal(w.user.getProperty('CS_SESSION'), null);
  // The next card asks; the click makes a new account.
  const home = cardOf(w.trigger('onHomepage', gmailEvent()));
  assert.ok(button(home, 'Continue with Google'));
  const again = w.click('onSignIn', gmailEvent());
  assert.match(notificationOf(again), /^Your free Converter Studio account is ready/);
  const signIn = w.requests.filter((r) => r.url.endsWith('/v1/google-workspace/session')).at(-1);
  assert.equal(JSON.parse(signIn.body).signUp, undefined, 'the click may make one');
});

test('the home card of a deleted account asks to sign in again', () => {
  const w = world();
  w.api.state.accounts.delete(ADA.sub);
  const home = cardOf(w.trigger('onHomepage', gmailEvent()));
  assert.ok(button(home, 'Continue with Google'));
  assert.equal(w.api.state.accounts.size, 0);
});
