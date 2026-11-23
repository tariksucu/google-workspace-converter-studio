/* global CsErrors, CS_CONFIG */
/* eslint @typescript-eslint/no-unused-vars: ["error", { "varsIgnorePattern": "^Cs[A-Z]" }] -- Apps Script shares top-level names across the project's files */

/**
 * A small client for Converter Studio's public REST API (https://converter.studio/developers):
 * upload a file, convert it, wait for the result and fetch it. Plain JavaScript: it takes any
 * object shaped like Apps Script's UrlFetchApp (`fetch(url, params)` returning an HTTPResponse),
 * so the same code runs in Apps Script, in Node's tests against a fake, and in Node against the
 * real API through a UrlFetchApp shim. Apps Script has no `URL`, `fetch` or timers: none
 * is used here.
 *
 * Every call stops before the add-on's time is up (Apps Script ends an add-on execution after 30
 * seconds): a conversion that is still running is picked up later with `get`.
 *
 * Requests are signed in with the add-on's session (Session.js): `Authorization: Bearer`, only to
 * the API's own address. Upload and download links carry their own tokens, so the session is never
 * sent with them, and a link to another address is refused. When Converter Studio refuses the
 * session (401), the client signs in again with Google once and sends the request again. Neither
 * the session nor Google's identity token ever appears in an error.
 */
const CsApi = (function () {
  /** States after which a conversion changes no more on its own. */
  const SETTLED = ['done', 'failed', 'expired', 'canceled', 'quoted'];
  const RETRY_STATUS = [408, 429, 500, 502, 503, 504];
  /** The longest file name the API takes. */
  const MAX_NAME_LENGTH = 255;
  /** Never start a request with less time than this left. */
  const MIN_REQUEST_MS = 1500;

  const isSettled = (view) => SETTLED.indexOf(view && view.status) >= 0;

  /** A file name the API takes: at most 255 characters, keeping its extension. */
  function uploadName(name) {
    const trimmed =
      String(name === undefined || name === null ? '' : name)
        .replace(/[\r\n\0]/g, '')
        .trim() || 'file';
    if (trimmed.length <= MAX_NAME_LENGTH) return trimmed;
    const dot = trimmed.lastIndexOf('.');
    const extension = dot > 0 && trimmed.length - dot <= 16 ? trimmed.slice(dot) : '';
    return trimmed.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
  }

  /** `https://Converter.Studio/api/x` → `https://converter.studio` (no URL class in Apps Script). */
  function originOf(link) {
    const match = /^(https?):\/\/([^/?#@\s]+)(?:[/?#]|$)/i.exec(String(link || ''));
    if (!match) return null;
    let host = match[2].toLowerCase();
    if (match[1].toLowerCase() === 'https') host = host.replace(/:443$/, '');
    else host = host.replace(/:80$/, '');
    return match[1].toLowerCase() + '://' + host;
  }

  /** A response header, whatever its case (UrlFetchApp keeps the server's spelling). */
  function headerOf(response, name) {
    const headers = response.getHeaders() || {};
    const wanted = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === wanted) {
        const value = headers[key];
        return Array.isArray(value) ? String(value[0]) : String(value);
      }
    }
    return null;
  }

  /** The API's error body (`{ error: { code, message, params } }`) as a CsError. */
  function readError(response) {
    const status = response.getResponseCode();
    const retryHeader = headerOf(response, 'retry-after');
    const retryAfter = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : null;
    let code = null;
    let message = null;
    let params = null;
    try {
      const body = JSON.parse(response.getContentText());
      const error = body && body.error;
      if (error && typeof error.code === 'string') code = error.code;
      if (error && typeof error.message === 'string') message = error.message;
      if (error && error.params && typeof error.params === 'object') params = error.params;
    } catch {
      // Not JSON (a proxy's error page): the status says enough.
    }
    if (!code) {
      if (status === 401) code = 'googleSignInFailed';
      else if (status === 402) code = 'notEnoughCredits';
      else if (status === 413) code = 'fileTooLarge';
      else if (status === 429) code = 'tooManyRequests';
      else if (status >= 500) code = 'serverBusy';
      else if (status >= 300 && status < 400) code = 'foreignLink';
      else code = 'unknown';
    }
    return new CsErrors.CsError(
      code,
      message || CsErrors.TEXT[code] || 'Converter Studio answered ' + status + '.',
      { status, retryAfter, params },
    );
  }

  /**
   * @param {{
   *   session: { token: () => string | null, renew: () => string | null } | null,
   *   baseUrl: string,
   *   version: string,
   *   urlFetch: { fetch: (url: string, params: object) => any },
   *   newKey: () => string,
   *   now?: () => number,
   *   sleep?: (ms: number) => void,
   *   deadline?: number,
   *   checkPermission?: (scopes: string[]) => void,
   *   log?: (text: string) => void,
   * }} options
   *   `checkPermission`: called after UrlFetchApp threw; ends the execution with Google's own
   *   permission card when one of `scopes` was not granted, returns otherwise (Main.js).
   *   `log`: the project's log (Main.js: console.error).
   */
  function createClient(options) {
    const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    const origin = originOf(baseUrl);
    if (!origin) throw new CsErrors.CsError('badBaseUrl');
    const clientHeader = CS_CONFIG.clientName + '/' + options.version;
    const now = options.now || (() => Date.now());
    const sleep = options.sleep || (() => {});
    const deadline = options.deadline || now() + CS_CONFIG.budgetMs;
    const remaining = () => deadline - now();
    const checkPermission = options.checkPermission || (() => {});
    const log = options.log || (() => {});
    /** What UrlFetchApp needs: the "external service" permission. */
    const FETCH_SCOPES = [CS_CONFIG.scopes.fetch];

    /** Refuses a link to another address than the API's (the API's own links never are). */
    function checkLink(link) {
      if (originOf(link) !== origin) throw new CsErrors.CsError('foreignLink');
    }

    /**
     * Sends a request with UrlFetchApp's parameters; tries again while the API is busy or
     * unreachable, as long as there is time. `failure`: the code when it never got through.
     */
    function send(url, params, failure, retries) {
      for (let attempt = 0; ; attempt++) {
        const left = remaining();
        if (left < MIN_REQUEST_MS) throw new CsErrors.CsError('outOfTime');
        const timeoutSeconds = Math.max(1, Math.floor((left - 500) / 1000));
        let response;
        try {
          response = options.urlFetch.fetch(
            url,
            Object.assign({}, params, {
              muteHttpExceptions: true,
              followRedirects: false,
              timeoutSeconds:
                params.timeoutSeconds !== undefined
                  ? Math.min(params.timeoutSeconds, timeoutSeconds)
                  : timeoutSeconds,
            }),
          );
        } catch (error) {
          // UrlFetchApp throws on a lost connection or its own timeout, and when the user left
          // its permission unticked (Google's consent screen has a box per permission). Its text is
          // in the user's language, so it is not read: it goes to the project's log (the address
          // without its query, never a header or the body), and Apps Script is asked whether the
          // permission is there; when it is not, Google asks the user for it instead of the add-on
          // saying "could not be reached".
          log(
            'request not sent (' +
              String(params.method || 'get').toUpperCase() +
              ' ' +
              CsErrors.scrub(url) +
              ', attempt ' +
              (attempt + 1) +
              '): ' +
              CsErrors.describe(error),
          );
          checkPermission(FETCH_SCOPES);
          if (attempt < retries && remaining() > 5000) {
            sleep(1000 * Math.pow(2, attempt));
            continue;
          }
          throw new CsErrors.CsError(failure);
        }
        const status = response.getResponseCode();
        if (status >= 200 && status < 300) return response;
        const error = readError(response);
        const lasting = error.code === 'tooManyPending' || error.code === 'tooManyUnconverted';
        if (RETRY_STATUS.indexOf(status) >= 0 && attempt < retries && !lasting) {
          const wait =
            error.retryAfter !== null ? error.retryAfter * 1000 : 1000 * Math.pow(2, attempt);
          if (remaining() - wait > 5000) {
            sleep(Math.min(wait, 3000));
            continue;
          }
        }
        throw error;
      }
    }

    /**
     * A request to the API, signed in unless `auth` is false; its JSON body. `token`: the session
     * to use (a request sent again after a renewal); otherwise the stored one.
     */
    function json(method, path, body, settings) {
      const s = settings || {};
      const auth = s.auth !== false;
      const token = auth ? s.token || (options.session && options.session.token()) : null;
      if (auth && !token) throw new CsErrors.CsError('notSignedIn');
      const headers = { Accept: 'application/json', 'X-Converter-Studio-Client': clientHeader };
      if (auth) headers.Authorization = 'Bearer ' + token;
      if (s.idempotencyKey) headers['Idempotency-Key'] = s.idempotencyKey;
      // UrlFetchApp's methods are written in lower case ("get, delete, patch, post, or put").
      const params = { method: method.toLowerCase(), headers };
      if (body !== undefined) {
        params.contentType = 'application/json';
        params.payload = JSON.stringify(body);
      }
      if (s.timeoutSeconds !== undefined) params.timeoutSeconds = s.timeoutSeconds;
      let response;
      try {
        response = send(baseUrl + path, params, 'network', s.retries === undefined ? 2 : s.retries);
      } catch (error) {
        // The session was refused (its hour is up, or Converter Studio's keys changed): sign in
        // again with Google, once, and send the same request again (with the same
        // Idempotency-Key, so a conversion is never started twice).
        if (auth && !s.token && error instanceof CsErrors.CsError && error.status === 401) {
          const renewed = options.session.renew();
          if (renewed) return json(method, path, body, Object.assign({}, s, { token: renewed }));
        }
        throw error;
      }
      try {
        return JSON.parse(response.getContentText());
      } catch {
        throw new CsErrors.CsError('notJson', undefined, { status: response.getResponseCode() });
      }
    }

    /**
     * Signs in: Google's identity token for a session (`POST /v1/google-workspace/session`).
     * `signUp` false (a renewal): Converter Studio finds the account but makes none.
     * @returns {{ token: string, expiresIn: number, newAccount: boolean }}
     */
    function exchange(idToken, signUp) {
      const body = signUp === false ? { idToken, signUp: false } : { idToken };
      let answer;
      try {
        answer = json('POST', '/v1/google-workspace/session', body, { auth: false });
      } catch (error) {
        // The path answers 404 while Converter Studio has the add-on's sign-in switched off.
        if (error instanceof CsErrors.CsError && error.status === 404)
          throw new CsErrors.CsError('signInOff');
        throw error;
      }
      if (!answer || typeof answer.token !== 'string' || !(answer.expiresIn > 0))
        throw new CsErrors.CsError('notJson');
      return answer;
    }

    /** The formats the API reads and what each converts to. Needs no sign-in. */
    function formats() {
      return json('GET', '/v1/formats', undefined, { auth: false });
    }

    /** The signed-in account: e-mail, plan and credits. */
    function account() {
      return json('GET', '/v1/account');
    }

    /**
     * Sends a file: an upload slot (the API checks the plan's size limit before anything is
     * sent), then the bytes in one request, or in parts with `Upload-Offset` when the API asks
     * for smaller requests.
     * @param {{ getBytes: () => number[] }} blob an Apps Script Blob (or GmailAttachment)
     * @param {string} fileName
     * @param {number} [size] the file's size in bytes, when known without reading it
     * @returns {{ id: string, format: string | null }}
     */
    function upload(blob, fileName, size) {
      let bytes = null;
      const total = typeof size === 'number' && size >= 0 ? size : (bytes = blob.getBytes()).length;
      if (!(total > 0)) throw new CsErrors.CsError('sourceEmpty');
      if (total > CS_CONFIG.maxBytes) throw new CsErrors.CsError('sourceTooLarge');
      const slot = json('POST', '/v1/uploads', { fileName: uploadName(fileName), size: total });
      checkLink(slot.uploadUrl);
      const partBytes = slot.partBytes > 0 ? slot.partBytes : total;
      const putHeaders = { 'X-Converter-Studio-Client': clientHeader };
      if (total <= partBytes) {
        const receipt = sendPart(slot.uploadUrl, blob, putHeaders);
        if (receipt && receipt.status === 'ready')
          return { id: slot.id, format: (receipt.file && receipt.file.format) || null };
        throw new CsErrors.CsError('uploadIncomplete');
      }
      bytes = bytes || blob.getBytes();
      for (let offset = 0; offset < total;) {
        const part = bytes.slice(offset, Math.min(total, offset + partBytes));
        const receipt = sendPart(
          slot.uploadUrl,
          part,
          Object.assign({ 'Upload-Offset': String(offset) }, putHeaders),
        );
        offset += part.length;
        if (receipt && receipt.status === 'ready' && offset === total)
          return { id: slot.id, format: (receipt.file && receipt.file.format) || null };
        if (!receipt || receipt.status !== 'partial' || receipt.received !== offset) break;
      }
      throw new CsErrors.CsError('uploadIncomplete');
    }

    /** One upload request; the API overwrites a part sent twice, so a retry is safe. */
    function sendPart(uploadUrl, payload, headers) {
      const response = send(
        uploadUrl,
        { method: 'put', headers, contentType: 'application/octet-stream', payload },
        'uploadIncomplete',
        1,
      );
      try {
        return JSON.parse(response.getContentText());
      } catch {
        return null;
      }
    }

    /**
     * Starts converting an upload. Sent again after a lost answer with the same
     * `Idempotency-Key`, so a retry never makes a second conversion or a second charge.
     */
    function start(input) {
      const body = { uploadId: input.uploadId, to: input.to, maxCredits: input.maxCredits };
      if (input.options && Object.keys(input.options).length) body.options = input.options;
      return json('POST', '/v1/conversions', body, { idempotencyKey: options.newKey() });
    }

    /** A conversion's state; with `waitSeconds`, the API answers when it settles or the time is up. */
    function get(id, waitSeconds) {
      const room = Math.floor((remaining() - 3000) / 1000);
      const wait = Math.min(waitSeconds || 0, 60, room);
      const query = wait >= 1 ? '?wait=' + wait : '';
      return json('GET', '/v1/conversions/' + encodeURIComponent(id) + query, undefined, {
        timeoutSeconds: (wait >= 1 ? wait : 0) + 10,
      });
    }

    /** Goes ahead with a conversion that costs more than its `maxCredits` (status `quoted`). */
    function confirm(id) {
      return json('POST', '/v1/conversions/' + encodeURIComponent(id) + '/confirm');
    }

    /**
     * Waits for the conversion to settle (done, failed, expired, canceled or quoted) while the
     * add-on has time; returns its latest state either way.
     */
    function settle(view) {
      let current = view;
      while (!isSettled(current) && remaining() > 5000) {
        current = get(current.id, Math.floor((remaining() - 4000) / 1000));
      }
      return current;
    }

    /**
     * The converted file as an Apps Script Blob. The link carries its own token (the session is
     * not sent) and must be on the API's address.
     */
    function download(downloadUrl) {
      checkLink(downloadUrl);
      const response = send(
        downloadUrl,
        { method: 'get', headers: { 'X-Converter-Studio-Client': clientHeader } },
        'resultDownloadFailed',
        1,
      );
      const blob = response.getBlob();
      if (!blob || !blob.getBytes().length) throw new CsErrors.CsError('resultDownloadFailed');
      return blob;
    }

    return {
      baseUrl,
      origin,
      clientHeader,
      remaining,
      checkLink,
      exchange,
      formats,
      account,
      upload,
      start,
      get,
      confirm,
      settle,
      download,
    };
  }

  return { SETTLED, isSettled, uploadName, originOf, headerOf, createClient };
})();
