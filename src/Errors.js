/* eslint @typescript-eslint/no-unused-vars: ["error", { "varsIgnorePattern": "^Cs[A-Z]" }] -- Apps Script shares top-level names across the project's files */

/**
 * Why something did not happen, as a fixed list of codes. The text shown is the API's own
 * `error.message` when the API sent one, and the plain-English words below otherwise. No message
 * ever contains the session or Google's identity token.
 */
const CsErrors = (function () {
  /** Words for the add-on's own codes, and fallbacks for the API's when it sent no message. */
  const TEXT = {
    // The add-on's own.
    notSignedIn: 'Sign in to Converter Studio with your Google account first.',
    noIdentity:
      'Google did not give the add-on your sign-in. Open the add-on again and allow the permissions it asks for.',
    accountGone:
      'Your Converter Studio account no longer exists, so the add-on signed out. Click Continue with Google to make a new free account.',
    signInOff:
      'Signing in to Converter Studio from this add-on is not available right now. Try again later.',
    badMaxCredits: 'The credit limit must be a whole number from 0 to 1000.',
    badBaseUrl: 'The Converter Studio address must be an https:// address.',
    network: 'Converter Studio could not be reached. Try again in a moment.',
    outOfTime:
      'Google gives an add-on 30 seconds for each click, and this needed more. Try again, or convert a large file on converter.studio.',
    notJson: 'Converter Studio sent an answer the add-on cannot read. Try again in a minute.',
    foreignLink: 'Converter Studio sent a link to another address; it was not followed.',
    uploadIncomplete: 'The upload to Converter Studio did not arrive whole. Try again.',
    resultDownloadFailed: 'The converted file could not be fetched from Converter Studio.',
    sourceEmpty: 'The file is empty.',
    sourceTooLarge:
      'The file is larger than 50 MB, the most a Google Workspace add-on can send. Convert it on converter.studio instead.',
    resultTooLarge:
      'The converted file is larger than 50 MB, the most the add-on can fetch. Use the download link instead.',
    unknownFormat: 'Converter Studio does not read this kind of file.',
    notConvertible: 'Converter Studio cannot convert this file to the chosen format.',
    attachmentGone: 'The attachment is no longer in this message.',
    messageGone: 'The message could not be opened. Open it again and retry.',
    fileGone: 'The file is no longer available, or the add-on may not open it.',
    exportTooLarge:
      'Google Drive exports Docs, Sheets and Slides of at most 10 MB. Download the file and convert it on converter.studio instead.',
    driveSaveFailed: 'Google Drive did not accept the converted file.',
    replyTooLarge:
      'The converted file is too large to attach to an e-mail. Download it or save it to Drive instead.',
    notDone: 'The conversion is not finished yet.',
    // The API's (`{ error: { code, message } }`), for answers without a message.
    googleSignInFailed: 'Signing in with Google did not work. Please try again.',
    googleAccountNotLinked:
      'An account with this e-mail address already exists at converter.studio, but the address is not verified yet. Sign in there with your password to verify it, then try again.',
    notEnoughCredits: 'Not enough credits left on the Converter Studio account.',
    dailyLimit: "The Converter Studio account's daily credits are used up.",
    monthlyLimit: "The Converter Studio account's monthly credits are used up.",
    fileTooLarge: 'The file is larger than the Converter Studio plan allows.',
    tooManyRequests: 'Too many requests to Converter Studio; try again in a minute.',
    serverBusy: 'Converter Studio is busy; try again in a few minutes.',
    unsupportedConversion: 'Converter Studio cannot convert this file to the chosen format.',
    conversionFailed: 'The conversion failed; no credits were charged.',
    fileExpired: 'The converted file was deleted after 6 hours. Convert the file again.',
    notFound: 'Converter Studio no longer has this conversion.',
    unknown: 'Something went wrong.',
  };

  /** An error with a code from the list above (or one the API sent) and a message to show. */
  class CsError extends Error {
    /**
     * @param {string} code
     * @param {string} [message] shown to the user; the code's own words when left out
     * @param {{ status?: number, retryAfter?: number | null, params?: object | null }} [extra]
     */
    constructor(code, message, extra) {
      super(message || TEXT[code] || TEXT.unknown);
      this.name = 'CsError';
      this.code = code;
      this.status = (extra && extra.status) || null;
      this.retryAfter = extra && extra.retryAfter !== undefined ? extra.retryAfter : null;
      this.params = (extra && extra.params) || null;
    }
  }

  /** Any thrown value as a CsError; an unknown error keeps a generic text (it may hold internals). */
  function asCsError(error) {
    if (error instanceof CsError) return error;
    return new CsError('unknown');
  }

  /**
   * Google's own exceptions that end an execution to ask the user for a permission
   * (`ScriptApp.requireScopes`, thrown when a second look finds one missing: Main.js). Google
   * shows its "Authorization required" card only if the exception reaches Apps Script, so every
   * catch on its way lets it through (`passGoogleStop`). Known by identity, not by its text, which
   * Google writes in the user's language.
   */
  const STOPS = [];

  /** Marks Google's exception as one that must reach Apps Script; returns it unchanged. */
  function googleStop(error) {
    if (STOPS.indexOf(error) < 0) STOPS.push(error);
    return error;
  }

  function isGoogleStop(error) {
    return STOPS.indexOf(error) >= 0;
  }

  /** The first line of a catch that may see Google's exception: throws it on. */
  function passGoogleStop(error) {
    if (isGoogleStop(error)) throw error;
  }

  /**
   * Text for the project's log: addresses without their query or fragment (upload and download
   * links carry their own tokens there), and nothing shaped like a session, a key, an OAuth access
   * token or an identity token.
   */
  function scrub(text) {
    return String(text)
      .replace(/(\bhttps?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, '$1?…')
      .replace(/\bBearer\s+\S+/gi, 'Bearer …')
      .replace(/\bcvs_[A-Za-z0-9_-]+/g, 'cvs_…')
      .replace(/\bya29\.[A-Za-z0-9._-]+/g, 'ya29.…')
      .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]*)?/g, '(token)');
  }

  /** A thrown value for the log: its name and message (or its stack), scrubbed, at most 2,000 characters. */
  function describe(error, withStack) {
    let text;
    if (error && withStack && error.stack) text = String(error.stack);
    else if (error && error.message !== undefined)
      text = (error.name ? error.name + ': ' : '') + error.message;
    else text = String(error);
    return scrub(text).slice(0, 2000);
  }

  return {
    TEXT,
    CsError,
    asCsError,
    googleStop,
    isGoogleStop,
    passGoogleStop,
    scrub,
    describe,
  };
})();
