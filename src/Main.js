/* global CacheService, CardService, PropertiesService, ScriptApp, UrlFetchApp, Utilities, Drive */
/* global CsApi, CsCards, CsDrive, CsErrors, CsFlow, CsFormats, CsGmail, CsSession, CsSettings, CsViews, CS_CONFIG */
/* eslint @typescript-eslint/no-unused-vars: ["error", { "varsIgnorePattern": "^on[A-Z]" }] -- Google calls these by name (appsscript.json and card actions) */

/**
 * The add-on's entry points: the triggers named in appsscript.json and the callbacks named by
 * the cards' buttons. Apps Script glue: each one asks Google for the permissions it needs, reads
 * the event, builds the services and hands over to the plain-JavaScript parts.
 */

// --- Permissions --------------------------------------------------------------------------------

/** The URLs of scopes named in CS_CONFIG.scopes, each once, in the manifest's order. */
function csScopesOf(names) {
  return Object.keys(CS_CONFIG.scopes)
    .filter((name) => names.indexOf(name) >= 0)
    .map((name) => CS_CONFIG.scopes[name]);
}

/** The scopes of `features` (names of CS_CONFIG.needs), with Gmail's own when it runs in Gmail. */
function csScopes(e, features) {
  let names = csHost(e) === 'gmail' ? CS_CONFIG.needs.gmail.slice() : [];
  for (const feature of features) names = names.concat(CS_CONFIG.needs[feature]);
  return csScopesOf(names);
}

/**
 * Asks Google for the permissions an entry point needs, before it does anything. Google's consent
 * screen has a box per permission, unticked, and the user may leave any of them unticked
 * (granular consent). `ScriptApp.requireScopes` then ends this execution and Google shows its own
 * "Authorization required" card; once the user allows it, Google runs the same function again
 * (both seen in a real account on 2026-11-23). It runs outside any try: an exception caught on
 * its way would hide that card. `features`: names of CS_CONFIG.needs.
 */
function csRequire(e, features) {
  const scopes = csScopes(e, features);
  if (scopes.length) ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, scopes);
}

/**
 * The second look, after a Google service refused although csRequire let the execution in (a
 * permission withdrawn meanwhile, or one CS_CONFIG.needs forgot). Google's exception says why only
 * in the user's language, so Apps Script is asked instead: when one of `scopes` is missing, Google
 * asks for it as csRequire does, and the exception that ends the execution is marked so that every
 * catch on its way lets it through (CsErrors.passGoogleStop). Returns when nothing is missing.
 */
function csCheckPermission(scopes) {
  const status = ScriptApp.getAuthorizationInfo(
    ScriptApp.AuthMode.FULL,
    scopes,
  ).getAuthorizationStatus();
  // Apps Script's enum values are compared by name.
  if (String(status) !== String(ScriptApp.AuthorizationStatus.REQUIRED)) return;
  try {
    ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, scopes);
  } catch (stop) {
    throw CsErrors.googleStop(stop);
  }
}

/** Whether the user is signed in to Converter Studio (a session is kept). */
function csSignedIn() {
  return CsSession.read(PropertiesService.getUserProperties()) !== null;
}

/** The home card's needs: the account's plan and credits come from Converter Studio. */
function csHomeNeeds() {
  return csSignedIn() ? ['converterStudio'] : [];
}

// --- Services -----------------------------------------------------------------------------------

/**
 * Settings, the sign-in, the API client and the clock for one execution (Apps Script gives it 30
 * seconds). The session signs in with Google's identity token for the user, through the client.
 */
function csContext() {
  const started = Date.now();
  const user = PropertiesService.getUserProperties();
  const settings = CsSettings.read(user, PropertiesService.getScriptProperties());
  let client = null;
  const session = CsSession.create({
    user,
    identityToken: () => {
      const token = ScriptApp.getIdentityToken();
      // Null without `openid`: Google asks for the sign-in's permissions, if that is why.
      if (!token) csCheckPermission(csScopesOf(CS_CONFIG.needs.converterStudio));
      return token;
    },
    exchange: (idToken, signUp) => client.exchange(idToken, signUp),
  });
  client = CsApi.createClient({
    session,
    baseUrl: settings.baseUrl,
    version: CS_CONFIG.version,
    urlFetch: UrlFetchApp,
    newKey: () => Utilities.getUuid(),
    sleep: (ms) => Utilities.sleep(ms),
    deadline: started + CS_CONFIG.budgetMs,
    checkPermission: csCheckPermission,
    log: (text) => console.error('Converter Studio add-on: ' + text),
  });
  return { settings, session, client };
}

/** Which app the add-on runs in. */
function csHost(e) {
  return e && e.commonEventObject && e.commonEventObject.hostApp === 'DRIVE' ? 'drive' : 'gmail';
}

/** The formats list, from the script cache (shared by all users: it holds nothing personal). */
function csCatalog(client) {
  const cache = CacheService.getScriptCache();
  const key = 'cs-formats:' + client.baseUrl;
  let body = null;
  const cached = cache.get(key);
  if (cached) {
    try {
      body = JSON.parse(cached);
    } catch {
      body = null;
    }
  }
  if (!body) {
    body = client.formats();
    const text = JSON.stringify(body);
    // CacheService keeps at most 100 KB a value.
    if (text.length < 100000) cache.put(key, text, CS_CONFIG.catalogCacheSeconds);
  }
  return CsFormats.parseCatalog(body);
}

/** A button's parameters (strings only). */
function csParams(e) {
  return (e && e.commonEventObject && e.commonEventObject.parameters) || {};
}

/** What a card's input holds: a list of strings (empty when nothing was entered or ticked). */
function csInput(e, name) {
  const inputs = e && e.commonEventObject && e.commonEventObject.formInputs;
  const field = inputs && inputs[name];
  return field && field.stringInputs && Array.isArray(field.stringInputs.value)
    ? field.stringInputs.value
    : [];
}

/** The Drive service for this execution. */
function csDrive(client) {
  return CsDrive.createDriveFiles({
    drive: Drive,
    urlFetch: UrlFetchApp,
    token: () => ScriptApp.getOAuthToken(),
    user: PropertiesService.getUserProperties(),
    remaining: client.remaining,
    checkPermission: csCheckPermission,
  });
}

/**
 * A button's work, after Google has the permissions of `features` (csRequire, outside the try),
 * with Converter Studio's message as a notification when it fails. An unexpected error (a bug, a
 * Google service's refusal) first gets the second look at the permissions, then shows a generic
 * text and goes to the project's log (exceptionLogging: Cloud Logging, readable by the project's
 * owners only).
 */
function csAct(e, features, work) {
  csRequire(e, features);
  try {
    return work();
  } catch (error) {
    CsErrors.passGoogleStop(error);
    if (!(error instanceof CsErrors.CsError)) csCheckPermission(csScopes(e, features));
    csLog(error);
    return CsCards.notify(CsErrors.asCsError(error).message);
  }
}

/** Logs an unexpected error; Converter Studio's own (CsError) are expected and not logged. */
function csLog(error) {
  if (error instanceof CsErrors.CsError) return;
  console.error('Converter Studio add-on: ' + CsErrors.describe(error, true));
}

/**
 * The home card: signing in, or the signed-in account's e-mail, plan and credits. `account`: one
 * already fetched in this click.
 */
function csHomeCard(host, ctx, account) {
  const c = ctx || csContext();
  let shown = account || null;
  let accountError = null;
  if (c.session.signedIn() && !shown) {
    try {
      shown = c.client.account();
    } catch (error) {
      CsErrors.passGoogleStop(error);
      csLog(error);
      accountError = CsErrors.asCsError(error).message;
    }
  }
  // Asked again: a renewal that found no account (deleted since) has signed out.
  const signedIn = c.session.signedIn();
  return CsCards.home({ settings: c.settings, signedIn, account: shown, accountError, host });
}

// --- Triggers (appsscript.json) ----------------------------------------------------------------

/** Homepage in Gmail and Drive. */
function onHomepage(e) {
  csRequire(e, csHomeNeeds());
  return [csHomeCard(csHost(e))];
}

/** Gmail: a message is open. Nothing of it is read here (nor sent: the card waits for a click). */
function onGmailMessageOpen(e) {
  csRequire(e, []);
  const ctx = csContext();
  if (!ctx.session.signedIn()) return [csHomeCard('gmail', ctx)];
  return [CsCards.message()];
}

/** Drive: files or folders are selected. */
function onDriveItemsSelected(e) {
  csRequire(e, ['selection'].concat(csHomeNeeds()));
  const ctx = csContext();
  if (!ctx.session.signedIn()) return [csHomeCard('drive', ctx)];
  const items = (e && e.drive && e.drive.selectedItems) || [];
  if (!items.length) return [csHomeCard('drive')];
  if (items.length > 1) return [CsCards.driveItems(items)];
  try {
    return [csDriveFileCard(ctx, items[0])];
  } catch (error) {
    CsErrors.passGoogleStop(error);
    return [CsCards.notice('Convert a Drive file', CsErrors.asCsError(error).message, true)];
  }
}

/** The card for one selected Drive item. */
function csDriveFileCard(ctx, item) {
  const source = CsFormats.driveSource(item.mimeType, item.title);
  if (source.kind === 'folder')
    return CsCards.notice('Convert a Drive file', 'Select a file; folders are not converted.');
  if (source.kind === 'unsupported')
    return CsCards.notice('Convert a Drive file', CsErrors.TEXT.unknownFormat);
  if (!item.addonHasFileScopePermission) return CsCards.driveAccess(item);
  const choice = CsViews.choice(csCatalog(ctx.client), source.name);
  if (!choice.targets.length) return CsCards.notice(item.title, CsErrors.TEXT.unknownFormat);
  return CsCards.convertForm(
    {
      name: item.title,
      label: choice.fromName || '',
      choice,
      maxCredits: ctx.settings.maxCredits,
    },
    'onConvertDriveFile',
    { fileId: item.id },
  );
}

// --- Sign-in and settings ----------------------------------------------------------------------

/**
 * "Continue with Google": signs in with the user's Google account (Converter Studio finds its
 * account or makes a free one), then carries on where the user was: the open message, the
 * selected Drive file, or the home card.
 */
function onSignIn(e) {
  // In Drive, the card after the sign-in is the selected file's (its id, name and type).
  const selected = csHost(e) === 'drive' && e.drive && (e.drive.selectedItems || []).length > 0;
  return csAct(e, selected ? ['converterStudio', 'selection'] : ['converterStudio'], () => {
    const ctx = csContext();
    const started = ctx.session.signIn();
    const account = ctx.client.account();
    const line = CsViews.accountLine(account);
    return CsCards.update(
      csAfterSignIn(e, ctx, account),
      (started.newAccount ? 'Your free Converter Studio account is ready. ' : 'Signed in. ') + line,
    );
  });
}

/** The card the user was about to see before signing in. */
function csAfterSignIn(e, ctx, account) {
  const host = csHost(e);
  if (host === 'gmail' && e.gmail && e.gmail.messageId) return CsCards.message();
  const items = (host === 'drive' && e.drive && e.drive.selectedItems) || [];
  if (items.length > 1) return CsCards.driveItems(items);
  if (items.length === 1) {
    try {
      return csDriveFileCard(ctx, items[0]);
    } catch (error) {
      CsErrors.passGoogleStop(error);
      return CsCards.notice('Convert a Drive file', CsErrors.asCsError(error).message, true);
    }
  }
  return csHomeCard(host, ctx, account);
}

/** "Sign out": forgets the add-on's session; the add-on asks to sign in again. */
function onSignOut(e) {
  return csAct(e, [], () => {
    CsSession.forget(PropertiesService.getUserProperties());
    return CsCards.update(csHomeCard(csHost(e)), 'Signed out of Converter Studio.');
  });
}

/** Universal action (the ⋮ menu): the settings card. */
function onShowSettings(e) {
  csRequire(e, csHomeNeeds());
  return CardService.newUniversalActionResponseBuilder()
    .displayAddOnCards([csHomeCard(csHost(e))])
    .build();
}

/** A "Settings" button inside a card. */
function onShowSettingsCard(e) {
  csRequire(e, csHomeNeeds());
  return CsCards.push(csHomeCard(csHost(e)));
}

/** Saves the credit limit. */
function onSaveSettings(e) {
  return csAct(e, csHomeNeeds(), () => {
    CsSettings.save(PropertiesService.getUserProperties(), {
      maxCredits: csInput(e, 'maxCredits')[0],
    });
    return CsCards.update(csHomeCard(csHost(e)), 'Settings saved.');
  });
}

// --- Gmail --------------------------------------------------------------------------------------

/** "Show attachments": the first time the add-on reads the message. */
function onShowAttachments(e) {
  return csAct(e, ['message', 'converterStudio'], () => {
    const ctx = csContext();
    const message = CsGmail.openMessage(e, csCheckPermission);
    const list = CsGmail.attachmentsOf(message);
    const rows = CsViews.attachmentRows(
      list.map((a) => ({ name: a.getName(), size: a.getSize() })),
      csCatalog(ctx.client),
    );
    return CsCards.push(
      CsCards.attachments(
        rows,
        list.map((a) => a.getHash()),
      ),
    );
  });
}

/** "Convert" beside an attachment: the "Convert to" form. */
function onPickAttachment(e) {
  return csAct(e, ['message', 'converterStudio'], () => {
    const ctx = csContext();
    const p = csParams(e);
    const attachment = CsGmail.findAttachment(
      CsGmail.openMessage(e, csCheckPermission),
      p.index,
      p.hash,
    );
    const choice = CsViews.choice(csCatalog(ctx.client), attachment.getName());
    if (!choice.targets.length) throw new CsErrors.CsError('unknownFormat');
    return CsCards.push(
      CsCards.convertForm(
        {
          name: attachment.getName(),
          label: [choice.fromName, CsFormats.formatBytes(attachment.getSize())]
            .filter(Boolean)
            .join(' · '),
          choice,
          maxCredits: ctx.settings.maxCredits,
        },
        'onConvertAttachment',
        { index: String(p.index), hash: String(p.hash || '') },
      ),
    );
  });
}

/** Converts the attachment; shows the result, or "Check again" when it takes longer. */
function onConvertAttachment(e) {
  return csAct(e, ['message', 'converterStudio'], () => {
    const ctx = csContext();
    const p = csParams(e);
    const to = csInput(e, 'to')[0];
    const attachment = CsGmail.findAttachment(
      CsGmail.openMessage(e, csCheckPermission),
      p.index,
      p.hash,
    );
    const catalog = csCatalog(ctx.client);
    const from = CsFormats.formatOf(catalog, attachment.getName());
    if (!to || !CsFormats.targetsFor(catalog, from).some((t) => t.to === to))
      throw new CsErrors.CsError('notConvertible');
    const view = CsFlow.convert(ctx.client, {
      // A plain Blob of the attachment (UrlFetchApp documents strings, bytes and Blobs as bodies).
      blob: attachment.copyBlob(),
      fileName: attachment.getName(),
      size: attachment.getSize(),
      to,
      options: CsFormats.optionsFor(from, to, { ocr: csInput(e, 'ocr').indexOf('yes') >= 0 }),
      maxCredits: ctx.settings.maxCredits,
    });
    return CsCards.push(csResultCard(ctx, view, { host: 'gmail' }));
  });
}

/** Saves the result in the "Converter Studio" folder of My Drive. */
function onSaveToDrive(e) {
  return csAct(e, ['converterStudio', 'driveFiles'], () => {
    const ctx = csContext();
    const p = csParams(e);
    const view = ctx.client.get(p.id, 0);
    const blob = CsFlow.fetchResult(ctx.client, view);
    const saved = csDrive(ctx.client).saveToAppFolder(blob);
    return CsCards.update(
      csResultCard(ctx, view, { host: 'gmail', saved: csSaved(saved) }),
      'Saved to Google Drive: ' + saved.file.name,
    );
  });
}

/**
 * Compose action: a reply to the open message with the converted file attached (Google's own
 * pattern: Gmail add-ons guide, "Compose draft messages", createReplyDraft).
 */
function onReplyWithResult(e) {
  const features = ['reply', 'converterStudio'];
  csRequire(e, features);
  const ctx = csContext();
  const p = csParams(e);
  const message = CsGmail.openMessage(e, csCheckPermission);
  let draft;
  try {
    const view = ctx.client.get(p.id, 0);
    if (!(view.outputSize <= CS_CONFIG.maxReplyAttachmentBytes))
      throw new CsErrors.CsError('replyTooLarge');
    const file = csAttachable(CsFlow.fetchResult(ctx.client, view));
    draft = message.createDraftReply('', { attachments: [file] });
    csLogDraft(draft, file, view.outputSize);
  } catch (error) {
    CsErrors.passGoogleStop(error);
    if (!(error instanceof CsErrors.CsError)) csCheckPermission(csScopes(e, features));
    csLog(error);
    // A compose action can only answer with a draft: this one says why nothing is attached.
    draft = message.createDraftReply(
      'Converter Studio could not attach the converted file: ' + CsErrors.asCsError(error).message,
    );
  }
  return CardService.newComposeActionResponseBuilder().setGmailDraft(draft).build();
}

/**
 * The converted file as Gmail should see it: named after the conversion's output, with a bare
 * media type (UrlFetchApp's Blob takes the whole Content-Type header, parameters included).
 */
function csAttachable(blob) {
  const type = String(blob.getContentType() || '')
    .split(';')[0]
    .trim();
  blob.setContentType(type || 'application/octet-stream');
  return blob;
}

/**
 * One line in the project's log about the reply draft: what was attached and what the draft holds
 * when read back (counts, sizes and the media type only; no name, no address). The first real run
 * (2026-11-23) opened a reply box without the attachment although a draft was made; this says
 * whether the draft itself has it. Reading it back may be refused (Google documents GmailDraft's
 * methods with the full Gmail scope only): the log then says so, and the reply goes ahead.
 */
function csLogDraft(draft, file, size) {
  const sent = '1 attachment, ' + size + ' bytes, ' + file.getContentType();
  let back;
  try {
    const copy = draft.getMessage();
    const list = copy.getAttachments({ includeInlineImages: false, includeAttachments: true });
    let bytes = 0;
    for (const a of list) bytes += a.getSize();
    const to = String(copy.getTo() || '')
      .split(',')
      .filter((s) => s.trim()).length;
    back = list.length + ' attachment(s), ' + bytes + ' bytes, ' + to + ' recipient(s)';
  } catch (error) {
    back = 'not readable (' + (error && error.name ? String(error.name) : 'error') + ')';
  }
  console.log('Converter Studio add-on: reply draft made with ' + sent + '; read back: ' + back);
}

// --- Drive --------------------------------------------------------------------------------------

/** "Choose" in a selection of several items. */
function onPickDriveFile(e) {
  return csAct(e, ['selection', 'converterStudio'], () => {
    const ctx = csContext();
    const id = csParams(e).fileId;
    const items = (e.drive && e.drive.selectedItems) || [];
    const item = items.filter((i) => i.id === id)[0];
    if (!item) throw new CsErrors.CsError('fileGone');
    return CsCards.push(csDriveFileCard(ctx, item));
  });
}

/** "Allow access to this file": Drive asks the user for `drive.file` on this one file. */
function onRequestFileAccess(e) {
  csRequire(e, ['selection']);
  return CardService.newDriveItemsSelectedActionResponseBuilder()
    .requestFileScope(csParams(e).fileId)
    .build();
}

/** Converts the Drive file; shows the result, or "Check again" when it takes longer. */
function onConvertDriveFile(e) {
  return csAct(e, ['driveFiles', 'converterStudio'], () => {
    const ctx = csContext();
    const fileId = csParams(e).fileId;
    const to = csInput(e, 'to')[0];
    const files = csDrive(ctx.client);
    const meta = files.metadata(fileId);
    const catalog = csCatalog(ctx.client);
    const source = CsFormats.driveSource(meta.mimeType, meta.name);
    const from = source.name ? CsFormats.formatOf(catalog, source.name) : null;
    if (!to || !CsFormats.targetsFor(catalog, from).some((t) => t.to === to))
      throw new CsErrors.CsError('notConvertible');
    const file = files.content(meta);
    const view = CsFlow.convert(ctx.client, {
      blob: file.blob,
      fileName: file.name,
      size: file.size,
      to,
      options: CsFormats.optionsFor(from, to, { ocr: csInput(e, 'ocr').indexOf('yes') >= 0 }),
      maxCredits: ctx.settings.maxCredits,
    });
    return CsCards.push(csResultCard(ctx, view, { host: 'drive', fileId }));
  });
}

/** Saves the result in the original's folder (or the "Converter Studio" folder when it refuses). */
function onSaveBesideOriginal(e) {
  return csAct(e, ['driveFiles', 'converterStudio'], () => {
    const ctx = csContext();
    const p = csParams(e);
    const files = csDrive(ctx.client);
    const parents = files.metadata(p.fileId).parents || [];
    const view = ctx.client.get(p.id, 0);
    const saved = files.saveBeside(parents, CsFlow.fetchResult(ctx.client, view));
    return CsCards.update(
      csResultCard(ctx, view, { host: 'drive', fileId: p.fileId, saved: csSaved(saved) }),
      saved.where === 'beside'
        ? 'Saved next to the original: ' + saved.file.name
        : 'Saved in My Drive › ' + CS_CONFIG.driveFolderName + ': ' + saved.file.name,
    );
  });
}

// --- Both ---------------------------------------------------------------------------------------

/** "Check again": the conversion's state now. */
function onCheckConversion(e) {
  return csAct(e, ['converterStudio'], () => {
    const ctx = csContext();
    const p = csParams(e);
    const view = CsFlow.check(ctx.client, p.id);
    return CsCards.update(csResultCard(ctx, view, { host: p.host, fileId: p.fileId }));
  });
}

/** "Convert for N credits": the go-ahead for a conversion over the user's limit. */
function onConfirmConversion(e) {
  return csAct(e, ['converterStudio'], () => {
    const ctx = csContext();
    const p = csParams(e);
    const view = CsFlow.confirm(ctx.client, p.id);
    return CsCards.update(csResultCard(ctx, view, { host: p.host, fileId: p.fileId }));
  });
}

function csResultCard(ctx, view, extra) {
  const model = CsViews.conversion(view, {
    host: extra.host === 'drive' ? 'drive' : 'gmail',
    now: Date.now(),
    maxCredits: ctx.settings.maxCredits,
  });
  if (view.downloadUrl) ctx.client.checkLink(view.downloadUrl);
  return CsCards.result(model, {
    id: view.id,
    host: extra.host === 'drive' ? 'drive' : 'gmail',
    fileId: extra.fileId,
    downloadUrl: view.downloadUrl,
    saved: extra.saved,
  });
}

function csSaved(saved) {
  return { name: saved.file.name, link: saved.file.webViewLink || null, where: saved.where };
}
