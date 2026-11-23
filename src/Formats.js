/* eslint @typescript-eslint/no-unused-vars: ["error", { "varsIgnorePattern": "^Cs[A-Z]" }] -- Apps Script shares top-level names across the project's files */

/**
 * What a file can become, from the API's own catalogue (`GET /v1/formats`): every format
 * Converter Studio reads, its file extensions, and the formats it converts to, most popular first.
 * Nothing here is a hard-coded list of conversions. Plain JavaScript (no Apps Script service).
 *
 * @typedef {{ id: string, name: string, category: string, extensions: string[], to: string[] }} FormatView
 * @typedef {{ formats: FormatView[], byId: Map<string, FormatView>, byExtension: Map<string, string> }} Catalog
 */
const CsFormats = (function () {
  /**
   * Google Docs, Sheets, Slides and Drawings have no bytes of their own: Drive exports them first
   * (to the format below), then they convert like any other file. Converter Studio's own "Open
   * with" app does the same.
   */
  const GOOGLE_EXPORTS = {
    'application/vnd.google-apps.document': {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extension: 'docx',
    },
    'application/vnd.google-apps.spreadsheet': {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
    },
    'application/vnd.google-apps.presentation': {
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: 'pptx',
    },
    'application/vnd.google-apps.drawing': { mimeType: 'image/png', extension: 'png' },
  };
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  /** Targets that text recognition (OCR) can make from a PDF (the API's `ocr` option). */
  const OCR_TARGETS = ['txt', 'docx'];

  /**
   * A catalogue from the API's answer; formats without a valid id are left out.
   * @param {unknown} body the JSON of `GET /v1/formats`
   * @returns {Catalog}
   */
  function parseCatalog(body) {
    const list = body && Array.isArray(body.formats) ? body.formats : [];
    const formats = [];
    for (const f of list) {
      if (!f || typeof f.id !== 'string' || !/^[a-z0-9]{1,10}$/.test(f.id)) continue;
      formats.push({
        id: f.id,
        name: typeof f.name === 'string' && f.name ? f.name : f.id.toUpperCase(),
        category: typeof f.category === 'string' ? f.category : 'other',
        extensions: Array.isArray(f.extensions)
          ? f.extensions.filter((e) => typeof e === 'string').map((e) => e.toLowerCase())
          : [],
        to: Array.isArray(f.to) ? f.to.filter((t) => typeof t === 'string') : [],
      });
    }
    const byId = new Map(formats.map((f) => [f.id, f]));
    const byExtension = new Map();
    for (const f of formats)
      for (const e of f.extensions) if (!byExtension.has(e)) byExtension.set(e, f.id);
    return { formats, byId, byExtension };
  }

  /**
   * The format a file is in, from the end of its name (`IMG_1.HEIC` → `heic`, `a.tar.gz` → the
   * format whose extension is `tar.gz`), or `null` when the catalogue knows none.
   * @param {Catalog} catalog
   * @param {string} fileName
   */
  function formatOf(catalog, fileName) {
    const name = String(fileName || '')
      .trim()
      .toLowerCase();
    let best = null;
    let bestLength = 0;
    for (const [extension, id] of catalog.byExtension) {
      if (
        extension.length > bestLength &&
        name.length > extension.length + 1 &&
        name.endsWith('.' + extension)
      ) {
        best = id;
        bestLength = extension.length;
      }
    }
    return best;
  }

  /** PDF to PDF is the API's "compress a PDF". */
  const isCompression = (from, to) => from === 'pdf' && to === 'pdf';

  /** A PDF made into text or Word can read scanned pages with text recognition. */
  const offersOcr = (from, to) => from === 'pdf' && OCR_TARGETS.indexOf(to) >= 0;

  /**
   * The choices for a file of format `from`, in the API's order: `{ to, label }`.
   * @param {Catalog} catalog
   * @param {string | null} from
   */
  function targetsFor(catalog, from) {
    const source = from ? catalog.byId.get(from) : undefined;
    if (!source) return [];
    return source.to.map((to) => {
      const name = catalog.byId.get(to) ? catalog.byId.get(to).name : to.toUpperCase();
      let label = name;
      if (isCompression(from, to)) label = 'PDF (smaller file)';
      // A picture made into text or Word goes through text recognition.
      else if (source.category === 'image' && OCR_TARGETS.indexOf(to) >= 0)
        label = name + ' (text recognition)';
      return { to, label };
    });
  }

  /**
   * The target picked first: what most people want from that kind of file (the API's first
   * target), except that a PDF is offered as a smaller PDF.
   */
  function defaultTarget(catalog, from) {
    const targets = targetsFor(catalog, from);
    if (targets.some((t) => isCompression(from, t.to))) return 'pdf';
    return targets.length ? targets[0].to : null;
  }

  /**
   * The settings sent with a conversion: "balanced" compression for PDF to PDF, and text
   * recognition when asked for a PDF made into text or Word.
   * @param {string} from
   * @param {string} to
   * @param {{ ocr?: boolean }} [choices]
   */
  function optionsFor(from, to, choices) {
    if (isCompression(from, to)) return { compression: 'balanced' };
    if (offersOcr(from, to) && choices && choices.ocr) return { ocr: true };
    return undefined;
  }

  /**
   * `IMG_0001.HEIC` → `IMG_0001.jpg`, with the target format's first extension from the catalogue.
   * @param {Catalog} catalog
   * @param {string} fileName
   * @param {string} to
   */
  function outputName(catalog, fileName, to) {
    const name = String(fileName || '').trim() || 'file';
    const from = formatOf(catalog, name);
    const known = from
      ? catalog.byId.get(from).extensions.find((e) => name.toLowerCase().endsWith('.' + e))
      : undefined;
    const base = known ? name.slice(0, name.length - known.length - 1) : name;
    const target = catalog.byId.get(to);
    const extension = target && target.extensions.length ? target.extensions[0] : to;
    return base + '.' + extension;
  }

  /**
   * How Drive hands over a file: Google's own types are exported, everything else is downloaded.
   * @param {string} mimeType Drive's MIME type of the file
   * @param {string} title the file's name in Drive
   * @returns {{ kind: 'folder' } | { kind: 'export', mimeType: string, name: string } | { kind: 'download', name: string } | { kind: 'unsupported' }}
   */
  function driveSource(mimeType, title) {
    if (mimeType === FOLDER_MIME) return { kind: 'folder' };
    const exported = GOOGLE_EXPORTS[mimeType];
    if (exported) {
      const base = String(title || '').trim() || 'file';
      return { kind: 'export', mimeType: exported.mimeType, name: base + '.' + exported.extension };
    }
    if (/^application\/vnd\.google-apps\./.test(String(mimeType || '')))
      return { kind: 'unsupported' };
    return { kind: 'download', name: String(title || '').trim() || 'file' };
  }

  /** "2.4 MB", "530 KB", "12 bytes". */
  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1000) return bytes + ' bytes';
    if (bytes < 1000000) return Math.round(bytes / 1000) + ' KB';
    return (bytes / 1000000).toFixed(bytes < 10000000 ? 1 : 0) + ' MB';
  }

  /** "1 credit", "3 credits". */
  function credits(n) {
    if (n === null || n === undefined) return 'an unknown number of credits';
    return n + ' credit' + (n === 1 ? '' : 's');
  }

  return {
    GOOGLE_EXPORTS,
    parseCatalog,
    formatOf,
    isCompression,
    offersOcr,
    targetsFor,
    defaultTarget,
    optionsFor,
    outputName,
    driveSource,
    formatBytes,
    credits,
  };
})();
