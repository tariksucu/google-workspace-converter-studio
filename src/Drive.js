/* global CsErrors, CsFormats, CsSettings, CS_CONFIG */
/* eslint @typescript-eslint/no-unused-vars: ["error", { "varsIgnorePattern": "^Cs[A-Z]" }] -- Apps Script shares top-level names across the project's files */

/**
 * Google Drive through the `drive.file` permission: only the files the user opened with the add-on
 * (Drive's "allow access to this file" prompt) and the files the add-on made. Google's docs say
 * that permission works through the Drive API (Apps Script's advanced Drive service), not the
 * built-in DriveApp, so nothing here uses DriveApp.
 *
 * It gets its services passed in: `drive` is the advanced Drive service (v3), `urlFetch` is
 * UrlFetchApp (for the file's bytes: the Drive API's `alt=media` and `export`, with the add-on's
 * own OAuth token), `user` the user's properties, `checkPermission` Main.js's second look at the
 * user's permissions after Drive refused.
 */
const CsDrive = (function () {
  const FILES = 'https://www.googleapis.com/drive/v3/files/';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';

  /** Drive's error reason (`exportSizeLimitExceeded`…) from a JSON error body, if any. */
  function reasonOf(response) {
    try {
      const body = JSON.parse(response.getContentText());
      const errors = body && body.error && body.error.errors;
      return errors && errors[0] && errors[0].reason ? String(errors[0].reason) : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {{
   *   drive: { Files: { get: Function, create: Function, list: Function } },
   *   urlFetch: { fetch: Function },
   *   token: () => string,
   *   user: { getProperty: Function, setProperty: Function },
   *   remaining: () => number,
   *   checkPermission?: (scopes: string[]) => void,
   * }} deps
   *   `checkPermission`: called after Drive refused; ends the execution with Google's own
   *   permission card when one of `scopes` was not granted (the user may untick `drive.file` on
   *   Google's consent screen), returns otherwise (Main.js).
   */
  function createDriveFiles(deps) {
    const checkPermission = deps.checkPermission || (() => {});
    const FILE_SCOPES = [CS_CONFIG.scopes.driveFile];
    const BYTES_SCOPES = [CS_CONFIG.scopes.driveFile, CS_CONFIG.scopes.fetch];

    /** The file's name, type, size and folders; `fileGone` if the add-on may not see it. */
    function metadata(fileId) {
      try {
        return deps.drive.Files.get(fileId, {
          fields: 'id,name,mimeType,size,parents,trashed',
          supportsAllDrives: true,
        });
      } catch {
        checkPermission(FILE_SCOPES);
        throw new CsErrors.CsError('fileGone');
      }
    }

    /**
     * The file's bytes as a named Blob: downloaded, or exported for Google Docs, Sheets, Slides
     * and Drawings. Refuses a file over 50 MB before fetching it.
     * @returns {{ blob: object, name: string, size: number }}
     */
    function content(meta) {
      const source = CsFormats.driveSource(meta.mimeType, meta.name);
      if (source.kind === 'folder' || source.kind === 'unsupported')
        throw new CsErrors.CsError('unknownFormat');
      const id = encodeURIComponent(meta.id);
      let url;
      if (source.kind === 'download') {
        if (Number(meta.size) > CS_CONFIG.maxBytes) throw new CsErrors.CsError('sourceTooLarge');
        if (!(Number(meta.size) > 0)) throw new CsErrors.CsError('sourceEmpty');
        url = FILES + id + '?alt=media&supportsAllDrives=true';
      } else {
        url = FILES + id + '/export?mimeType=' + encodeURIComponent(source.mimeType);
      }
      const left = deps.remaining();
      if (left < 3000) throw new CsErrors.CsError('outOfTime');
      let response;
      try {
        response = deps.urlFetch.fetch(url, {
          method: 'get',
          headers: { Authorization: 'Bearer ' + deps.token() },
          muteHttpExceptions: true,
          timeoutSeconds: Math.max(1, Math.floor((left - 2000) / 1000)),
        });
      } catch {
        checkPermission(BYTES_SCOPES);
        throw new CsErrors.CsError('fileGone');
      }
      const status = response.getResponseCode();
      if (status !== 200) {
        if (reasonOf(response) === 'exportSizeLimitExceeded')
          throw new CsErrors.CsError('exportTooLarge');
        // The add-on's token without `drive.file` is refused (401 or 403).
        if (status === 401 || status === 403) checkPermission(FILE_SCOPES);
        throw new CsErrors.CsError('fileGone');
      }
      const blob = response.getBlob();
      blob.setName(source.name);
      const size = blob.getBytes().length;
      if (!size) throw new CsErrors.CsError('sourceEmpty');
      return { blob, name: source.name, size };
    }

    /** Makes a file from a Blob in a folder; Drive's answer has its id and link. */
    function create(blob, parentId) {
      return deps.drive.Files.create(
        { name: blob.getName(), parents: [parentId], mimeType: blob.getContentType() || undefined },
        blob,
        { fields: 'id,name,webViewLink,parents', supportsAllDrives: true },
      );
    }

    /** The "Converter Studio" folder in My Drive: the one the add-on made before, or a new one. */
    function appFolder() {
      const known = deps.user.getProperty(CsSettings.DRIVE_FOLDER);
      if (known) {
        try {
          const folder = deps.drive.Files.get(known, { fields: 'id,trashed,mimeType' });
          if (folder && !folder.trashed && folder.mimeType === FOLDER_MIME) return folder.id;
        } catch {
          // Deleted, or no longer the add-on's: look again below. Or `drive.file` unticked.
          checkPermission(FILE_SCOPES);
        }
      }
      const name = CS_CONFIG.driveFolderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const found = deps.drive.Files.list({
        q:
          "name = '" +
          name +
          "' and mimeType = '" +
          FOLDER_MIME +
          "' and 'root' in parents and trashed = false",
        fields: 'files(id)',
        pageSize: 1,
        spaces: 'drive',
      });
      let id = found && found.files && found.files[0] && found.files[0].id;
      if (!id) {
        id = deps.drive.Files.create(
          { name: CS_CONFIG.driveFolderName, mimeType: FOLDER_MIME, parents: ['root'] },
          undefined,
          { fields: 'id' },
        ).id;
      }
      deps.user.setProperty(CsSettings.DRIVE_FOLDER, id);
      return id;
    }

    /**
     * Saves a result in the folder of its original; where that folder takes no new files (a
     * folder shared read-only), in the "Converter Studio" folder of My Drive instead (Marketplace
     * rule: an app does not drop files into My Drive's root).
     * @returns {{ file: { id: string, name: string, webViewLink?: string }, where: 'beside' | 'appFolder' }}
     */
    function saveBeside(parents, blob) {
      const parent = parents && parents[0];
      if (parent) {
        try {
          return { file: create(blob, parent), where: 'beside' };
        } catch {
          // No write access there: the app folder below. Or `drive.file` unticked.
          checkPermission(FILE_SCOPES);
        }
      }
      return saveToAppFolder(blob);
    }

    /** Saves a result in the "Converter Studio" folder of My Drive. */
    function saveToAppFolder(blob) {
      try {
        return { file: create(blob, appFolder()), where: 'appFolder' };
      } catch (error) {
        CsErrors.passGoogleStop(error);
        checkPermission(FILE_SCOPES);
        throw new CsErrors.CsError('driveSaveFailed');
      }
    }

    return { metadata, content, appFolder, saveBeside, saveToAppFolder };
  }

  return { FILES, createDriveFiles };
})();
