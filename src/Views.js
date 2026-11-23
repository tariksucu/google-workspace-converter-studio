/* global CsErrors, CsFormats, CS_CONFIG */
/* eslint @typescript-eslint/no-unused-vars: ["error", { "varsIgnorePattern": "^Cs[A-Z]" }] -- Apps Script shares top-level names across the project's files */

/**
 * What the cards say and offer, decided from plain data. Plain JavaScript: Cards.js turns these
 * models into CardService widgets and nothing else.
 */
const CsViews = (function () {
  /** One line about a conversion that is still running. */
  function progressText(view) {
    switch (view.status) {
      case 'waiting_for_upload':
        return 'Sending the file to Converter Studio…';
      case 'fetching':
        return 'Converter Studio is fetching the file…';
      case 'measuring':
        return 'Measuring the file to price it…';
      case 'queued':
        return 'Waiting for a converter…';
      case 'processing':
        return typeof view.progress === 'number' && view.progress > 0
          ? 'Converting… ' + Math.round(view.progress * 100) + '%'
          : 'Converting…';
      default:
        return 'Working on it…';
    }
  }

  /** "about 6 hours", "about 40 minutes", from the API's `expiresAt`. */
  function timeLeft(expiresAt, now) {
    const end = Date.parse(expiresAt || '');
    if (!isFinite(end)) return null;
    const minutes = Math.round((end - now) / 60000);
    if (minutes <= 0) return null;
    if (minutes < 90) return 'about ' + minutes + ' minute' + (minutes === 1 ? '' : 's');
    return 'about ' + Math.round(minutes / 60) + ' hours';
  }

  /**
   * The card for a conversion: what happened and what can be done next.
   * @param {object} view the API's ConversionView
   * @param {{ host: 'gmail' | 'drive', now: number, maxCredits: number }} ctx
   */
  function conversion(view, ctx) {
    const name = view.outputName || view.inputName || 'the file';
    if (view.status === 'done') {
      const details = [];
      if (typeof view.outputSize === 'number') details.push(CsFormats.formatBytes(view.outputSize));
      if (typeof view.credits === 'number') details.push(CsFormats.credits(view.credits));
      const left = timeLeft(view.expiresAt, ctx.now);
      const fits = typeof view.outputSize === 'number' && view.outputSize <= CS_CONFIG.maxBytes;
      return {
        state: 'done',
        title: 'Converted',
        name,
        details: details.join(' · '),
        note: left
          ? 'The download link works for ' + left + '; then Converter Studio deletes the file.'
          : 'Converter Studio keeps the file for 6 hours.',
        download: Boolean(view.downloadUrl),
        saveToDrive: ctx.host === 'gmail' && fits,
        saveBeside: ctx.host === 'drive' && fits,
        reply:
          ctx.host === 'gmail' &&
          typeof view.outputSize === 'number' &&
          view.outputSize <= CS_CONFIG.maxReplyAttachmentBytes,
      };
    }
    if (view.status === 'quoted') {
      return {
        state: 'quoted',
        title: 'Waiting for your go-ahead',
        name: view.inputName || name,
        text:
          'This conversion costs ' +
          CsFormats.credits(view.credits) +
          ', more than the ' +
          CsFormats.credits(ctx.maxCredits) +
          ' you allow without asking (Settings). Nothing is charged until you confirm.',
        confirmLabel: 'Convert for ' + CsFormats.credits(view.credits),
      };
    }
    if (view.status === 'failed') {
      return {
        state: 'failed',
        title: 'Not converted',
        name: view.inputName || name,
        text: (view.error && view.error.message) || CsErrors.TEXT.conversionFailed,
      };
    }
    if (view.status === 'expired') {
      return {
        state: 'expired',
        title: 'Expired',
        name,
        text: CsErrors.TEXT.fileExpired,
      };
    }
    if (view.status === 'canceled') {
      return { state: 'canceled', title: 'Canceled', name, text: 'Canceled; nothing was charged.' };
    }
    return {
      state: 'working',
      title: 'Converting',
      name: view.inputName || name,
      text: progressText(view),
      note: 'This takes longer than one click allows. Check again in a few seconds; nothing is lost if you close the panel.',
    };
  }

  /**
   * What a file can become, for the "Convert to" list.
   * @param {object} catalog CsFormats catalogue
   * @param {string} fileName
   */
  function choice(catalog, fileName) {
    const from = CsFormats.formatOf(catalog, fileName);
    const targets = CsFormats.targetsFor(catalog, from);
    return {
      from,
      fromName: from && catalog.byId.get(from) ? catalog.byId.get(from).name : null,
      targets,
      defaultTo: CsFormats.defaultTarget(catalog, from),
      ocr: targets.some((t) => CsFormats.offersOcr(from, t.to)),
    };
  }

  /**
   * The attachments of a message, as the list card shows them.
   * @param {{ name: string, size: number }[]} attachments
   * @param {object} catalog
   */
  function attachmentRows(attachments, catalog) {
    return attachments.map((a, index) => {
      const c = choice(catalog, a.name);
      const tooLarge = a.size > CS_CONFIG.maxBytes;
      return {
        index,
        name: a.name || 'attachment',
        label: [c.fromName, CsFormats.formatBytes(a.size)].filter(Boolean).join(' · '),
        convertible: c.targets.length > 0 && !tooLarge && a.size > 0,
        note: !c.targets.length
          ? CsErrors.TEXT.unknownFormat
          : tooLarge
            ? CsErrors.TEXT.sourceTooLarge
            : a.size > 0
              ? null
              : CsErrors.TEXT.sourceEmpty,
      };
    });
  }

  /** "Plan: pro · 480 credits left", from `GET /v1/account`. */
  function accountLine(account) {
    if (!account) return null;
    const parts = [];
    if (account.plan) parts.push('Plan: ' + account.plan);
    if (typeof account.credits === 'number')
      parts.push(CsFormats.credits(account.credits) + ' left');
    return parts.join(' · ');
  }

  return { progressText, timeLeft, conversion, choice, attachmentRows, accountLine };
})();
