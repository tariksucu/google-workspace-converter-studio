/* global CardService, CsFormats, CsViews, CS_CONFIG */
/* eslint @typescript-eslint/no-unused-vars: ["error", { "varsIgnorePattern": "^Cs[A-Z]" }] -- Apps Script shares top-level names across the project's files */

/**
 * The add-on's cards. Apps Script glue: it turns the models of Views.js into CardService widgets
 * and decides nothing itself. Button callbacks are the `on…` functions of Main.js.
 */
const CsCards = (function () {
  /** A page of converter.studio (read when a card is built: Config.js may load after this file). */
  const page = (path) => CS_CONFIG.siteUrl + path;

  function action(name, params) {
    const a = CardService.newAction()
      .setFunctionName(name)
      .setLoadIndicator(CardService.LoadIndicator.SPINNER);
    if (params) a.setParameters(params);
    return a;
  }

  function button(text, onClick, filled) {
    const b = CardService.newTextButton().setText(text).setOnClickAction(onClick);
    if (filled) b.setTextButtonStyle(CardService.TextButtonStyle.FILLED);
    return b;
  }

  function linkButton(text, url) {
    return CardService.newTextButton()
      .setText(text)
      .setOpenLink(
        CardService.newOpenLink()
          .setUrl(url)
          .setOpenAs(CardService.OpenAs.FULL_SIZE)
          .setOnClose(CardService.OnClose.NOTHING),
      );
  }

  function paragraph(text) {
    return CardService.newTextParagraph().setText(text);
  }

  /** Card text is a small HTML subset: names from mail and Drive are shown as text, not markup. */
  function escape(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Google's docs list HTML formatting for text widgets, not for headers: a file name goes into a
   * header as it is (escaping it there could show "&amp;").
   */
  function header(title, subtitle) {
    const h = CardService.newCardHeader().setTitle(title);
    if (subtitle) h.setSubtitle(subtitle);
    return h;
  }

  /** A grey line of small print. */
  function note(html) {
    return paragraph('<font color="#5f6368">' + html + '</font>');
  }

  /**
   * "Continue with Google": the wording Google's sign-in branding guidelines offer, with Google's
   * standard-colour "G" on a white (outlined) button, as they require.
   */
  function signInButton() {
    return CardService.newTextButton()
      .setText('Continue with Google')
      .setIconUrl(CS_CONFIG.googleIconUrl)
      .setTextButtonStyle(CardService.TextButtonStyle.OUTLINED)
      .setOnClickAction(action('onSignIn'));
  }

  /**
   * The home and settings card: what the add-on does, then signing in, or the signed-in account
   * and the settings.
   * @param {{ settings: object, signedIn: boolean, account?: object | null, accountError?: string | null, host?: string }} model
   */
  function home(model) {
    const settings = model.settings;
    const intro = CardService.newCardSection()
      .addWidget(
        paragraph(
          'Convert e-mail attachments and Google Drive files with Converter Studio: iPhone photos (HEIC) to JPG, Word to PDF, scanned PDFs to text, videos to MP4 and more.',
        ),
      )
      .addWidget(
        paragraph(
          model.host === 'drive'
            ? '<b>In Drive:</b> select a file, pick a format, then save the result next to the original.'
            : '<b>In Gmail:</b> open a message, click <b>Show attachments</b> and pick a format.',
        ),
      );
    const account = CardService.newCardSection().setHeader('Your Converter Studio account');
    if (!model.signedIn) {
      account
        .addWidget(
          paragraph(
            'Sign in with your Google account to start. A free account gets 25 credits a day; most photos and documents cost 1 credit. If you already have a Converter Studio account with this Google account or its e-mail address, the add-on uses it.',
          ),
        )
        .addWidget(signInButton())
        // The words of the site's own sign-up.
        .addWidget(
          note(
            'By creating an account, you agree to the <a href="' +
              page('/terms') +
              '">Terms of Service</a> and the <a href="' +
              page('/privacy') +
              '">Privacy policy</a>.',
          ),
        );
    } else {
      const email = model.account && model.account.email;
      account
        .addWidget(
          CardService.newDecoratedText()
            .setTopLabel(email ? 'Signed in as ' + email : 'Signed in')
            .setText(
              escape(model.accountError || CsViews.accountLine(model.account) || 'Signed in'),
            )
            .setWrapText(true),
        )
        .addWidget(
          CardService.newTextInput()
            .setFieldName('maxCredits')
            .setTitle('Ask before a conversion that costs more than (credits)')
            .setValue(String(settings.maxCredits)),
        )
        .addWidget(
          CardService.newButtonSet()
            .addButton(button('Save', action('onSaveSettings'), true))
            .addButton(button('Sign out', action('onSignOut'))),
        )
        .addWidget(
          CardService.newButtonSet()
            .addButton(linkButton('Your account', page('/account')))
            .addButton(linkButton('Pricing', page('/pricing'))),
        )
        .addWidget(
          note(
            'Sign out forgets this add-on’s sign-in. To take away its access to your Google account, open your Google Account’s <a href="' +
              CS_CONFIG.googleConnectionsUrl +
              '">third-party connections</a>.',
          ),
        );
    }
    const privacy = CardService.newCardSection()
      .addWidget(
        paragraph(
          'Only the files you convert are sent to converter.studio, which deletes them after the conversion and the results 6 hours later.',
        ),
      )
      .addWidget(
        CardService.newButtonSet()
          .addButton(linkButton('Privacy policy', page('/privacy')))
          .addButton(linkButton('Help', page('/support'))),
      );
    return CardService.newCardBuilder()
      .setName('home')
      .setHeader(header('Converter Studio', 'Convert files in Gmail and Drive'))
      .addSection(intro)
      .addSection(account)
      .addSection(privacy)
      .build();
  }

  /** The card beside an open message: nothing is read until the click. */
  function message() {
    return CardService.newCardBuilder()
      .setName('message')
      .setHeader(header('Converter Studio', 'Convert an attachment'))
      .addSection(
        CardService.newCardSection()
          .addWidget(paragraph('Convert an attachment of this message to another format.'))
          .addWidget(button('Show attachments', action('onShowAttachments'), true))
          .addWidget(
            paragraph(
              '<font color="#5f6368">The add-on reads the message only when you click.</font>',
            ),
          ),
      )
      .build();
  }

  /** The message's attachments, each with a Convert button when Converter Studio reads it. */
  function attachments(rows, hashes) {
    const section = CardService.newCardSection();
    if (!rows.length) section.addWidget(paragraph('This message has no attachments.'));
    for (const row of rows) {
      const line = CardService.newDecoratedText().setText(escape(row.name)).setWrapText(true);
      if (row.label) line.setTopLabel(escape(row.label));
      if (row.note) line.setBottomLabel(escape(row.note));
      if (row.convertible)
        line.setButton(
          button(
            'Convert',
            action('onPickAttachment', { index: String(row.index), hash: hashes[row.index] }),
          ),
        );
      section.addWidget(line);
    }
    return CardService.newCardBuilder()
      .setName('attachments')
      .setHeader(header('Attachments', rows.length ? 'Pick one to convert' : ''))
      .addSection(section)
      .build();
  }

  /**
   * The "Convert to" form for one file.
   * @param {{ name: string, label: string, choice: object, maxCredits: number }} model
   * @param {string} onConvert the callback's name
   * @param {object} params its parameters
   */
  function convertForm(model, onConvert, params) {
    const list = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setTitle('Convert to')
      .setFieldName('to');
    for (const t of model.choice.targets)
      list.addItem(t.label, t.to, t.to === model.choice.defaultTo);
    const section = CardService.newCardSection().addWidget(list);
    if (model.choice.ocr) {
      section.addWidget(
        CardService.newSelectionInput()
          .setType(CardService.SelectionInputType.CHECK_BOX)
          .setFieldName('ocr')
          // The words of the site's own setting, which Converter Studio's messages refer to.
          .addItem('Recognise text (scanned PDF), for TXT and DOCX', 'yes', false),
      );
    }
    section.addWidget(
      paragraph(
        '<font color="#5f6368">A conversion that costs more than ' +
          escape(CsFormats.credits(model.maxCredits)) +
          ' waits for your go-ahead.</font>',
      ),
    );
    return CardService.newCardBuilder()
      .setName('convert')
      .setHeader(header(model.name, model.label))
      .addSection(section)
      .setFixedFooter(
        CardService.newFixedFooter().setPrimaryButton(
          button('Convert', action(onConvert, params), true),
        ),
      )
      .build();
  }

  /**
   * A conversion's card: done (download, save, reply), still running (check again), waiting for
   * a go-ahead (confirm), or failed.
   * @param {object} model from CsViews.conversion
   * @param {{ id: string, host: string, fileId?: string, downloadUrl?: string | null, saved?: { name: string, link?: string, where: string } }} ctx
   */
  function result(model, ctx) {
    const params = { id: ctx.id, host: ctx.host };
    if (ctx.fileId) params.fileId = ctx.fileId;
    const section = CardService.newCardSection();
    const line = CardService.newDecoratedText()
      .setTopLabel(model.title)
      .setText(escape(model.name))
      .setWrapText(true);
    if (model.details) line.setBottomLabel(escape(model.details));
    section.addWidget(line);
    if (model.text) section.addWidget(paragraph(escape(model.text)));
    if (model.state === 'done') {
      const buttons = CardService.newButtonSet();
      if (model.download && ctx.downloadUrl)
        buttons.addButton(linkButton('Download', ctx.downloadUrl));
      if (model.saveToDrive)
        buttons.addButton(button('Save to Google Drive', action('onSaveToDrive', params)));
      if (model.saveBeside)
        buttons.addButton(
          button('Save next to the original', action('onSaveBesideOriginal', params), true),
        );
      section.addWidget(buttons);
      if (model.reply) {
        section.addWidget(
          CardService.newTextButton()
            .setText('Reply with the file attached')
            .setComposeAction(
              action('onReplyWithResult', params),
              CardService.ComposedEmailType.REPLY_AS_DRAFT,
            ),
        );
      }
      if (ctx.saved) {
        const saved = CardService.newDecoratedText()
          .setTopLabel(
            ctx.saved.where === 'beside'
              ? 'Saved next to the original'
              : 'Saved in My Drive › ' + CS_CONFIG.driveFolderName,
          )
          .setText(escape(ctx.saved.name))
          .setWrapText(true);
        if (ctx.saved.link) saved.setButton(linkButton('Open', ctx.saved.link));
        section.addWidget(saved);
      }
      if (model.note)
        section.addWidget(paragraph('<font color="#5f6368">' + escape(model.note) + '</font>'));
    } else if (model.state === 'working') {
      section.addWidget(button('Check again', action('onCheckConversion', params), true));
      if (model.note)
        section.addWidget(paragraph('<font color="#5f6368">' + escape(model.note) + '</font>'));
    } else if (model.state === 'quoted') {
      section.addWidget(button(model.confirmLabel, action('onConfirmConversion', params), true));
    }
    return CardService.newCardBuilder()
      .setName('result')
      .setHeader(header('Converter Studio', model.title))
      .addSection(section)
      .build();
  }

  /** Drive: what to do with the selection (one file, several, a folder, no permission yet). */
  function driveItems(items) {
    const section = CardService.newCardSection().addWidget(
      paragraph('Several items are selected. Choose the file to convert:'),
    );
    for (const item of items.slice(0, 20)) {
      section.addWidget(
        CardService.newDecoratedText()
          .setText(escape(item.title))
          .setWrapText(true)
          .setButton(button('Choose', action('onPickDriveFile', { fileId: item.id }))),
      );
    }
    return CardService.newCardBuilder()
      .setName('selection')
      .setHeader(header('Converter Studio', 'Convert a Drive file'))
      .addSection(section)
      .build();
  }

  /** Drive: a selected file the add-on may not open yet. */
  function driveAccess(item) {
    return CardService.newCardBuilder()
      .setName('access')
      .setHeader(header(item.title, 'Convert a Drive file'))
      .addSection(
        CardService.newCardSection()
          .addWidget(
            paragraph(
              'To convert this file, Converter Studio needs your permission to open it. Drive asks for this file only; the add-on sees no other file.',
            ),
          )
          .addWidget(
            button(
              'Allow access to this file',
              action('onRequestFileAccess', { fileId: item.id }),
              true,
            ),
          ),
      )
      .build();
  }

  /** A card with one message (a folder, an unknown format, an error) and a way back home. */
  function notice(title, text, showSettings) {
    const section = CardService.newCardSection().addWidget(paragraph(escape(text)));
    if (showSettings) section.addWidget(button('Settings', action('onShowSettingsCard')));
    return CardService.newCardBuilder()
      .setName('notice')
      .setHeader(header('Converter Studio', title))
      .addSection(section)
      .build();
  }

  function push(card, notification) {
    const b = CardService.newActionResponseBuilder().setNavigation(
      CardService.newNavigation().pushCard(card),
    );
    if (notification) b.setNotification(CardService.newNotification().setText(notification));
    return b.build();
  }

  function update(card, notification) {
    const b = CardService.newActionResponseBuilder().setNavigation(
      CardService.newNavigation().updateCard(card),
    );
    if (notification) b.setNotification(CardService.newNotification().setText(notification));
    return b.build();
  }

  function notify(text) {
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText(text))
      .build();
  }

  return {
    escape,
    home,
    message,
    attachments,
    convertForm,
    result,
    driveItems,
    driveAccess,
    notice,
    push,
    update,
    notify,
  };
})();
