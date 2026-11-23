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
  version: '1.1.2',
  /** Names the add-on on its API calls (Converter Studio's statistics of its connectors). */
  clientName: 'google-workspace',
  /** The public API. A project editor can point a copy elsewhere (script property CS_API_BASE_URL). */
  defaultBaseUrl: 'https://converter.studio/api',
  siteUrl: 'https://converter.studio',
  /**
   * The sign-in button's icon: Google's standard-colour "G", which Google's sign-in branding
   * guidelines require on a "Continue with Google" button (Google's own copy of it).
   */
  googleIconUrl:
    'https://www.gstatic.com/images/branding/googleg/1x/googleg_standard_color_48dp.png',
  /** Where a user takes away the add-on's access to the Google account (Sign out says so). */
  googleConnectionsUrl: 'https://myaccount.google.com/connections',
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
  /**
   * The body of the reply draft that carries the converted file: one space, and nothing of ours.
   * Gmail on the web shows a reply draft with an empty body as a blank reply box, without its
   * recipient and without the attached file, although the draft holds both (seen in a real account
   * on 2026-11-23: `createDraftReply('', { attachments })` opened blank; the same call with any
   * non-empty body, even one space, or with an `htmlBody`, opened with the recipient and the
   * attachment). One space keeps the reply looking empty, with the cursor in it, for the user to
   * write.
   */
  replyDraftBody: ' ',
  /** Drive exports a Google Docs, Sheets or Slides file of at most 10 MB (Drive API files.export). */
  maxExportBytes: 10 * 1000 * 1000,
  /** The formats list is kept this long in the script cache (seconds; CacheService's maximum). */
  catalogCacheSeconds: 6 * 3600,
  /** The folder in My Drive for results that have no folder of their own (Marketplace review rule). */
  driveFolderName: 'Converter Studio',
  /**
   * The permissions (OAuth scopes) of appsscript.json, by name. Google's consent screen lists each
   * one with a box to tick, and a user may leave any of them unticked (granular consent).
   */
  scopes: Object.freeze({
    gmail: 'https://www.googleapis.com/auth/gmail.addons.execute',
    message: 'https://www.googleapis.com/auth/gmail.addons.current.message.action',
    compose: 'https://www.googleapis.com/auth/gmail.addons.current.action.compose',
    selection: 'https://www.googleapis.com/auth/drive.addons.metadata.readonly',
    driveFile: 'https://www.googleapis.com/auth/drive.file',
    fetch: 'https://www.googleapis.com/auth/script.external_request',
    openid: 'openid',
    email: 'https://www.googleapis.com/auth/userinfo.email',
  }),
  /**
   * What each part of the add-on needs (names of `scopes`). Every entry point asks Google for the
   * parts it uses before doing anything (Main.js), as Google recommends: the permissions of the
   * flow at hand, not all of them, so a Gmail-only user is never asked about Drive.
   */
  needs: Object.freeze({
    /** Any execution in Gmail. */
    gmail: Object.freeze(['gmail']),
    /**
     * Anything sent to Converter Studio (UrlFetchApp), the formats list included; signing in, and
     * every signed-in request, which may renew the sign-in with Google's identity token.
     */
    converterStudio: Object.freeze(['fetch', 'openid', 'email']),
    /** The open message's attachments, read after a click. */
    message: Object.freeze(['message']),
    /** The reply draft with the converted file (made from the open message). */
    reply: Object.freeze(['message', 'compose']),
    /** The Drive items selected in Drive's side panel. */
    selection: Object.freeze(['selection']),
    /** A Drive file the user allowed (its bytes come through UrlFetchApp), and saving results. */
    driveFiles: Object.freeze(['driveFile', 'fetch']),
  }),
});
