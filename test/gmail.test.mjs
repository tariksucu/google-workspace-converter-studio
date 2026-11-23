import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actionNames,
  button,
  buttons,
  cardOf,
  gmailEvent,
  notificationOf,
  render,
  textOf,
  world,
} from './harness.mjs';
import { fakeBlob, fakeCardService, fakeGmail } from './fakes.mjs';

/** Clicks a card's button the way Gmail does: its function, with its parameters. */
function press(w, card, text, extra = {}) {
  const b = button(card, text);
  const action = b.action ?? b.compose;
  return w.click(action.functionName, gmailEvent({ params: action.parameters, ...extra }));
}

test('signed out, the homepage and an open message offer "Continue with Google" and the terms', () => {
  const w = world({ user: {} });
  const home = cardOf(w.trigger('onHomepage', gmailEvent()));
  assert.equal(home.name, 'home');
  assert.deepEqual(
    buttons(home).map((b) => b.text),
    ['Continue with Google', 'Privacy policy', 'Help'],
  );
  const signIn = home.sections[1].widgets[1];
  assert.equal(signIn.text, 'Continue with Google');
  assert.equal(signIn.textButtonStyle, 'TextButtonStyle.OUTLINED');
  assert.match(signIn.iconUrl, /^https:\/\/www\.gstatic\.com\/.*googleg_standard_color/);
  assert.equal(signIn.onClickAction.functionName, 'onSignIn');
  // The site's own sign-up words, with its terms and privacy pages.
  assert.match(
    home.sections[1].widgets[2].text,
    /By creating an account, you agree to the <a href="https:\/\/converter\.studio\/terms">Terms of Service<\/a> and the <a href="https:\/\/converter\.studio\/privacy">Privacy policy<\/a>\./,
  );
  assert.ok(!/API key|cvs_live_/.test(textOf(home)), 'no API key anywhere');
  const opened = cardOf(w.trigger('onGmailMessageOpen', gmailEvent()));
  assert.equal(opened.name, 'home');
  assert.equal(w.requests.length, 0, 'nothing is sent before signing in');
  assert.equal(w.google.tokens, 0, 'no identity token is taken before the click');
});

test('signed in, the settings show the account: e-mail, plan and credits; the limit is saved', () => {
  const w = world();
  const home = cardOf(w.trigger('onHomepage', gmailEvent()));
  const account = home.sections[1].widgets[0];
  assert.equal(account.topLabel, 'Signed in as reader@example.com');
  assert.equal(account.text, 'Plan: pro · 480 credits left');
  assert.deepEqual(
    buttons(home).map((b) => b.text),
    ['Save', 'Sign out', 'Your account', 'Pricing', 'Privacy policy', 'Help'],
  );
  assert.match(
    home.sections[1].widgets[4].text,
    /<a href="https:\/\/myaccount\.google\.com\/connections">third-party connections<\/a>/,
  );
  const saved = w.click('onSaveSettings', gmailEvent({ inputs: { maxCredits: '5' } }));
  assert.equal(notificationOf(saved), 'Settings saved.');
  assert.equal(w.user.getProperty('CS_MAX_CREDITS'), '5');
  const bad = w.click('onSaveSettings', gmailEvent({ inputs: { maxCredits: 'lots' } }));
  assert.equal(notificationOf(bad), 'The credit limit must be a whole number from 0 to 1000.');
});

test('opening a message reads nothing; the click lists its attachments', () => {
  const w = world();
  const card = cardOf(w.trigger('onGmailMessageOpen', gmailEvent()));
  assert.equal(card.name, 'message');
  assert.equal(w.requests.length, 0);

  const list = cardOf(press(w, card, 'Show attachments'));
  assert.equal(list.name, 'attachments');
  const rows = list.sections[0].widgets;
  assert.deepEqual(
    rows.map((r) => [r.text, r.topLabel, r.bottomLabel ?? null, r.button ? r.button.text : null]),
    [
      ['IMG_0001.HEIC', 'HEIC · 10 bytes', null, 'Convert'],
      ['scan.pdf', 'PDF · 12 bytes', null, 'Convert'],
      ['notes.xyz', '1 bytes', 'Converter Studio does not read this kind of file.', null],
    ],
    'the inline logo is left out',
  );
  // Only the public formats list was fetched, without the key.
  assert.deepEqual(
    w.requests.map((r) => r.url),
    ['https://converter.studio/api/v1/formats'],
  );
});

test('a HEIC photo to JPG: download, save to Drive, reply with it attached', () => {
  const w = world();
  const list = cardOf(
    press(w, cardOf(w.trigger('onGmailMessageOpen', gmailEvent())), 'Show attachments'),
  );
  // The first "Convert" is the photo's (the list has one per convertible attachment).
  const pick = buttons(list)[0];
  const form = cardOf(
    w.click(pick.action.functionName, gmailEvent({ params: pick.action.parameters })),
  );
  assert.equal(form.name, 'convert');
  assert.equal(form.header.title, 'IMG_0001.HEIC');
  const dropdown = form.sections[0].widgets[0];
  assert.equal(dropdown.fieldName, 'to');
  assert.deepEqual(dropdown.items[0], ['JPG', 'jpg', true]);
  assert.ok(!textOf(form).includes('Recognise text'), 'no OCR choice for a photo');

  const convert = button(form, 'Convert');
  const done = cardOf(
    w.click(
      convert.action.functionName,
      gmailEvent({ params: convert.action.parameters, inputs: { to: 'jpg' } }),
    ),
  );
  assert.equal(done.name, 'result');
  assert.match(textOf(done), /IMG_0001\.jpg/);
  assert.match(textOf(done), /1 credit/);
  const download = button(done, 'Download');
  assert.match(download.openLink, /^https:\/\/converter\.studio\/api\/jobs\/.+\/download\?token=/);
  assert.ok(button(done, 'Save to Google Drive'));
  const reply = button(done, 'Reply with the file attached');
  assert.equal(reply.compose.functionName, 'onReplyWithResult');

  // The conversion request: the attachment's bytes, the client header, maxCredits from settings.
  const put = w.requests.find((r) => r.method === 'PUT');
  assert.equal(put.body.toString(), 'heic bytes');
  const start = w.requests.find((r) => r.url.endsWith('/v1/conversions'));
  assert.deepEqual(JSON.parse(start.body), {
    uploadId: JSON.parse(start.body).uploadId,
    to: 'jpg',
    maxCredits: 20,
  });

  // Save to Drive: into a "Converter Studio" folder made once, then reused.
  const saved = w.click(
    'onSaveToDrive',
    gmailEvent({ params: button(done, 'Save to Google Drive').action.parameters }),
  );
  assert.equal(notificationOf(saved), 'Saved to Google Drive: IMG_0001.jpg');
  const folder = Object.values(w.drive.files).find((f) => f.name === 'Converter Studio');
  assert.equal(folder.mimeType, 'application/vnd.google-apps.folder');
  assert.deepEqual(folder.parents, ['root']);
  const file = Object.values(w.drive.files).find((f) => f.name === 'IMG_0001.jpg');
  assert.deepEqual(file.parents, [folder.id]);
  assert.equal(file.bytes.toString(), 'converted IMG_0001.HEIC to jpg');
  assert.match(textOf(cardOf(saved)), /Saved in My Drive › Converter Studio/);
  w.click(
    'onSaveToDrive',
    gmailEvent({ params: button(done, 'Save to Google Drive').action.parameters }),
  );
  assert.equal(Object.values(w.drive.files).filter((f) => f.name === 'Converter Studio').length, 1);

  // Reply: a draft reply to this message with the converted file attached.
  const composed = render(
    w.click('onReplyWithResult', gmailEvent({ params: reply.compose.parameters })),
  );
  assert.equal(composed.kind, 'ComposeActionResponse');
  assert.equal(w.gmail.drafts.length, 1);
  assert.equal(w.gmail.drafts[0].replyTo, 'm1');
  assert.equal(w.gmail.drafts[0].attachments[0].name, 'IMG_0001.jpg');
  assert.equal(w.gmail.drafts[0].attachments[0].bytes.toString(), 'converted IMG_0001.HEIC to jpg');
  assert.deepEqual(composed.replyBox.attachments, ['IMG_0001.jpg'], 'Gmail shows the file');

  // No key on links that carry their own token.
  for (const r of w.requests.filter((x) => x.url.includes('/download') || x.method === 'PUT'))
    assert.equal(r.headers.Authorization, undefined);
  // One line about the reply draft for the project's log (what was attached): the count, the size
  // and the media type, never a file name or an address.
  assert.deepEqual(w.logs, [
    [
      'log',
      'Converter Studio add-on: reply draft made with 1 attachment, 30 bytes, application/octet-stream',
    ],
  ]);
});

test('the reply draft opens in Gmail with its recipient and the converted file, and nothing of ours in the reply', () => {
  const w = world();
  const done = cardOf(
    w.click(
      'onConvertAttachment',
      gmailEvent({ params: { index: '0', hash: hashOf(w, 'm1', 0) }, inputs: { to: 'jpg' } }),
    ),
  );
  const reply = button(done, 'Reply with the file attached');
  const composed = render(
    w.click('onReplyWithResult', gmailEvent({ params: reply.compose.parameters })),
  );
  // What Gmail's page shows (an empty body would open a blank reply: no recipient, no file).
  assert.deepEqual(composed.replyBox.to, ['sender@example.com']);
  assert.deepEqual(composed.replyBox.attachments, ['IMG_0001.jpg']);
  // The body is whitespace only: the reply looks empty, for the user to write in.
  const [draft] = w.gmail.drafts;
  assert.match(draft.body, /^\s+$/);
  assert.equal(draft.htmlBody, undefined);
  assert.equal(composed.replyBox.body.trim(), '');
});

test('the reply draft without the file still opens with its recipient and says why', () => {
  const w = world();
  // A result over Gmail's attachment limit: the card offers no reply, a stale card still may.
  const done = cardOf(
    w.click(
      'onConvertAttachment',
      gmailEvent({
        messageId: 'other',
        params: { index: '2', hash: hashOf(w, 'other', 2) },
        inputs: { to: 'jpg' },
      }),
    ),
  );
  const { id } = button(done, 'Save to Google Drive').action.parameters;
  const composed = render(
    w.click('onReplyWithResult', gmailEvent({ messageId: 'other', params: { id } })),
  );
  assert.deepEqual(composed.replyBox, {
    to: ['sender@example.com'],
    body: 'Converter Studio could not attach the converted file: The converted file is too large to attach to an e-mail. Download it or save it to Drive instead.',
    attachments: [],
  });
  assert.deepEqual(w.logs, [], 'an expected refusal is not logged');
});

test('the fake Gmail page replays the reply drafts tried in a real account on 2026-11-23', () => {
  const scope = { phase: 'action' };
  const gmail = fakeGmail(
    { m: { token: 't', from: 'sender@example.com', attachments: [] } },
    scope,
  );
  gmail.app.setCurrentMessageAccessToken('t');
  const message = gmail.app.getMessageById('m');
  const cards = fakeCardService();
  const box = (body, options = {}) => {
    const file = fakeBlob(Buffer.from('converted'), 'text/plain', 'note.txt');
    const draft = message.createDraftReply(body, { ...options, attachments: [file] });
    return render(cards.newComposeActionResponseBuilder().setGmailDraft(draft).build()).replyBox;
  };
  const shown = (body) => ({ to: ['sender@example.com'], body, attachments: ['note.txt'] });
  assert.deepEqual(box(''), { to: [], body: '', attachments: [] }, 'A: blank');
  assert.deepEqual(box('Converted file attached.'), shown('Converted file attached.'), 'B');
  assert.deepEqual(box('', { htmlBody: '<p>Converted</p>' }), shown('<p>Converted</p>'), 'C');
  assert.deepEqual(box(' '), shown(' '), 'G: one space');
  // Reading a draft back needs the full Gmail scope, which the add-on does not have.
  assert.throws(() => message.createDraftReply(' ').getMessage(), /mail\.google\.com/);
});

test('the reply draft: a bare media type on the file, one log line without its name or address', () => {
  const w = world();
  // The download's Content-Type with a parameter, as a server may send for text.
  const handler = w.api.handler;
  w.api.handler = (request) => {
    const answer = handler(request);
    if (answer && request.url.includes('/download'))
      answer.headers['Content-Type'] = 'text/plain; charset=utf-8';
    return answer;
  };
  const done = cardOf(
    w.click(
      'onConvertAttachment',
      gmailEvent({ params: { index: '1', hash: hashOf(w, 'm1', 1) }, inputs: { to: 'txt' } }),
    ),
  );
  const reply = button(done, 'Reply with the file attached');
  const composed = render(
    w.click('onReplyWithResult', gmailEvent({ params: reply.compose.parameters })),
  );
  assert.equal(composed.kind, 'ComposeActionResponse');
  assert.equal(w.gmail.drafts[0].attachments[0].contentType, 'text/plain');
  assert.equal(w.gmail.drafts[0].attachments[0].name, 'scan.txt');
  assert.deepEqual(composed.replyBox.attachments, ['scan.txt']);
  assert.equal(w.logs.length, 1);
  assert.match(
    w.logs[0][1],
    /^Converter Studio add-on: reply draft made with 1 attachment, \d+ bytes, text\/plain$/,
  );
  assert.ok(!JSON.stringify(w.logs).includes('scan'), 'no file name in the log');
  assert.ok(!JSON.stringify(w.logs).includes('@'), 'no address in the log');
});

test('a scanned PDF to text with OCR', () => {
  const w = world();
  const form = cardOf(
    w.click('onPickAttachment', gmailEvent({ params: { index: '1', hash: hashOf(w, 'm1', 1) } })),
  );
  const dropdown = form.sections[0].widgets[0];
  assert.deepEqual(
    dropdown.items.find((i) => i[1] === 'pdf'),
    ['PDF (smaller file)', 'pdf', true],
  );
  const ocr = form.sections[0].widgets[1];
  assert.equal(ocr.fieldName, 'ocr');
  assert.equal(ocr.type, 'SelectionInputType.CHECK_BOX');
  assert.deepEqual(ocr.items, [['Recognise text (scanned PDF), for TXT and DOCX', 'yes', false]]);
  const convert = button(form, 'Convert');
  w.click(
    convert.action.functionName,
    gmailEvent({ params: convert.action.parameters, inputs: { to: 'txt', ocr: 'yes' } }),
  );
  const start = w.requests.find((r) => r.url.endsWith('/v1/conversions'));
  assert.deepEqual(JSON.parse(start.body).options, { ocr: true });
});

test('a long conversion: "Check again" picks it up later', () => {
  const w = world();
  const event = (params, inputs) => gmailEvent({ messageId: 'slow', params, inputs });
  const working = cardOf(
    w.click(
      'onConvertAttachment',
      event({ index: '0', hash: hashOf(w, 'slow', 0) }, { to: 'mp4' }),
    ),
  );
  assert.match(textOf(working), /Converting/);
  const again = button(working, 'Check again');
  assert.equal(again.action.parameters.host, 'gmail');
  w.clock.now += 70_000; // the user comes back a minute later
  const done = cardOf(w.click('onCheckConversion', event(again.action.parameters)));
  assert.match(textOf(done), /slow-video\.mp4/);
  assert.ok(button(done, 'Download'));
});

test('over the credit limit: nothing is charged until "Convert for 30 credits"', () => {
  const w = world();
  const event = (params, inputs) => gmailEvent({ messageId: 'other', params, inputs });
  const quoted = cardOf(
    w.click(
      'onConvertAttachment',
      event({ index: '0', hash: hashOf(w, 'other', 0) }, { to: 'mp4' }),
    ),
  );
  assert.match(textOf(quoted), /costs 30 credits, more than the 20 credits you allow/);
  const go = button(quoted, 'Convert for 30 credits');
  const done = cardOf(w.click(go.action.functionName, event(go.action.parameters)));
  assert.match(textOf(done), /quote-long\.mp4/);
});

test('a failed conversion shows the API’s reason', () => {
  const w = world();
  const failed = cardOf(
    w.click(
      'onConvertAttachment',
      gmailEvent({
        messageId: 'other',
        params: { index: '1', hash: hashOf(w, 'other', 1) },
        inputs: { to: 'pdf' },
      }),
    ),
  );
  assert.match(textOf(failed), /Not converted/);
  assert.match(textOf(failed), /This file is damaged and could not be read\./);
  assert.equal(buttons(failed).length, 0);
});

test('a result too large to attach is offered as a download and a Drive file only', () => {
  const w = world();
  const done = cardOf(
    w.click(
      'onConvertAttachment',
      gmailEvent({
        messageId: 'other',
        params: { index: '2', hash: hashOf(w, 'other', 2) },
        inputs: { to: 'jpg' },
      }),
    ),
  );
  assert.deepEqual(
    buttons(done).map((b) => b.text),
    ['Download', 'Save to Google Drive'],
  );
});

test('a changed message, a wrong target or a lost token never converts the wrong thing', () => {
  const w = world();
  const moved = w.click(
    'onConvertAttachment',
    gmailEvent({ params: { index: '0', hash: 'not-the-hash' }, inputs: { to: 'jpg' } }),
  );
  assert.equal(notificationOf(moved), 'The attachment is no longer in this message.');
  const wrong = w.click(
    'onConvertAttachment',
    gmailEvent({ params: { index: '0', hash: hashOf(w, 'm1', 0) }, inputs: { to: 'mp3' } }),
  );
  assert.equal(
    notificationOf(wrong),
    'Converter Studio cannot convert this file to the chosen format.',
  );
  const token = w.click('onShowAttachments', gmailEvent({ token: 'stale' }));
  assert.equal(notificationOf(token), 'The message could not be opened. Open it again and retry.');
  assert.equal(w.requests.filter((r) => r.method === 'PUT').length, 0);
  assert.deepEqual(w.logs, [], 'expected refusals are not logged as errors');
});

test('every button calls a function of the add-on, with string parameters', () => {
  const w = world();
  const cards = [
    cardOf(w.trigger('onHomepage', gmailEvent())),
    cardOf(w.trigger('onGmailMessageOpen', gmailEvent())),
    cardOf(w.click('onShowAttachments', gmailEvent())),
    cardOf(
      w.click('onPickAttachment', gmailEvent({ params: { index: '1', hash: hashOf(w, 'm1', 1) } })),
    ),
    cardOf(
      w.click(
        'onConvertAttachment',
        gmailEvent({ params: { index: '0', hash: hashOf(w, 'm1', 0) }, inputs: { to: 'jpg' } }),
      ),
    ),
    cardOf(w.addOn.call('onShowSettings', gmailEvent())),
  ];
  for (const card of cards)
    for (const name of actionNames(card))
      assert.equal(w.addOn.get(`typeof ${name}`), 'function', name);
});

/** Gmail's SHA-1 of an attachment, as the list card puts it in the button's parameters. */
function hashOf(w, messageId, index) {
  const list = cardOf(w.click('onShowAttachments', gmailEvent({ messageId })));
  const row = list.sections[0].widgets[index];
  return row.button.onClickAction.parameters.hash;
}
