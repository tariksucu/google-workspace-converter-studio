#!/usr/bin/env node
/**
 * Checks src/appsscript.json against Google's published manifest reference (Google publishes no
 * JSON Schema for it; SchemaStore's community schema is out of date, e.g. it spells the homepage
 * trigger's field "runFunctions"). The rules below are taken from:
 *
 * - Manifest structure: https://developers.google.com/apps-script/manifest
 * - Add-ons, Gmail, Drive resources: https://developers.google.com/apps-script/manifest/addons,
 *   .../manifest/gmail-addons, .../manifest/drive-addons
 * - Allowlists: https://developers.google.com/apps-script/manifest/allowlist-url
 * - Scopes: https://developers.google.com/workspace/add-ons/concepts/workspace-scopes,
 *   https://developers.google.com/workspace/gmail/api/auth/scopes,
 *   https://developers.google.com/workspace/drive/api/guides/api-specific-auth
 * - Marketplace review criteria: https://developers.google.com/workspace/marketplace/about-app-review
 *
 * All read 2026-11-23. Usage: node tools/validate-manifest.mjs [path]; exits 1 on an error.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Every scope the add-on may ask for, with Google's sensitivity class and where it says so.
 * `null`: no Google page states a class (the Cloud console shows it on the Data access page).
 */
export const SCOPES = {
  'https://www.googleapis.com/auth/gmail.addons.execute': {
    use: "Run as a Gmail add-on (as in Google's own Gmail samples: Cats quickstart, QR code)",
    class: null,
  },
  'https://www.googleapis.com/auth/gmail.addons.current.message.action': {
    use: "Read the open message's attachments after the user clicks Show attachments",
    class: 'non-sensitive',
    source: 'Gmail API scopes page, "Non-sensitive scopes"',
  },
  'https://www.googleapis.com/auth/gmail.addons.current.action.compose': {
    use: 'Create the reply draft with the converted file attached',
    class: 'non-sensitive',
    source: 'Gmail API scopes page, "Non-sensitive scopes"',
  },
  'https://www.googleapis.com/auth/drive.addons.metadata.readonly': {
    use: "The selected Drive item's id, title and type (the contextual card)",
    class: null,
  },
  'https://www.googleapis.com/auth/drive.file': {
    use: 'Read a file the user allowed, and save results',
    class: 'non-sensitive',
    source: 'Drive API scopes page, "Non-sensitive scopes"',
  },
  'https://www.googleapis.com/auth/script.external_request': {
    use: 'UrlFetchApp: Converter Studio API, and Drive file bytes',
    class: 'sensitive',
    source:
      'not on a Google docs page; the Cloud console classes it sensitive (reported on Google Cloud Community, Oct 2026)',
  },
  openid: {
    use: "Sign in: ScriptApp.getIdentityToken() (Google's ID token for the user) needs it",
    class: 'non-sensitive',
    source:
      'Sensitive scope verification page: "scopes that are necessary for Google Sign-In are pre-filled in the Non-sensitive scopes section"',
  },
  'https://www.googleapis.com/auth/userinfo.email': {
    use: "Sign in: puts the user's verified e-mail address in the ID token (the account's e-mail)",
    class: 'non-sensitive',
    source:
      'Sensitive scope verification page: "scopes that are necessary for Google Sign-In are pre-filled in the Non-sensitive scopes section"',
  },
};

/** Scopes Google calls broad or restricted, which this add-on must never ask for. */
const FORBIDDEN = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.metadata',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.metadata',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
];

const TOP = [
  'addOns',
  'chat',
  'dependencies',
  'exceptionLogging',
  'executionApi',
  'oauthScopes',
  'runtimeVersion',
  'sheets',
  'timeZone',
  'urlFetchWhitelist',
  'webapp',
];
const ADDONS = ['common', 'calendar', 'chat', 'drive', 'gmail', 'docs', 'sheets', 'slides', 'meet'];
const COMMON = [
  'homepageTrigger',
  'layoutProperties',
  'logoUrl',
  'name',
  'openLinkUrlPrefixes',
  'universalActions',
  'useLocaleFromApp',
];
const GMAIL = [
  'authorizationCheckFunction',
  'composeTrigger',
  'contextualTriggers',
  'homepageTrigger',
];
const DRIVE = ['homepageTrigger', 'onItemsSelectedTrigger'];

/** Google's allowlist rules: https, a full domain, a non-empty path, one leading wildcard at most. */
export function prefixProblems(prefix, { wildcard }) {
  const problems = [];
  const m = /^https:\/\/([^/]+)(\/.*)$/.exec(prefix);
  if (!m) return [`${prefix}: must be https:// with a non-empty path (https://example.com/)`];
  const host = m[1];
  if ((host.match(/\*/g) ?? []).length > 1) problems.push(`${prefix}: one wildcard at most`);
  if (host.includes('*') && !host.startsWith('*.'))
    problems.push(`${prefix}: the wildcard must lead the domain`);
  if (host.includes('*') && !wildcard)
    problems.push(`${prefix}: no wildcards in UrlFetch allowlists (review criteria)`);
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(host))
    problems.push(`${prefix}: needs a full domain`);
  return problems;
}

/**
 * @param {object} manifest
 * @param {{ functions?: Set<string> }} [options] the add-on's top-level functions, to check names
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validate(manifest, { functions } = {}) {
  const errors = [];
  const warnings = [];
  const unknown = (obj, allowed, where) => {
    for (const k of Object.keys(obj ?? {}))
      if (!allowed.includes(k)) errors.push(`${where}.${k}: not in Google's reference`);
  };
  const fn = (name, where) => {
    if (typeof name !== 'string' || !name) errors.push(`${where}: a function name is required`);
    else if (functions && !functions.has(name))
      errors.push(`${where}: no function ${name} in src/`);
  };

  unknown(manifest, TOP, 'manifest');
  if (manifest.runtimeVersion !== 'V8') errors.push('runtimeVersion: V8 (the code uses V8 syntax)');
  if (!['NONE', 'STACKDRIVER', undefined].includes(manifest.exceptionLogging))
    errors.push('exceptionLogging: NONE or STACKDRIVER');
  if (
    typeof manifest.timeZone !== 'string' ||
    !Intl.supportedValuesOf('timeZone').concat('Etc/UTC').includes(manifest.timeZone)
  )
    errors.push('timeZone: a ZoneId such as "Etc/UTC"');

  for (const s of manifest.dependencies?.enabledAdvancedServices ?? []) {
    for (const k of ['userSymbol', 'serviceId', 'version'])
      if (typeof s[k] !== 'string') errors.push(`enabledAdvancedServices: ${k} missing`);
  }

  const scopes = manifest.oauthScopes ?? [];
  if (!scopes.length)
    errors.push('oauthScopes: list the scopes (Marketplace SDK and consent screen must match)');
  if (new Set(scopes).size !== scopes.length) errors.push('oauthScopes: duplicates');
  for (const s of scopes) {
    if (FORBIDDEN.includes(s)) errors.push(`oauthScopes: ${s} is broader than the add-on needs`);
    else if (!SCOPES[s])
      errors.push(
        `oauthScopes: ${s} is not one this add-on explains (tools/validate-manifest.mjs SCOPES)`,
      );
  }

  const fetchList = manifest.urlFetchWhitelist;
  if (!Array.isArray(fetchList) || !fetchList.length)
    errors.push('urlFetchWhitelist: required for a versioned deployment');
  for (const p of fetchList ?? []) errors.push(...prefixProblems(p, { wildcard: false }));

  const addOns = manifest.addOns;
  if (!addOns) {
    errors.push('addOns: missing');
    return { errors, warnings };
  }
  unknown(addOns, ADDONS, 'addOns');
  const common = addOns.common ?? {};
  unknown(common, COMMON, 'addOns.common');
  if (typeof common.name !== 'string' || !common.name) errors.push('addOns.common.name: required');
  else if (common.name.length > 50)
    errors.push('addOns.common.name: 50 characters at most (listing rule)');
  if (typeof common.logoUrl !== 'string' || !/^https:\/\//.test(common.logoUrl))
    errors.push('addOns.common.logoUrl: a public https URL is required');
  if (common.homepageTrigger) {
    unknown(common.homepageTrigger, ['runFunction', 'enabled'], 'addOns.common.homepageTrigger');
    fn(common.homepageTrigger.runFunction, 'addOns.common.homepageTrigger.runFunction');
  } else warnings.push('addOns.common.homepageTrigger: none (review: "The add-on has a homepage")');
  for (const color of ['primaryColor', 'secondaryColor'])
    if (
      common.layoutProperties?.[color] !== undefined &&
      !/^#[0-9a-f]{6}$/i.test(common.layoutProperties[color])
    )
      errors.push(`layoutProperties.${color}: #rrggbb`);
  const links = common.openLinkUrlPrefixes ?? [];
  for (const p of links) errors.push(...prefixProblems(p, { wildcard: true }));
  for (const [i, a] of (common.universalActions ?? []).entries()) {
    unknown(a, ['label', 'openLink', 'runFunction'], `universalActions[${i}]`);
    if (typeof a.label !== 'string' || !a.label)
      errors.push(`universalActions[${i}].label: required`);
    if ((a.openLink === undefined) === (a.runFunction === undefined))
      errors.push(`universalActions[${i}]: openLink or runFunction, one of them`);
    if (a.runFunction !== undefined) fn(a.runFunction, `universalActions[${i}].runFunction`);
    if (a.openLink !== undefined && !links.some((p) => a.openLink.startsWith(p)))
      errors.push(`universalActions[${i}].openLink: matches no openLinkUrlPrefixes entry`);
  }

  if (addOns.gmail) {
    unknown(addOns.gmail, GMAIL, 'addOns.gmail');
    const triggers = addOns.gmail.contextualTriggers;
    if (!Array.isArray(triggers) || triggers.length !== 1)
      errors.push('gmail.contextualTriggers: required, exactly one trigger');
    for (const [i, t] of (triggers ?? []).entries()) {
      unknown(t, ['onTriggerFunction', 'unconditional'], `gmail.contextualTriggers[${i}]`);
      fn(t.onTriggerFunction, `gmail.contextualTriggers[${i}].onTriggerFunction`);
      if (!t.unconditional || Object.keys(t.unconditional).length)
        errors.push(`gmail.contextualTriggers[${i}].unconditional: must be {}`);
    }
    if (addOns.gmail.authorizationCheckFunction)
      errors.push('gmail.authorizationCheckFunction: deprecated');
    if (!scopes.includes('https://www.googleapis.com/auth/gmail.addons.execute'))
      errors.push('oauthScopes: a Gmail add-on runs with gmail.addons.execute');
  }
  if (addOns.drive) {
    unknown(addOns.drive, DRIVE, 'addOns.drive');
    if (addOns.drive.onItemsSelectedTrigger) {
      unknown(addOns.drive.onItemsSelectedTrigger, ['runFunction'], 'drive.onItemsSelectedTrigger');
      fn(
        addOns.drive.onItemsSelectedTrigger.runFunction,
        'drive.onItemsSelectedTrigger.runFunction',
      );
      if (!scopes.includes('https://www.googleapis.com/auth/drive.addons.metadata.readonly'))
        errors.push('oauthScopes: selected-item cards need drive.addons.metadata.readonly');
      if (!scopes.includes('https://www.googleapis.com/auth/drive.file'))
        errors.push('oauthScopes: asking for a file (requestFileScope) needs drive.file');
    }
  }
  if (
    fetchList?.length &&
    !scopes.includes('https://www.googleapis.com/auth/script.external_request')
  )
    errors.push('oauthScopes: UrlFetchApp needs script.external_request');
  // Signing in with Google (src/Session.js): ScriptApp.getIdentityToken() gives nothing without
  // `openid`, and a token without the e-mail without `userinfo.email`.
  if (!scopes.includes('openid'))
    errors.push('oauthScopes: signing in (ScriptApp.getIdentityToken) needs openid');
  if (!scopes.includes('https://www.googleapis.com/auth/userinfo.email'))
    errors.push("oauthScopes: signing in needs the account's e-mail (userinfo.email)");
  return { errors, warnings };
}

/** The scopes as a table: scope, Google's class, what the add-on uses it for. */
export function scopeTable(manifest) {
  return (manifest.oauthScopes ?? []).map((s) => ({
    scope: s.replace('https://www.googleapis.com/auth/', ''),
    class: SCOPES[s]?.class ?? 'not classed in Google docs',
    use: SCOPES[s]?.use ?? '?',
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ?? new URL('../src/appsscript.json', import.meta.url);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const { loadAddOn, scriptFiles, SRC } = await import('./load.mjs');
  // The add-on's top-level functions (loaded as Apps Script loads them).
  const addOn = loadAddOn();
  const functions = new Set();
  for (const name of scriptFiles())
    for (const m of readFileSync(`${SRC}/${name}`, 'utf8').matchAll(
      /^function ([A-Za-z_$][\w$]*)\(/gm,
    ))
      if (addOn.get(`typeof ${m[1]}`) === 'function') functions.add(m[1]);
  const { errors, warnings } = validate(manifest, { functions });
  console.table(scopeTable(manifest));
  for (const w of warnings) console.warn('warning:', w);
  for (const e of errors) console.error('error:', e);
  console.log(errors.length ? `${errors.length} error(s)` : 'manifest OK');
  process.exit(errors.length ? 1 : 0);
}
