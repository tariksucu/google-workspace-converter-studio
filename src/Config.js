/* eslint @typescript-eslint/no-unused-vars: ["error", { "varsIgnorePattern": "^CS_" }] -- Apps Script shares top-level names across the project's files */

/**
 * Converter Studio for Google Workspace: the add-on's fixed settings.
 *
 * Every file in src/ is a plain script. Apps Script loads them all into one global scope (V8
 * runtime), and Node's tests and tools load the same files into one `vm` context the same way
 * (tools/load.mjs). Names are looked up when a function runs, so the order of the files does not
 * matter. Only Gmail.js, Cards.js and Main.js touch Apps Script's services; the rest is plain
 * JavaScript that gets what it needs (UrlFetchApp, the Drive service, the clock) passed in.
 */
const CS_CONFIG = Object.freeze({
  /** This add-on's version (package.json says the same: test/package.test.mjs). */
  version: '1.0.0',
  /** Names the add-on on its API calls (Converter Studio's statistics of its connectors). */
  clientName: 'google-workspace',
  /** The public API. A project editor can point a copy elsewhere (script property CS_API_BASE_URL). */
  defaultBaseUrl: 'https://converter.studio/api',
  siteUrl: 'https://converter.studio',
  /** Conversions that cost more than this many credits wait for a click (user setting). */
  defaultMaxCredits: 20,
  /**
   * Apps Script ends a Google Workspace add-on's execution after 30 seconds (Quotas for Google
   * Services, "Google Workspace add-on runtime"). Each click's work stops waiting here and shows
   * "Check again" instead.
   */
  budgetMs: 24000,
  /** UrlFetchApp sends and receives at most 50 MB a call (Quotas: "URL Fetch POST size"). */
  maxBytes: 50 * 1000 * 1000,
  /**
   * Gmail takes 25 MB of attachments a message, counted after encoding (base64 adds a third):
   * a converted file larger than this is offered as a download or saved to Drive instead.
   */
  maxReplyAttachmentBytes: 18 * 1000 * 1000,
  /** Drive exports a Google Docs, Sheets or Slides file of at most 10 MB (Drive API files.export). */
  maxExportBytes: 10 * 1000 * 1000,
  /** The formats list is kept this long in the script cache (seconds; CacheService's maximum). */
  catalogCacheSeconds: 6 * 3600,
  /** The folder in My Drive for results that have no folder of their own (Marketplace review rule). */
  driveFolderName: 'Converter Studio',
});
