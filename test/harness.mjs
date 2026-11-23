/**
 * A Google account in a test tube: the add-on's scripts loaded as Apps Script loads them
 * (tools/load.mjs), with the fakes of test/fakes.mjs as its services, the fake Converter Studio
 * API of test/fake-api.mjs behind UrlFetchApp, and one clock for all of them. Triggers and button
 * clicks are called with the event objects Google documents (Event objects reference).
 */
import { loadAddOn } from '../tools/load.mjs';
import { ADA, AUDIENCE, SESSION, fakeApi } from './fake-api.mjs';
import {
  SCOPE,
  fakeCacheService,
  fakeCardService,
  fakeConsent,
  fakeDrive,
  fakeGmail,
  fakeIdToken,
  fakeProperties,
  fakePropertiesService,
  fakeScriptApp,
  fakeUrlFetch,
  fakeUtilities,
  render,
} from './fakes.mjs';

export { ADA, AUDIENCE, SCOPE, SESSION, render };
export const TOKEN = 'ya29.fake-oauth-token';

/** The user's properties when signed in with the fake API's starting session. */
export function signedIn(clock, extra = {}) {
  return {
    CS_SESSION: JSON.stringify({ token: SESSION, expiresAt: clock.now + 3600_000 }),
    ...extra,
  };
}

export const bytes = (text) => Buffer.from(text, 'utf8');

/** A message with a HEIC photo, a scanned PDF, an unknown file and an inline logo. */
export function defaultMessages() {
  return {
    m1: {
      token: 'gm-token-1',
      attachments: [
        { name: 'IMG_0001.HEIC', contentType: 'image/heic', bytes: bytes('heic bytes') },
        { name: 'scan.pdf', contentType: 'application/pdf', bytes: bytes('%PDF scanned') },
        { name: 'notes.xyz', contentType: 'application/octet-stream', bytes: bytes('?') },
        { name: 'logo.png', contentType: 'image/png', bytes: bytes('png'), inline: true },
      ],
    },
    slow: {
      token: 'gm-token-2',
      attachments: [
        { name: 'slow-video.mov', contentType: 'video/quicktime', bytes: bytes('mov') },
      ],
    },
    other: {
      token: 'gm-token-3',
      attachments: [
        { name: 'quote-long.mov', contentType: 'video/quicktime', bytes: bytes('mov') },
        { name: 'broken.docx', contentType: 'application/msword', bytes: bytes('docx') },
        { name: 'big-scan.pdf', contentType: 'application/pdf', bytes: bytes('%PDF') },
      ],
    },
  };
}

/** My Drive with a folder of photos, a read-only shared folder and a Google Doc. */
export function defaultDrive() {
  return {
    root: { name: 'My Drive', mimeType: 'application/vnd.google-apps.folder', writable: true },
    photos: {
      name: 'Photos',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root'],
      writable: true,
    },
    shared: {
      name: 'Shared with me',
      mimeType: 'application/vnd.google-apps.folder',
      writable: false,
    },
    heic: {
      name: 'beach.heic',
      mimeType: 'image/heic',
      bytes: bytes('heic'),
      parents: ['photos'],
      granted: true,
    },
    readonly: {
      name: 'report.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: bytes('docx'),
      parents: ['shared'],
      granted: true,
    },
    doc: {
      name: 'Plan',
      mimeType: 'application/vnd.google-apps.document',
      exportBytes: bytes('docx export'),
      parents: ['photos'],
      granted: true,
    },
    hugeDoc: {
      name: 'Huge',
      mimeType: 'application/vnd.google-apps.document',
      exportTooLarge: true,
      parents: ['photos'],
      granted: true,
    },
    secret: {
      name: 'secret.pdf',
      mimeType: 'application/pdf',
      bytes: bytes('%PDF'),
      parents: ['photos'],
    },
    toolarge: {
      name: 'film.mov',
      mimeType: 'video/quicktime',
      bytes: Buffer.alloc(51_000_000),
      parents: ['photos'],
      granted: true,
    },
  };
}

/**
 * The real clock, for runs against the real API: reading it is Date.now(), and moving it
 * forward (Utilities.sleep) really waits.
 */
export function realClock() {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  return {
    get now() {
      return Date.now();
    },
    set now(target) {
      const ms = target - Date.now();
      if (ms > 0) Atomics.wait(cell, 0, 0, ms);
    },
  };
}

/**
 * The add-on with its fake Google account.
 * @param {{ messages?: object, driveFiles?: object, user?: object, script?: object, partBytes?: number,
 *   allowlist?: string[], openLinkPrefixes?: string[], network?: (request: object) => object,
 *   clock?: object, identity?: () => string | null, granted?: string[] }} [options]
 *   `network` replaces the fake Converter Studio API (a run against the real API passes the real
 *   network); Drive's REST stays fake either way. `user`: the user's properties (default: signed
 *   in). `identity`: Google's identity token for the user (default: one for `w.google.account`,
 *   issued to AUDIENCE, an hour long, as Apps Script's was in a real account: no `azp`).
 *   `granted`: the scopes the user allowed on Google's consent screen (default: all of them).
 */
export function world(options = {}) {
  const clock = options.clock ?? { now: Date.UTC(2026, 10, 23, 9, 0, 0) };
  const consent = fakeConsent(options.granted);
  const api = fakeApi({ clock, partBytes: options.partBytes });
  const drive = fakeDrive(options.driveFiles ?? defaultDrive(), TOKEN, consent);
  const scope = { phase: 'trigger' };
  const gmail = fakeGmail(options.messages ?? defaultMessages(), scope, consent);
  const user = fakeProperties(options.user ?? signedIn(clock));
  /**
   * The Google account using the add-on; `granted: false`: Google gives no identity token although
   * `openid` is allowed. `claims`: added to (or, as undefined, removed from) the token's.
   */
  const google = { account: { ...ADA }, granted: true, tokens: 0, claims: {} };
  const identity =
    options.identity ??
    (() => {
      if (!google.granted) return null;
      google.tokens++;
      const now = Math.floor(clock.now / 1000);
      // Without `userinfo.email`, Google leaves the e-mail out of the token.
      const email = consent.has(SCOPE.email)
        ? { email: google.account.email, email_verified: true }
        : {};
      const claims = {
        iss: 'https://accounts.google.com',
        aud: AUDIENCE,
        sub: google.account.sub,
        ...email,
        iat: now,
        exp: now + 3600,
        ...google.claims,
      };
      return fakeIdToken(
        Object.fromEntries(Object.entries(claims).filter(([, v]) => v !== undefined)),
      );
    });
  const script = fakeProperties(options.script ?? {});
  const cache = fakeCacheService(clock);
  const net = fakeUrlFetch(
    (request) =>
      drive.rest(request) ??
      (options.network ? options.network(request) : api.handler(request)) ?? {
        status: 404,
        headers: {},
        body: 'not routed',
      },
    options.allowlist ? { allowlist: options.allowlist, consent } : { consent },
  );
  const logs = [];
  const log =
    (level) =>
    (...args) => {
      logs.push([level, args.join(' ')]);
      if (process.env.DEBUG_ADDON) console.error(level, ...args);
    };
  const addOn = loadAddOn({
    CardService: fakeCardService({ openLinkPrefixes: options.openLinkPrefixes }),
    UrlFetchApp: net.urlFetch,
    GmailApp: gmail.app,
    Drive: drive.service,
    PropertiesService: fakePropertiesService({ user, script }),
    CacheService: cache.service,
    Utilities: fakeUtilities(clock),
    ScriptApp: fakeScriptApp(TOKEN, identity, consent),
    console: { log: log('log'), info: log('info'), warn: log('warn'), error: log('error') },
  });
  // The scripts' clock is the shared one: a 90-second conversion takes no real time.
  if (!options.clock) addOn.get('Date').now = () => clock.now;

  const run = (phase, name, event) => {
    scope.phase = phase;
    if (typeof addOn.get(`typeof ${name} === 'function' ? ${name} : null`) !== 'function')
      throw new Error(`no function ${name} in the add-on`);
    return addOn.call(name, event);
  };
  return {
    addOn,
    api,
    consent,
    drive,
    gmail,
    google,
    user,
    script,
    cache,
    clock,
    logs,
    requests: net.requests,
    /** A trigger from appsscript.json (opening a message, selecting files, the homepage). */
    trigger: (name, event) => run('trigger', name, event),
    /** A button's callback, as Google calls it after a click. */
    click: (name, event) => run('action', name, event),
  };
}

/** The common event object, with a button's parameters and the card's inputs. */
function common(hostApp, params, inputs) {
  const formInputs = {};
  for (const [name, value] of Object.entries(inputs ?? {}))
    formInputs[name] = { stringInputs: { value: Array.isArray(value) ? value : [value] } };
  return { hostApp, platform: 'WEB', parameters: params ?? {}, formInputs };
}

export function gmailEvent({ messageId = 'm1', token, params, inputs } = {}) {
  const tokens = { m1: 'gm-token-1', slow: 'gm-token-2', other: 'gm-token-3' };
  return {
    commonEventObject: common('GMAIL', params, inputs),
    gmail: {
      messageId,
      threadId: 't-' + messageId,
      accessToken: token ?? tokens[messageId] ?? 'none',
    },
  };
}

export function driveEvent({ selected = [], params, inputs } = {}) {
  return {
    commonEventObject: common('DRIVE', params, inputs),
    drive: { selectedItems: selected, activeCursorItem: selected[0] },
  };
}

/** Drive's description of a selected item (Drive item object). */
export function item(w, id, access) {
  const f = w.drive.files[id];
  return {
    id,
    title: f.name,
    mimeType: f.mimeType,
    iconUrl: 'https://drive-thirdparty.googleusercontent.com/16/type/' + f.mimeType,
    addonHasFileScopePermission: access ?? Boolean(f.granted),
  };
}

/** The card a trigger or a button's response shows. */
export function cardOf(response) {
  const data = render(response);
  if (Array.isArray(data)) return data[0];
  if (data.kind === 'UniversalActionResponse') return data.cards[0];
  if (data.kind === 'ActionResponse' && data.navigation) {
    const ops = data.navigation.ops;
    return ops[ops.length - 1][1];
  }
  return null;
}

export function notificationOf(response) {
  const data = render(response);
  return data.notification ? data.notification.text : null;
}

/** Every button of a card: its text and what it does. */
export function buttons(card) {
  const out = [];
  const add = (b) => {
    if (!b) return;
    out.push({
      text: b.text,
      action: b.onClickAction ?? null,
      openLink: b.openLink?.url ?? null,
      compose: b.composeAction ? b.composeAction[0] : null,
    });
  };
  for (const section of card.sections ?? [])
    for (const w of section.widgets ?? []) {
      if (w.kind === 'TextButton') add(w);
      if (w.kind === 'ButtonSet') w.buttons.forEach(add);
      if (w.kind === 'DecoratedText') add(w.button);
    }
  if (card.fixedFooter) add(card.fixedFooter.primaryButton);
  return out;
}

export function button(card, text) {
  const found = buttons(card).filter((b) => b.text === text);
  if (found.length !== 1)
    throw new Error(
      `${found.length} buttons "${text}" in ${JSON.stringify(buttons(card).map((b) => b.text))}`,
    );
  return found[0];
}

/** All the text a card shows, for loose checks. */
export function textOf(card) {
  return JSON.stringify(card);
}

/** Every action function name used by the card exists in the add-on. */
export function actionNames(card) {
  return buttons(card)
    .map((b) => (b.action ?? b.compose)?.functionName)
    .filter(Boolean);
}
