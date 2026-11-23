# Changelog

## 1.1.2

- **Reply with the file attached** now opens the reply with the recipient and the converted file
  attached, ready for you to write. Before, Gmail showed an empty reply box: no recipient and no file,
  although the draft held the file. The add-on writes nothing in your reply.
- The reply draft's line in the add-on's log no longer tries to read the draft back (Google does not
  allow it with the add-on's permissions). It says how many files were attached, their size and type,
  never a file name or an address.

## 1.1.1

- Permissions: Google's consent screen now lets you tick each permission separately. When something
  you click needs a permission you left unticked, the add-on asks for it with Google's own
  **Authorization required** card and carries on once you allow it. Before, signing in said
  "Converter Studio could not be reached" instead.
- Each part of the add-on asks only for what it uses: signing in and converting need the connection to
  Converter Studio and your sign-in; the attachments list the open message; the reply draft the
  compose permission; Drive its own. In Gmail, Drive permissions are asked for only when you save to
  Drive.
- When Converter Studio cannot be reached, the reason goes to the add-on's log (without tokens, keys
  or file contents). The reply draft writes one line there too: how many files it attached and their
  size, never a file name or an address.
- The converted file attached to a reply carries a plain media type (no `charset` or other
  parameter).
- For developers: `npm run bundle` writes the add-on as one file for the Apps Script editor, for a
  copy without clasp.

## 1.1.0

- Sign in with your Google account ("Continue with Google") instead of pasting an API key: the
  add-on uses the Converter Studio account of your Google account, or makes a free one. The same
  account, plan and credits as on converter.studio and in the apps.
- The sign-in renews itself (never making an account: one deleted on converter.studio signs the
  add-on out); **Sign out** in Settings.
- The API key 1.0.0 kept in the add-on's storage for your Google account is deleted (it is no longer
  used; delete the key itself under API keys on converter.studio if you no longer need it).
- New permissions: `openid` and `userinfo.email` (your Google account's e-mail address, to sign in).

## 1.0.0

- Gmail: convert an attachment of the open message (the add-on reads the message only after you click
  **Show attachments**), then download the result, save it to Google Drive or reply with it attached.
- Google Drive: convert the selected file (Google Docs, Sheets, Slides and Drawings are exported first)
  and save the result next to the original.
- Formats from Converter Studio's own list (67 formats), text recognition (OCR) for scanned PDFs, a
  credit limit above which a conversion waits for your go-ahead.
