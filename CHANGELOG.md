# Changelog

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
