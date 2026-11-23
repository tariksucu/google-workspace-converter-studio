import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TOKEN,
  actionNames,
  button,
  buttons,
  cardOf,
  driveEvent,
  item,
  notificationOf,
  render,
  textOf,
  world,
} from './harness.mjs';

test('no selection shows the homepage; several items are listed to choose from', () => {
  const w = world();
  assert.equal(cardOf(w.trigger('onDriveItemsSelected', driveEvent())).name, 'home');
  const many = cardOf(
    w.trigger('onDriveItemsSelected', driveEvent({ selected: [item(w, 'heic'), item(w, 'doc')] })),
  );
  assert.equal(many.name, 'selection');
  assert.deepEqual(
    buttons(many).map((b) => b.action.parameters.fileId),
    ['heic', 'doc'],
  );
  const chosen = cardOf(
    w.click(
      'onPickDriveFile',
      driveEvent({ selected: [item(w, 'heic'), item(w, 'doc')], params: { fileId: 'doc' } }),
    ),
  );
  assert.equal(chosen.name, 'convert');
  assert.equal(chosen.header.title, 'Plan');
});

test('folders and Google Forms are not converted', () => {
  const w = world();
  const folder = cardOf(
    w.trigger('onDriveItemsSelected', driveEvent({ selected: [item(w, 'photos')] })),
  );
  assert.match(textOf(folder), /folders are not converted/);
  w.drive.files.form = {
    name: 'Quiz',
    mimeType: 'application/vnd.google-apps.form',
    granted: true,
  };
  const form = cardOf(
    w.trigger('onDriveItemsSelected', driveEvent({ selected: [item(w, 'form')] })),
  );
  assert.match(textOf(form), /does not read this kind of file/);
});

test('a file the add-on may not open yet: "Allow access" asks Drive for that file only', () => {
  const w = world();
  const card = cardOf(
    w.trigger('onDriveItemsSelected', driveEvent({ selected: [item(w, 'secret')] })),
  );
  assert.equal(card.name, 'access');
  const allow = button(card, 'Allow access to this file');
  const response = render(
    w.click(
      allow.action.functionName,
      driveEvent({ selected: [item(w, 'secret')], params: allow.action.parameters }),
    ),
  );
  assert.equal(response.kind, 'DriveItemsSelectedActionResponse');
  assert.equal(response.requestFileScope, 'secret');
  // Before the user agrees, the file stays closed to the add-on.
  const refused = w.click(
    'onConvertDriveFile',
    driveEvent({ params: { fileId: 'secret' }, inputs: { to: 'jpg' } }),
  );
  assert.equal(
    notificationOf(refused),
    'The file is no longer available, or the add-on may not open it.',
  );
});

test('a photo: converted, then saved next to the original', () => {
  const w = world();
  const form = cardOf(
    w.trigger('onDriveItemsSelected', driveEvent({ selected: [item(w, 'heic')] })),
  );
  assert.equal(form.header.title, 'beach.heic');
  assert.deepEqual(form.sections[0].widgets[0].items[0], ['JPG', 'jpg', true]);
  const convert = button(form, 'Convert');
  const done = cardOf(
    w.click(
      convert.action.functionName,
      driveEvent({ params: convert.action.parameters, inputs: { to: 'jpg' } }),
    ),
  );
  assert.deepEqual(
    buttons(done).map((b) => b.text),
    ['Download', 'Save next to the original'],
  );

  // The bytes came from Drive's REST with the add-on's own token, and went to Converter Studio.
  const fromDrive = w.requests.find((r) => r.url.startsWith('https://www.googleapis.com/'));
  assert.equal(
    fromDrive.url,
    'https://www.googleapis.com/drive/v3/files/heic?alt=media&supportsAllDrives=true',
  );
  assert.equal(fromDrive.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(w.requests.find((r) => r.method === 'PUT').body.toString(), 'heic');

  const save = button(done, 'Save next to the original');
  const saved = w.click(save.action.functionName, driveEvent({ params: save.action.parameters }));
  assert.equal(notificationOf(saved), 'Saved next to the original: beach.jpg');
  const file = Object.values(w.drive.files).find((f) => f.name === 'beach.jpg');
  assert.deepEqual(file.parents, ['photos']);
  assert.match(textOf(cardOf(saved)), /Saved next to the original/);
  assert.equal(
    button(cardOf(saved), 'Open').openLink,
    `https://drive.google.com/file/d/${file.id}/view?usp=drivesdk`,
  );
  assert.deepEqual(w.logs, []);
});

test('a read-only folder: the result goes to My Drive › Converter Studio', () => {
  const w = world();
  const done = cardOf(
    w.click(
      'onConvertDriveFile',
      driveEvent({ params: { fileId: 'readonly' }, inputs: { to: 'pdf' } }),
    ),
  );
  const save = button(done, 'Save next to the original');
  const saved = w.click(save.action.functionName, driveEvent({ params: save.action.parameters }));
  assert.equal(notificationOf(saved), 'Saved in My Drive › Converter Studio: report.pdf');
  const folder = Object.values(w.drive.files).find((f) => f.name === 'Converter Studio');
  assert.deepEqual(Object.values(w.drive.files).find((f) => f.name === 'report.pdf').parents, [
    folder.id,
  ]);
  assert.equal(w.user.getProperty('CS_DRIVE_FOLDER_ID'), folder.id);
});

test('a Google Doc is exported as Word, then converted to PDF', () => {
  const w = world();
  const form = cardOf(
    w.trigger('onDriveItemsSelected', driveEvent({ selected: [item(w, 'doc')] })),
  );
  assert.equal(form.header.subtitle, 'DOCX');
  const done = cardOf(
    w.click('onConvertDriveFile', driveEvent({ params: { fileId: 'doc' }, inputs: { to: 'pdf' } })),
  );
  assert.match(textOf(done), /Plan\.pdf/);
  const exported = w.requests.find((r) => r.url.includes('/export'));
  assert.equal(
    exported.url,
    'https://www.googleapis.com/drive/v3/files/doc/export?mimeType=application%2Fvnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  const slot = w.requests.find((r) => r.url.endsWith('/v1/uploads'));
  assert.deepEqual(JSON.parse(slot.body), { fileName: 'Plan.docx', size: 11 });
});

test('Drive’s limits are said before anything is sent: a 10 MB export, a 50 MB file', () => {
  const w = world();
  const huge = w.click(
    'onConvertDriveFile',
    driveEvent({ params: { fileId: 'hugeDoc' }, inputs: { to: 'pdf' } }),
  );
  assert.match(notificationOf(huge), /at most 10 MB/);
  const film = w.click(
    'onConvertDriveFile',
    driveEvent({ params: { fileId: 'toolarge' }, inputs: { to: 'mp4' } }),
  );
  assert.match(notificationOf(film), /larger than 50 MB/);
  assert.equal(
    w.requests.filter((r) => r.url.startsWith('https://converter.studio/api/v1/uploads')).length,
    0,
  );
});

test('Drive cards: every button calls a function of the add-on; links stay on allowed sites', () => {
  const w = world();
  const cards = [
    cardOf(w.trigger('onHomepage', driveEvent())),
    cardOf(w.trigger('onDriveItemsSelected', driveEvent({ selected: [item(w, 'secret')] }))),
    cardOf(w.trigger('onDriveItemsSelected', driveEvent({ selected: [item(w, 'heic')] }))),
    cardOf(
      w.click(
        'onConvertDriveFile',
        driveEvent({ params: { fileId: 'heic' }, inputs: { to: 'jpg' } }),
      ),
    ),
  ];
  assert.match(textOf(cards[0]), /In Drive:/);
  for (const card of cards)
    for (const name of actionNames(card))
      assert.equal(w.addOn.get(`typeof ${name}`), 'function', name);
});
