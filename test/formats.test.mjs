import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAddOn } from '../tools/load.mjs';
import { FORMATS } from './fake-api.mjs';

// The plain-JavaScript parts load with no Apps Script service at all.
const addOn = loadAddOn();
const F = addOn.get('CsFormats');
const catalog = F.parseCatalog(FORMATS);

test('the catalogue comes from the API and keeps its order', () => {
  assert.equal(catalog.formats.length, 67);
  assert.equal(F.formatOf(catalog, 'IMG_0001.HEIC'), 'heic');
  assert.equal(F.formatOf(catalog, 'photo.HEIF'), 'heic');
  assert.equal(F.formatOf(catalog, 'archive.tar.gz'), 'tgz');
  assert.equal(F.formatOf(catalog, 'notes.xyz'), null);
  assert.equal(F.formatOf(catalog, '.pdf'), null);
  assert.equal(
    F.parseCatalog({ formats: [{ id: '../x' }, null, { id: 'ok', to: ['a'] }] }).formats.length,
    1,
  );
  assert.equal(F.parseCatalog(null).formats.length, 0);
});

test('targets: HEIC to JPG first, PDF offered smaller, pictures to text through OCR', () => {
  const heic = F.targetsFor(catalog, 'heic');
  assert.equal(F.defaultTarget(catalog, 'heic'), 'jpg');
  // Objects made inside the add-on's context have that context's prototypes: compare copies.
  assert.deepEqual(
    { ...heic.find((t) => t.to === 'txt') },
    { to: 'txt', label: 'TXT (text recognition)' },
  );
  assert.equal(F.defaultTarget(catalog, 'pdf'), 'pdf');
  assert.equal(
    F.targetsFor(catalog, 'pdf').find((t) => t.to === 'pdf').label,
    'PDF (smaller file)',
  );
  assert.equal(F.defaultTarget(catalog, 'docx'), 'pdf');
  assert.equal(F.targetsFor(catalog, null).length, 0);
});

test('options: compression for PDF to PDF, OCR only when asked and only for PDF to text or Word', () => {
  assert.deepEqual({ ...F.optionsFor('pdf', 'pdf') }, { compression: 'balanced' });
  assert.deepEqual({ ...F.optionsFor('pdf', 'txt', { ocr: true }) }, { ocr: true });
  assert.deepEqual({ ...F.optionsFor('pdf', 'docx', { ocr: true }) }, { ocr: true });
  assert.equal(F.optionsFor('pdf', 'txt', { ocr: false }), undefined);
  assert.equal(F.optionsFor('pdf', 'jpg', { ocr: true }), undefined);
  assert.equal(F.optionsFor('heic', 'jpg', { ocr: true }), undefined);
  assert.equal(F.offersOcr('pdf', 'docx'), true);
  assert.equal(F.offersOcr('jpg', 'txt'), false);
});

test('output names take the target extension from the catalogue', () => {
  assert.equal(F.outputName(catalog, 'IMG_0001.HEIC', 'jpg'), 'IMG_0001.jpg');
  assert.equal(F.outputName(catalog, 'a.tar.gz', 'zip'), 'a.zip');
  assert.equal(F.outputName(catalog, 'odd', 'pdf'), 'odd.pdf');
});

test('Drive: Google files are exported, folders and Forms are not converted', () => {
  assert.deepEqual(
    { ...F.driveSource('application/vnd.google-apps.document', 'Plan') },
    {
      kind: 'export',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      name: 'Plan.docx',
    },
  );
  assert.equal(
    F.driveSource('application/vnd.google-apps.spreadsheet', 'Budget').name,
    'Budget.xlsx',
  );
  assert.equal(F.driveSource('application/vnd.google-apps.presentation', 'Deck').name, 'Deck.pptx');
  assert.equal(F.driveSource('application/vnd.google-apps.drawing', 'Logo').name, 'Logo.png');
  assert.equal(F.driveSource('application/vnd.google-apps.folder', 'X').kind, 'folder');
  assert.equal(F.driveSource('application/vnd.google-apps.form', 'Quiz').kind, 'unsupported');
  assert.deepEqual(
    { ...F.driveSource('image/heic', 'beach.heic') },
    { kind: 'download', name: 'beach.heic' },
  );
});

test('sizes and credits in words', () => {
  assert.equal(F.formatBytes(12), '12 bytes');
  assert.equal(F.formatBytes(530_000), '530 KB');
  assert.equal(F.formatBytes(2_400_000), '2.4 MB');
  assert.equal(F.formatBytes(24_000_000), '24 MB');
  assert.equal(F.formatBytes(-1), '');
  assert.equal(F.credits(1), '1 credit');
  assert.equal(F.credits(30), '30 credits');
  assert.equal(F.credits(null), 'an unknown number of credits');
});
