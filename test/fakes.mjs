/**
 * Fakes of the Apps Script services the add-on calls, held to Google's documentation:
 *
 * - Every fake object has exactly the methods of its class in Google's reference
 *   (fixtures/apps-script-reference.json, read from developers.google.com): calling a method Google
 *   does not document throws, as it would in Apps Script.
 * - Arguments are checked as Apps Script checks them (strings where strings are required, action
 *   parameters as strings, UrlFetchApp's documented parameters and limits, the manifest's URL
 *   allowlists for fetching and for links).
 * - Gmail's current-message scope is enforced: with `gmail.addons.current.message.action`, the
 *   message's content can be read in a button's callback, not when a message is merely opened.
 *
 * What cannot be faked faithfully (how cards look, Google's own error texts, the 30-second limit
 * enforced by Google) has to be tried in a real Google account.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const REFERENCE = JSON.parse(
  readFileSync(new URL('./fixtures/apps-script-reference.json', import.meta.url), 'utf8'),
);
export const MANIFEST = JSON.parse(
  readFileSync(new URL('../src/appsscript.json', import.meta.url), 'utf8'),
);

/** State behind each fake object (never reachable from the add-on). */
const STATE = new WeakMap();
export const stateOf = (fake) => STATE.get(fake);

/** A fake with exactly the documented methods of `className`; anything else throws. */
export function strict(className, impl, state) {
  const cls = REFERENCE.classes[className];
  if (!cls) throw new Error(`no reference for ${className}`);
  const documented = new Set([...cls.methods, ...(cls.properties ?? [])]);
  const proxy = new Proxy(impl, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (!documented.has(prop))
        throw new TypeError(`${className}.${String(prop)} is not in Google's reference`);
      if (!(prop in target)) throw new Error(`the fake ${className} does not implement ${prop}`);
      return Reflect.get(target, prop, receiver);
    },
    set(_target, prop) {
      throw new TypeError(`${className}.${String(prop)} cannot be assigned`);
    },
  });
  STATE.set(proxy, state ?? { kind: className });
  return proxy;
}

const isString = (v) => typeof v === 'string';
function needString(className, method, value) {
  if (!isString(value)) throw new TypeError(`${className}.${method}: expected a string`);
}

// --- Blob ---------------------------------------------------------------------------------------

/** Apps Script's bytes: a JavaScript array of signed bytes (Java's byte[]). */
export const toSigned = (buffer) => Array.from(buffer, (b) => (b > 127 ? b - 256 : b));
export const fromSigned = (array) => Buffer.from(array.map((b) => b & 255));

export function fakeBlob(bytes, contentType = null, name = null, className = 'Blob', extra = {}) {
  const state = { kind: className, bytes: Buffer.from(bytes), contentType, name };
  let proxy;
  const impl = {
    getBytes: () => toSigned(state.bytes),
    getName: () => state.name,
    setName: (n) => {
      needString(className, 'setName', n);
      state.name = n;
      return proxy;
    },
    getContentType: () => state.contentType,
    setContentType: (t) => {
      state.contentType = t;
      return proxy;
    },
    getDataAsString: () => state.bytes.toString('utf8'),
    copyBlob: () => fakeBlob(state.bytes, state.contentType, state.name),
    ...extra,
  };
  proxy = strict(className, impl, state);
  return proxy;
}

/** Bytes of anything the add-on may pass as a body or an attachment. */
export function bytesOf(value) {
  const s = STATE.get(value);
  if (s && (s.kind === 'Blob' || s.kind === 'GmailAttachment')) return s.bytes;
  throw new TypeError('not a Blob');
}

// --- CardService --------------------------------------------------------------------------------

/** A widget or card as plain data, for the tests to read. */
export function render(value) {
  if (Array.isArray(value)) return value.map(render);
  const s = STATE.get(value);
  if (!s) return value;
  const out = {};
  for (const [k, v] of Object.entries(s)) out[k] = render(v);
  return out;
}

const WIDGETS = new Set([
  'TextParagraph',
  'DecoratedText',
  'TextButton',
  'ButtonSet',
  'TextInput',
  'SelectionInput',
  'Divider',
]);
const TEXT_SETTERS = new Set([
  'setText',
  'setTitle',
  'setSubtitle',
  'setTopLabel',
  'setBottomLabel',
  'setHint',
  'setValue',
  'setFieldName',
  'setFunctionName',
  'setUrl',
  'setName',
]);

/** Does `url` match one of the manifest's prefixes (Google's rules: same or a child path). */
export function matchesPrefix(url, prefixes) {
  return prefixes.some((prefix) => {
    if (prefix.includes('*')) {
      const [scheme, rest] = prefix.split('://');
      const re = new RegExp(
        '^' + scheme + '://[^/]+\\.' + rest.slice(2).replace(/[.?+^$()[\]{}|\\]/g, '\\$&'),
      );
      return re.test(url);
    }
    return url === prefix || url.startsWith(prefix);
  });
}

/**
 * A CardService builder: every documented `set…`/`add…` method records its arguments; checks
 * run when the card is built (as CardService's `build()` validates).
 */
function builder(className, overrides = () => ({})) {
  const state = { kind: className };
  let proxy;
  const impl = {};
  for (const method of REFERENCE.classes[className].methods) {
    if (method.startsWith('set')) {
      impl[method] = (...args) => {
        // A section's header is text; a card's is a CardHeader.
        if (TEXT_SETTERS.has(method) || (className === 'CardSection' && method === 'setHeader'))
          needString(className, method, args[0]);
        const key = method[3].toLowerCase() + method.slice(4);
        state[key] = args.length > 1 ? args : args[0];
        return proxy;
      };
    } else if (method.startsWith('add')) {
      impl[method] = (...args) => {
        const key = method[3].toLowerCase() + method.slice(4) + 's';
        (state[key] ??= []).push(args.length > 1 ? args : args[0]);
        return proxy;
      };
    }
  }
  Object.assign(
    impl,
    overrides(state, () => proxy),
  );
  proxy = strict(className, impl, state);
  return proxy;
}

function checkAction(action) {
  const s = STATE.get(action);
  if (!s || s.kind !== 'Action') throw new TypeError('expected an Action');
  if (!isString(s.functionName) || !s.functionName) throw new Error('Action: no function name');
  if (s.parameters !== undefined) {
    for (const [k, v] of Object.entries(s.parameters))
      if (!isString(v)) throw new TypeError(`Action parameter ${k} must be a string`);
  }
}

/** The manifest's link prefixes; a local run adds its test site (Google would refuse http). */
let linkPrefixes = MANIFEST.addOns.common.openLinkUrlPrefixes ?? [];

function checkOpenLink(link) {
  const s = STATE.get(link);
  if (!s || s.kind !== 'OpenLink' || !isString(s.url)) throw new Error('OpenLink: no URL');
  if (!matchesPrefix(s.url, linkPrefixes))
    throw new Error(`OpenLink ${s.url} matches no openLinkUrlPrefixes entry`);
}

function checkButton(button) {
  const s = STATE.get(button);
  if (!s || s.kind !== 'TextButton') throw new TypeError('expected a TextButton');
  if (!isString(s.text) || !s.text) throw new Error('TextButton: no text');
  const handlers = ['onClickAction', 'openLink', 'composeAction', 'authorizationAction'].filter(
    (k) => s[k] !== undefined,
  );
  if (handlers.length !== 1) throw new Error(`TextButton "${s.text}": ${handlers.length} handlers`);
  if (s.iconUrl !== undefined && !/^https:\/\/\S+$/.test(s.iconUrl))
    throw new Error(`TextButton "${s.text}": the icon must be a public https URL`);
  if (s.onClickAction) checkAction(s.onClickAction);
  if (s.openLink) checkOpenLink(s.openLink);
  if (s.composeAction) checkAction(s.composeAction[0]);
}

function checkWidget(widget) {
  const s = STATE.get(widget);
  if (!s || !WIDGETS.has(s.kind)) throw new TypeError('not a widget');
  switch (s.kind) {
    case 'TextParagraph':
      if (!isString(s.text) || !s.text) throw new Error('TextParagraph: no text');
      // Links in text open like OpenLinks: on the manifest's prefixes only.
      for (const [, url] of s.text.matchAll(/<a href="([^"]*)">/g))
        if (!matchesPrefix(url, linkPrefixes))
          throw new Error(`link ${url} matches no openLinkUrlPrefixes entry`);
      break;
    case 'DecoratedText':
      if (!isString(s.text) || !s.text) throw new Error('DecoratedText: no text');
      if (s.button) checkButton(s.button);
      break;
    case 'TextButton':
      checkButton(widget);
      break;
    case 'ButtonSet':
      if (!s.buttons?.length) throw new Error('ButtonSet: no buttons');
      s.buttons.forEach(checkButton);
      break;
    case 'TextInput':
      if (!s.fieldName) throw new Error('TextInput: no field name');
      if (!s.title) throw new Error('TextInput: no title');
      break;
    case 'SelectionInput':
      if (!s.fieldName) throw new Error('SelectionInput: no field name');
      if (!s.items?.length) throw new Error('SelectionInput: no items');
      for (const [text, value, selected] of s.items) {
        if (!isString(text) || !isString(value) || typeof selected !== 'boolean')
          throw new TypeError('SelectionInput.addItem(text, value, selected)');
      }
      break;
  }
}

function checkCard(card) {
  const s = STATE.get(card);
  if (!s || s.kind !== 'Card') throw new TypeError('expected a built Card');
}

export function fakeCardService({ openLinkPrefixes } = {}) {
  linkPrefixes = openLinkPrefixes ?? MANIFEST.addOns.common.openLinkUrlPrefixes ?? [];
  const enums = {};
  for (const [name, members] of Object.entries(REFERENCE.enums)) {
    const values = Object.fromEntries(members.map((m) => [m, `${name}.${m}`]));
    enums[name] = new Proxy(values, {
      get(t, p) {
        if (typeof p === 'symbol') return t[p];
        if (!(p in t)) throw new TypeError(`CardService.${name}.${String(p)} does not exist`);
        return t[p];
      },
    });
  }
  const cardBuilder = () =>
    builder('CardBuilder', (state) => ({
      build: () => {
        if (!state.sections?.length) throw new Error('Card: at least one section');
        for (const section of state.sections) {
          const ss = STATE.get(section);
          if (!ss || ss.kind !== 'CardSection') throw new TypeError('expected a CardSection');
          if (!ss.widgets?.length) throw new Error('CardSection: at least one widget');
          ss.widgets.forEach(checkWidget);
        }
        if (state.header && !STATE.get(state.header).title) throw new Error('CardHeader: no title');
        if (state.fixedFooter) checkButton(STATE.get(state.fixedFooter).primaryButton);
        const card = strict('ActionResponse', {}, { ...state, kind: 'Card' });
        return card;
      },
    }));
  const impl = {
    ...enums,
    newCardBuilder: cardBuilder,
    newCardHeader: () => builder('CardHeader'),
    newCardSection: () => builder('CardSection'),
    newTextParagraph: () => builder('TextParagraph'),
    newDecoratedText: () => builder('DecoratedText'),
    newTextButton: () => builder('TextButton'),
    newButtonSet: () => builder('ButtonSet'),
    newTextInput: () => builder('TextInput'),
    newSelectionInput: () => builder('SelectionInput'),
    newDivider: () => builder('Divider'),
    newFixedFooter: () => builder('FixedFooter'),
    newAction: () => builder('Action'),
    newOpenLink: () => builder('OpenLink'),
    newNotification: () => builder('Notification'),
    newNavigation: () =>
      builder('Navigation', (state, self) => {
        const op = (name) => (card) => {
          if (card !== undefined) checkCard(card);
          (state.ops ??= []).push(card === undefined ? [name] : [name, card]);
          return self();
        };
        return {
          pushCard: op('pushCard'),
          updateCard: op('updateCard'),
          popCard: op('popCard'),
          popToRoot: op('popToRoot'),
        };
      }),
    newActionResponseBuilder: () =>
      builder('ActionResponseBuilder', (state) => ({
        build: () => {
          if (!state.navigation && !state.notification && !state.openLink)
            throw new Error('ActionResponse: nothing to do');
          if (state.notification && !STATE.get(state.notification).text)
            throw new Error('Notification: no text');
          if (state.openLink) checkOpenLink(state.openLink);
          return strict('ActionResponse', {}, { ...state, kind: 'ActionResponse' });
        },
      })),
    newUniversalActionResponseBuilder: () =>
      builder('UniversalActionResponseBuilder', (state, self) => ({
        displayAddOnCards: (cards) => {
          if (!Array.isArray(cards) || !cards.length)
            throw new TypeError('displayAddOnCards(Card[])');
          cards.forEach(checkCard);
          state.cards = cards;
          return self();
        },
        build: () =>
          strict('UniversalActionResponse', {}, { ...state, kind: 'UniversalActionResponse' }),
      })),
    newComposeActionResponseBuilder: () =>
      builder('ComposeActionResponseBuilder', (state, self) => ({
        setGmailDraft: (draft) => {
          if (STATE.get(draft)?.kind !== 'GmailDraft')
            throw new TypeError('setGmailDraft(GmailDraft)');
          state.gmailDraft = draft;
          return self();
        },
        build: () => {
          if (!state.gmailDraft) throw new Error('ComposeActionResponse: no draft');
          return strict('ActionResponse', {}, { ...state, kind: 'ComposeActionResponse' });
        },
      })),
    newDriveItemsSelectedActionResponseBuilder: () =>
      builder('DriveItemsSelectedActionResponseBuilder', (state, self) => ({
        requestFileScope: (id) => {
          needString('DriveItemsSelectedActionResponseBuilder', 'requestFileScope', id);
          state.requestFileScope = id;
          return self();
        },
        build: () =>
          strict('ActionResponse', {}, { ...state, kind: 'DriveItemsSelectedActionResponse' }),
      })),
  };
  return strict('CardService', impl);
}

// --- Properties and cache -----------------------------------------------------------------------

export function fakeProperties(initial = {}) {
  const map = new Map(Object.entries(initial));
  let proxy;
  const impl = {
    getProperty: (k) => (map.has(k) ? map.get(k) : null),
    setProperty: (k, v) => {
      needString('Properties', 'setProperty', k);
      const value = String(v);
      // Quotas: 9 KB a value, 500 KB a store.
      if (Buffer.byteLength(value) > 9 * 1024) throw new Error('Properties: value over 9 KB');
      map.set(k, value);
      return proxy;
    },
    deleteProperty: (k) => {
      map.delete(k);
      return proxy;
    },
    getProperties: () => Object.fromEntries(map),
    getKeys: () => [...map.keys()],
  };
  proxy = strict('Properties', impl, { kind: 'Properties', map });
  return proxy;
}

export function fakePropertiesService({ user, script }) {
  return strict('PropertiesService', {
    getUserProperties: () => user,
    getScriptProperties: () => script,
  });
}

export function fakeCacheService(clock) {
  const map = new Map();
  const cache = strict('Cache', {
    get: (key) => {
      const hit = map.get(key);
      return hit && hit.until > clock.now ? hit.value : null;
    },
    put: (key, value, seconds = 600) => {
      if (key.length > 250) throw new Error('Cache: key over 250 characters');
      if (Buffer.byteLength(value) > 100 * 1024) throw new Error('Cache: value over 100 KB');
      if (seconds > 21600) throw new Error('Cache: at most 21600 seconds');
      map.set(key, { value, until: clock.now + seconds * 1000 });
    },
    remove: (key) => map.delete(key),
  });
  return { service: strict('CacheService', { getScriptCache: () => cache }), map };
}

// --- UrlFetchApp --------------------------------------------------------------------------------

const FETCH_PARAMS = new Set([
  'contentType',
  'headers',
  'method',
  'payload',
  'useIntranet',
  'validateHttpsCertificates',
  'followRedirects',
  'muteHttpExceptions',
  'escaping',
  'timeoutSeconds',
]);
const METHODS = new Set(['get', 'delete', 'patch', 'post', 'put']);
const LIMIT = 50 * 1024 * 1024;

/**
 * UrlFetchApp over a handler `({ method, url, headers, body, timeoutSeconds }) → { status,
 * headers, body }` (or a thrown `{ network: true }` for a lost connection).
 */
export function fakeUrlFetch(handler, { allowlist = MANIFEST.urlFetchWhitelist ?? [] } = {}) {
  const requests = [];
  const fetch = (url, params = {}) => {
    needString('UrlFetchApp', 'fetch', url);
    for (const key of Object.keys(params))
      if (!FETCH_PARAMS.has(key))
        throw new TypeError(`UrlFetchApp.fetch: unknown parameter ${key}`);
    const method = params.method ?? 'get';
    if (!METHODS.has(method)) throw new TypeError(`UrlFetchApp.fetch: method ${method}`);
    if (!matchesPrefix(url, allowlist)) throw new Error(`URL not in urlFetchWhitelist: ${url}`);
    if (url.length > 2048) throw new Error('UrlFetchApp: URL over 2 KB');
    const headers = { ...(params.headers ?? {}) };
    if (Object.keys(headers).length > 100) throw new Error('UrlFetchApp: over 100 headers');
    if (Buffer.byteLength(JSON.stringify(headers)) > 8 * 1024)
      throw new Error('UrlFetchApp: headers over 8 KB');
    for (const [k, v] of Object.entries(headers))
      if (!isString(v)) throw new TypeError(`UrlFetchApp: header ${k} is not a string`);
    let body = null;
    if (params.payload !== undefined) {
      if (method === 'get') throw new Error('UrlFetchApp: GET takes no payload');
      const p = params.payload;
      if (isString(p)) body = Buffer.from(p, 'utf8');
      else if (Array.isArray(p)) body = fromSigned(p);
      else if (STATE.get(p)?.kind === 'Blob') body = bytesOf(p);
      else throw new TypeError('UrlFetchApp: the add-on sends strings, byte arrays or Blobs only');
      if (body.length > LIMIT) throw new Error('UrlFetchApp: payload over 50 MB');
      headers['Content-Type'] = params.contentType ?? 'application/x-www-form-urlencoded';
    }
    const request = {
      method: method.toUpperCase(),
      url,
      headers,
      body,
      timeoutSeconds: params.timeoutSeconds ?? 360,
      followRedirects: params.followRedirects ?? true,
      muteHttpExceptions: params.muteHttpExceptions ?? false,
    };
    requests.push(request);
    let res;
    try {
      res = handler(request);
    } catch (error) {
      if (error?.network)
        throw new Error('Exception: Address unavailable: ' + url, { cause: error });
      throw error;
    }
    const resBody = Buffer.isBuffer(res.body)
      ? res.body
      : Buffer.from(isString(res.body) ? res.body : JSON.stringify(res.body ?? ''), 'utf8');
    if (resBody.length > LIMIT) throw new Error('Exception: response over 50 MB');
    if (!request.muteHttpExceptions && res.status >= 400)
      throw new Error(`Exception: Request failed for ${url} returned code ${res.status}`);
    return httpResponse(res.status, res.headers ?? {}, resBody);
  };
  return { urlFetch: strict('UrlFetchApp', { fetch }), requests };
}

function httpResponse(status, headers, body) {
  const contentType =
    Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? null;
  return strict('HTTPResponse', {
    getResponseCode: () => status,
    getContentText: () => body.toString('utf8'),
    getContent: () => toSigned(body),
    getBlob: () => fakeBlob(body, contentType ? contentType.split(';')[0] : null, null),
    getHeaders: () => ({ ...headers }),
    getAllHeaders: () => ({ ...headers }),
  });
}

// --- Gmail --------------------------------------------------------------------------------------

/**
 * GmailApp over `messages` ({ [id]: { token, attachments: [{ name, bytes, contentType, inline }] } }).
 * `scope.phase` is 'trigger' while a contextual trigger runs and 'action' in a button's callback.
 */
export function fakeGmail(messages, scope) {
  let current = null;
  const drafts = [];
  const attachmentFake = (a) =>
    fakeBlob(a.bytes, a.contentType, a.name, 'GmailAttachment', {
      getSize: () => a.bytes.length,
      getHash: () => createHash('sha1').update(a.bytes).digest('hex'),
    });
  const messageFake = (id, m) =>
    strict('GmailMessage', {
      getId: () => id,
      getAttachments: (options = {}) => {
        // gmail.addons.current.message.action: content only "upon user interaction".
        if (scope.phase !== 'action')
          throw new Error('Access denied: the message is readable only after a click');
        const inline = options.includeInlineImages !== false;
        const regular = options.includeAttachments !== false;
        return m.attachments.filter((a) => (a.inline ? inline : regular)).map(attachmentFake);
      },
      createDraftReply: (body, options = {}) => {
        if (scope.phase !== 'action') throw new Error('Access denied: drafts only from a click');
        needString('GmailMessage', 'createDraftReply', body);
        const known = [
          'attachments',
          'bcc',
          'cc',
          'from',
          'htmlBody',
          'inlineImages',
          'name',
          'replyTo',
          'subject',
        ];
        for (const k of Object.keys(options))
          if (!known.includes(k)) throw new TypeError(`createDraftReply: unknown option ${k}`);
        const attachments = (options.attachments ?? []).map((b) => {
          const s = STATE.get(b);
          if (!s || (s.kind !== 'Blob' && s.kind !== 'GmailAttachment'))
            throw new TypeError('attachments: BlobSource[]');
          return { name: s.name, contentType: s.contentType, bytes: s.bytes };
        });
        const draft = { id: 'r' + (drafts.length + 1), replyTo: id, body, attachments };
        drafts.push(draft);
        return strict('GmailDraft', { getId: () => draft.id }, { kind: 'GmailDraft', ...draft });
      },
    });
  const app = strict('GmailApp', {
    setCurrentMessageAccessToken: (token) => {
      needString('GmailApp', 'setCurrentMessageAccessToken', token);
      current = token;
    },
    getMessageById: (id) => {
      const m = messages[id];
      if (!m) return null;
      if (current !== m.token) throw new Error('Access denied: missing the message access token');
      return messageFake(id, m);
    },
  });
  return { app, drafts };
}

// --- Drive (advanced service, v3) and Drive's REST for file bytes ------------------------------

const FOLDER = 'application/vnd.google-apps.folder';
const DRIVE_GET_ARGS = new Set([
  'fields',
  'supportsAllDrives',
  'acknowledgeAbuse',
  'includeLabels',
  'includePermissionsForView',
]);
const DRIVE_CREATE_ARGS = new Set([
  'fields',
  'supportsAllDrives',
  'ignoreDefaultVisibility',
  'keepRevisionForever',
  'ocrLanguage',
  'useContentAsIndexableText',
  'uploadType',
  'enforceSingleParent',
  'includeLabels',
  'includePermissionsForView',
]);
const DRIVE_LIST_ARGS = new Set([
  'q',
  'fields',
  'pageSize',
  'pageToken',
  'spaces',
  'orderBy',
  'corpora',
  'driveId',
  'includeItemsFromAllDrives',
  'supportsAllDrives',
]);

/**
 * Drive with `drive.file`: the add-on sees the files it was granted (`granted: true`) and the ones
 * it made; it may add files to any folder the user can write to (`writable`), as Converter
 * Studio's Drive app found on 2026-11-21.
 * @param {Record<string, { name: string, mimeType: string, bytes?: Buffer, parents?: string[], granted?: boolean, writable?: boolean, exportBytes?: Buffer, exportTooLarge?: boolean }>} files
 */
export function fakeDrive(files, token) {
  let next = 1;
  const visible = (f) => f && (f.granted || f.byApp) && !f.deleted;
  const pick = (f, fields) => {
    const all = {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.bytes ? String(f.bytes.length) : undefined,
      parents: f.parents,
      trashed: Boolean(f.trashed),
      webViewLink: `https://drive.google.com/file/d/${f.id}/view?usp=drivesdk`,
    };
    const wanted = String(fields ?? 'id,name,mimeType').split(',');
    return Object.fromEntries(wanted.filter((k) => all[k] !== undefined).map((k) => [k, all[k]]));
  };
  const error = (call, message) =>
    new Error(
      `GoogleJsonResponseException: API call to drive.files.${call} failed with error: ${message}`,
    );
  const check = (args, allowed, call) => {
    for (const k of Object.keys(args ?? {}))
      if (!allowed.has(k)) throw new TypeError(`Drive.Files.${call}: unknown argument ${k}`);
  };
  for (const [id, f] of Object.entries(files)) f.id = id;
  const Files = {
    get: (id, args) => {
      check(args, DRIVE_GET_ARGS, 'get');
      const f = files[id];
      if (!visible(f)) throw error('get', `File not found: ${id}.`);
      return pick(f, args?.fields);
    },
    create: (resource, blob, args) => {
      check(args, DRIVE_CREATE_ARGS, 'create');
      const parent = resource.parents?.[0] ?? 'root';
      const folder = files[parent];
      if (!folder || folder.mimeType !== FOLDER)
        throw error('create', `File not found: ${parent}.`);
      if (folder.writable === false)
        throw error('create', 'Insufficient permissions for the specified parent.');
      const id = 'new' + next++;
      const bytes = blob === undefined ? undefined : bytesOf(blob);
      files[id] = {
        id,
        name: resource.name,
        mimeType:
          resource.mimeType ?? (blob ? STATE.get(blob).contentType : 'application/octet-stream'),
        bytes,
        parents: [parent],
        byApp: true,
      };
      return pick(files[id], args?.fields);
    },
    list: (args) => {
      check(args, DRIVE_LIST_ARGS, 'list');
      const q = String(args?.q ?? '');
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
      const mime = /mimeType = '([^']*)'/.exec(q)?.[1];
      const inRoot = /'root' in parents/.test(q);
      const found = Object.values(files).filter(
        (f) =>
          visible(f) &&
          !f.trashed &&
          (name === undefined || f.name === name) &&
          (mime === undefined || f.mimeType === mime) &&
          (!inRoot || f.parents?.includes('root')),
      );
      return { files: found.slice(0, args?.pageSize ?? 100).map((f) => ({ id: f.id })) };
    },
  };
  /** Drive's REST for bytes (`alt=media`, `export`), reached through UrlFetchApp. */
  const rest = (request) => {
    const match =
      /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)(\/export)?\?(.*)$/.exec(
        request.url,
      );
    if (!match) return null;
    if (request.headers.Authorization !== `Bearer ${token}`)
      return {
        status: 401,
        headers: {},
        body: { error: { code: 401, message: 'Invalid Credentials' } },
      };
    const f = files[decodeURIComponent(match[1])];
    if (!visible(f))
      return {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
        body: { error: { code: 404, errors: [{ reason: 'notFound' }] } },
      };
    const query = new URLSearchParams(match[3]);
    if (match[2]) {
      if (!f.mimeType.startsWith('application/vnd.google-apps.'))
        return {
          status: 403,
          headers: {},
          body: { error: { errors: [{ reason: 'fileNotExportable' }] } },
        };
      if (f.exportTooLarge)
        return {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
          body: { error: { code: 403, errors: [{ reason: 'exportSizeLimitExceeded' }] } },
        };
      return {
        status: 200,
        headers: { 'Content-Type': query.get('mimeType') },
        body: f.exportBytes,
      };
    }
    if (query.get('alt') !== 'media') return { status: 400, headers: {}, body: '' };
    return { status: 200, headers: { 'Content-Type': f.mimeType }, body: f.bytes };
  };
  return { service: { Files }, files, rest };
}

// --- Utilities and ScriptApp --------------------------------------------------------------------

export function fakeUtilities(clock) {
  return strict('Utilities', {
    getUuid: () => randomUUID(),
    sleep: (ms) => {
      if (typeof ms !== 'number') throw new TypeError('Utilities.sleep(milliseconds)');
      clock.now += ms;
    },
    newBlob: (data, contentType = null, name = null) =>
      fakeBlob(isString(data) ? Buffer.from(data, 'utf8') : fromSigned(data), contentType, name),
  });
}

/**
 * ScriptApp: the add-on's own OAuth token (for Drive) and Google's identity token for the user,
 * from `identity()` (null, as Google answers, when the `openid` scope is not in the manifest).
 */
export function fakeScriptApp(token, identity = () => null) {
  const hasOpenId = (MANIFEST.oauthScopes ?? []).includes('openid');
  return strict('ScriptApp', {
    getOAuthToken: () => token,
    getIdentityToken: () => (hasOpenId ? identity() : null),
  });
}

/**
 * Google's identity token for a user, as the fake API reads it: a JWT's shape (header, claims,
 * signature), unsigned. Real tokens are checked by the real API (e2e/run.mjs).
 */
export function fakeIdToken(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', kid: 'fake', typ: 'JWT' })}.${part(claims)}.fake-signature`;
}
