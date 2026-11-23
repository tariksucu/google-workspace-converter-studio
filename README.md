# Converter Studio for Gmail and Google Drive

A Google Workspace add-on that converts files with [Converter Studio](https://converter.studio), in the
side panel of Gmail and Google Drive:

- **Gmail:** open a message, click **Show attachments**, pick an attachment and a format. Then
  **Download** the result, **Save to Google Drive**, or **Reply with the file attached**.
- **Google Drive:** select a file, pick a format, then **Save next to the original**. Google Docs,
  Sheets, Slides and Drawings are exported to Word, Excel, PowerPoint or PNG first.

Typical uses: an iPhone photo (HEIC) to JPG, a Word document to PDF, a scanned PDF to text
(**Recognise text (scanned PDF)**), a PDF to a smaller PDF, a MOV video to MP4, a spreadsheet to CSV.
The list of formats each file can become comes from Converter Studio itself (67 formats: images,
documents, spreadsheets, slides, e-books, audio, video, subtitles and archives), so it grows without an
update of the add-on.

## Requirements

- A Google account (Gmail or Google Workspace) that may install add-ons. Nothing else: the add-on signs
  you in to Converter Studio with that Google account, and makes a free Converter Studio account the first
  time if you have none. Free accounts get 13 credits a day; most photos and documents cost 1 credit; audio
  and video are priced by their length, and video also by its frame size. See
  [pricing](https://converter.studio/pricing).

## Installation

Install **Converter Studio** from the Google Workspace Marketplace, then open Gmail or Google Drive and
click the Converter Studio icon in the side panel. Google asks you to allow the permissions below once.

## Sign in

Click **Continue with Google** on the add-on's card. Converter Studio checks Google's sign-in for your
Google account and uses the Converter Studio account of that Google account, or the one with its e-mail
address, or makes a free one. It is the same account, plan and credits as on
[converter.studio](https://converter.studio) and in Converter Studio's apps. By creating an account, you
agree to the [Terms of Service](https://converter.studio/terms) and the
[Privacy policy](https://converter.studio/privacy).

The sign-in lasts an hour and renews by itself while you use the add-on. The add-on keeps it in its _user
properties_ (Apps Script's `PropertiesService`): Google stores it with your Google account for this add-on
only, other people who use the add-on cannot see it, and only the add-on's own code reads it, while you use
it. It is sent only to `https://converter.studio/api`, never with an upload or download link.

Renewing never makes an account: if you delete your Converter Studio account, the add-on signs out at
its next request and makes a new one only when you click **Continue with Google** again.

If your e-mail address already has a Converter Studio account that was never verified, sign in once at
converter.studio with its password: you get a link to verify it, and then **Continue with Google** works.

## Settings

Open **Settings** (the add-on's ⋮ menu, or the home card). It shows the account you are signed in with,
its plan and its credits.

| Setting                                                    | What it does                                                                                                                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ask before a conversion that costs more than (credits)** | Default 20. A dearer conversion (a long video) waits until you click **Convert for N credits**, and costs nothing until then.                                                          |
| **Sign out**                                               | Forgets the add-on's sign-in; it asks you to sign in again next time. To take away the add-on's access to your Google account, use your Google Account's third-party connections page. |

## Use

**Gmail.** Open a message and click **Show attachments** in the add-on's panel (the add-on reads the
message only when you click). Click **Convert** beside an attachment, pick the format and click
**Convert**. When it is done:

- **Download** opens the converted file (the link works for 6 hours);
- **Save to Google Drive** puts it in a **Converter Studio** folder in My Drive (made once, then reused);
- **Reply with the file attached** opens a reply to the message with the converted file attached (files
  up to about 18 MB, Gmail's attachment limit after encoding).

**Google Drive.** Select one file. The first time, click **Allow access to this file**: Drive asks you to
let the add-on open that one file. Pick the format and click **Convert**, then **Save next to the
original** (or, when that folder takes no new files, in My Drive › Converter Studio).

Google gives an add-on 30 seconds for each click. A conversion that takes longer (a long video) keeps
running at Converter Studio: click **Check again** a little later.

## Permissions

| Permission                                              | Scope                                 | Why                                                                                |
| ------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| Run as a Gmail add-on                                   | `gmail.addons.execute`                | To show the add-on in Gmail.                                                       |
| View the open message when you interact with the add-on | `gmail.addons.current.message.action` | To read the attachments of the open message after you click **Show attachments**.  |
| Manage drafts when you interact with the add-on         | `gmail.addons.current.action.compose` | To create the reply draft with the converted file. The add-on never sends e-mail.  |
| Only the Google Drive files you use with the add-on     | `drive.file`                          | To open a file you allowed, and to save converted files. No other file is visible. |
| The name, type and id of the Drive items you select     | `drive.addons.metadata.readonly`      | To show the selected file in the panel.                                            |
| Connect to an external service                          | `script.external_request`             | To reach Converter Studio (and Drive's own API for the file you allowed).          |
| Associate you with your personal info on Google         | `openid`                              | To sign you in to Converter Studio with your Google account.                       |
| See your primary Google Account email address           | `userinfo.email`                      | The e-mail address of your Converter Studio account.                               |

The add-on never asks for full access to your mail or your Drive, nor for your name or profile picture.

## Privacy

- Only the files you choose to convert are sent to Converter Studio, over HTTPS, with your sign-in.
  Converter Studio deletes the uploaded file when the conversion finishes and the converted file 6 hours
  later. Your account keeps a short history of your conversions (file names, formats and credits). See
  the [privacy policy](https://converter.studio/privacy).
- To sign you in, the add-on sends Converter Studio Google's sign-in token for your account (about once an
  hour while you use it). Converter Studio reads your Google account's id and e-mail address from it (they
  are what links your Google account to your Converter Studio account) and does not keep the token.
- The add-on reads no message text, addresses or other messages, collects no statistics and shows no ads.
  Each request names the add-on and its version (the header `X-Converter-Studio-Client`) so Converter
  Studio can count conversions made from Google Workspace.

## Limits

- At most 50 MB a file (what Apps Script can send in one request); a larger file can be converted on
  [converter.studio](https://converter.studio) or with Converter Studio's own Google Drive app (**Open
  with → Converter Studio**). Your plan may allow less; Converter Studio's message says so.
- Google exports Docs, Sheets and Slides of at most 10 MB.
- One file at a time. Inline images of a message are not listed.

## Development

The add-on is an Apps Script project in `src/` (the manifest `appsscript.json` and plain script files;
no build step, no library). Everything except the thin Apps Script glue (`Main.js`, `Cards.js`,
`Gmail.js`) is plain JavaScript that gets its services passed in, so it runs under Node:

```sh
npm test            # Node's test runner: the scripts loaded as Apps Script loads them, with fakes
                    # of the Apps Script services held to Google's reference, and a fake API
npm run validate    # appsscript.json against the rules of Google's manifest reference
```

To try your own copy: create an Apps Script project, copy `.clasp.json.example` to `.clasp.json` with its
script id, `clasp push`, then **Deploy → Test deployments → Install**.

## Support

Write to [support@converter.studio](mailto:support@converter.studio), or open an issue at
[github.com/tariksucu/google-workspace-converter-studio](https://github.com/tariksucu/google-workspace-converter-studio/issues).

## License

[MIT](LICENSE), © Converter Studio.
