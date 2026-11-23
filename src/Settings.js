/* global CsErrors, CS_CONFIG */
/* eslint @typescript-eslint/no-unused-vars: ["error", { "varsIgnorePattern": "^Cs[A-Z]" }] -- Apps Script shares top-level names across the project's files */

/**
 * The add-on's settings. Plain JavaScript: it reads and writes any object shaped like Apps
 * Script's `Properties` (getProperty, setProperty, deleteProperty).
 *
 * - The API key and the credit limit are the user's own (`PropertiesService.getUserProperties()`):
 *   Google keeps them with this add-on and this Google account, other users of the add-on never
 *   see them, and only the add-on's own code reads them while that user runs it.
 * - The API address is the project's (`getScriptProperties()`, set by a project editor under
 *   Project Settings → Script properties); users never see it. Published copies use the default.
 */
const CsSettings = (function () {
  const API_KEY = 'CS_API_KEY';
  const MAX_CREDITS = 'CS_MAX_CREDITS';
  const DRIVE_FOLDER = 'CS_DRIVE_FOLDER_ID';
  const BASE_URL = 'CS_API_BASE_URL';
  /** `cvs_live_` and 32 letters and digits (Converter Studio's key format). */
  const KEY_PATTERN = /^cvs_live_[A-Za-z0-9]{32}$/;
  const MAX_LIMIT = 1000;

  /** A pasted key without the spaces and quotes around it; refuses anything else. */
  function normaliseKey(raw) {
    const key = String(raw === undefined || raw === null ? '' : raw)
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^Bearer\s+/i, '');
    if (!KEY_PATTERN.test(key)) throw new CsErrors.CsError('badKey');
    return key;
  }

  /** "cvs_live_…AbCd": enough to tell keys apart, never the key. */
  function maskKey(key) {
    return key ? 'cvs_live_…' + String(key).slice(-4) : '';
  }

  /** A whole number of credits from 0 (always ask) to 1000. */
  function parseMaxCredits(raw) {
    const text = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!/^\d{1,4}$/.test(text) || Number(text) > MAX_LIMIT)
      throw new CsErrors.CsError('badMaxCredits');
    return Number(text);
  }

  /**
   * The API's address: https only, or a test server on this computer (only Node's tests can reach
   * one; Apps Script cannot).
   */
  function checkBaseUrl(raw) {
    const url = String(raw || '')
      .trim()
      .replace(/\/+$/, '');
    if (/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\-/]*)?$/i.test(url)) return url;
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[A-Za-z0-9._~\-/]*)?$/i.test(url)) return url;
    throw new CsErrors.CsError('badBaseUrl');
  }

  /**
   * Everything a click needs.
   * @param {{ getProperty: (key: string) => string | null }} user the user's properties
   * @param {{ getProperty: (key: string) => string | null }} script the project's properties
   */
  function read(user, script) {
    const stored = user.getProperty(MAX_CREDITS);
    let maxCredits = CS_CONFIG.defaultMaxCredits;
    if (stored !== null && stored !== undefined) {
      try {
        maxCredits = parseMaxCredits(stored);
      } catch {
        maxCredits = CS_CONFIG.defaultMaxCredits;
      }
    }
    const base = script.getProperty(BASE_URL);
    return {
      apiKey: user.getProperty(API_KEY) || null,
      maxCredits,
      baseUrl: base ? checkBaseUrl(base) : CS_CONFIG.defaultBaseUrl,
    };
  }

  /** Saves what the settings card sent: a new key (left empty: keep the one saved) and the limit. */
  function save(user, input) {
    const changes = {};
    const key = String(input.apiKey === undefined || input.apiKey === null ? '' : input.apiKey);
    if (key.trim()) changes[API_KEY] = normaliseKey(key);
    if (input.maxCredits !== undefined && String(input.maxCredits).trim() !== '')
      changes[MAX_CREDITS] = String(parseMaxCredits(input.maxCredits));
    for (const name of Object.keys(changes)) user.setProperty(name, changes[name]);
    return changes;
  }

  /** Forgets the key; the add-on then does nothing until a key is added again. */
  function forget(user) {
    user.deleteProperty(API_KEY);
  }

  return {
    API_KEY,
    MAX_CREDITS,
    DRIVE_FOLDER,
    BASE_URL,
    normaliseKey,
    maskKey,
    parseMaxCredits,
    checkBaseUrl,
    read,
    save,
    forget,
  };
})();
