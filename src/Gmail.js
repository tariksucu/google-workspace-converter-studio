/* global CsErrors, GmailApp, CS_CONFIG */
/* eslint @typescript-eslint/no-unused-vars: ["error", { "varsIgnorePattern": "^Cs[A-Z]" }] -- Apps Script shares top-level names across the project's files */

/**
 * The open Gmail message, read only after a click: the add-on asks for
 * `gmail.addons.current.message.action` ("access to the open message's content upon user
 * interaction"), so it reads nothing when a message is merely opened. Apps Script glue: GmailApp.
 */
const CsGmail = (function () {
  /**
   * The message the event is about, with the event's temporary access token switched on.
   * `checkPermission`: called when Gmail refused; ends the execution with Google's own permission
   * card when the message permission was left unticked (Main.js).
   */
  function openMessage(e, checkPermission) {
    const gmail = e && e.gmail;
    if (!gmail || !gmail.messageId || !gmail.accessToken) throw new CsErrors.CsError('messageGone');
    let message;
    try {
      GmailApp.setCurrentMessageAccessToken(gmail.accessToken);
      message = GmailApp.getMessageById(gmail.messageId);
    } catch {
      // A token from an older view of the message, or a message deleted meanwhile; or the
      // permission to read the open message unticked on Google's consent screen.
      if (checkPermission) checkPermission([CS_CONFIG.scopes.message]);
      message = null;
    }
    if (!message) throw new CsErrors.CsError('messageGone');
    return message;
  }

  /** The message's attachments, without the images shown inside its text. */
  function attachmentsOf(message) {
    return message.getAttachments({ includeInlineImages: false, includeAttachments: true });
  }

  /**
   * The attachment a button was made for: same position, same content (Gmail's hash), so a
   * changed message never converts the wrong file.
   */
  function findAttachment(message, index, hash) {
    const list = attachmentsOf(message);
    const attachment = list[Number(index)];
    if (!attachment || (hash && attachment.getHash() !== hash))
      throw new CsErrors.CsError('attachmentGone');
    return attachment;
  }

  return { openMessage, attachmentsOf, findAttachment };
})();
