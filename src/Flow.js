/* global CsErrors, CS_CONFIG */
/* eslint @typescript-eslint/no-unused-vars: ["error", { "varsIgnorePattern": "^Cs[A-Z]" }] -- Apps Script shares top-level names across the project's files */

/**
 * One conversion, start to finish, within one click's time. Plain JavaScript: `client` is a
 * CsApi client and blobs are anything with Apps Script's Blob methods.
 */
const CsFlow = (function () {
  /**
   * Uploads a file, starts its conversion and waits for it while the click has time. The result
   * may still be running (`queued`, `processing`…): the card then offers "Check again".
   * @param {ReturnType<typeof CsApi.createClient>} client
   * @param {{ blob: object, fileName: string, size?: number, to: string, options?: object, maxCredits: number }} input
   */
  function convert(client, input) {
    const upload = client.upload(input.blob, input.fileName, input.size);
    const view = client.start({
      uploadId: upload.id,
      to: input.to,
      options: input.options,
      maxCredits: input.maxCredits,
    });
    return client.settle(view);
  }

  /** The conversion's state now, waiting for it while the click has time. */
  function check(client, id) {
    return client.settle(client.get(id, 0));
  }

  /** Goes ahead with a conversion that waited for a click (`quoted`), and waits for it. */
  function confirm(client, id) {
    return client.settle(client.confirm(id));
  }

  /**
   * The finished file as a Blob named after the conversion's output. Refuses a conversion that
   * is not done, and a file larger than `limitBytes` (UrlFetchApp's 50 MB by default) before
   * fetching anything.
   */
  function fetchResult(client, view, limitBytes) {
    if (!view || view.status !== 'done' || !view.downloadUrl) throw new CsErrors.CsError('notDone');
    const limit = limitBytes || CS_CONFIG.maxBytes;
    if (typeof view.outputSize === 'number' && view.outputSize > limit)
      throw new CsErrors.CsError('resultTooLarge');
    const blob = client.download(view.downloadUrl);
    if (view.outputName) blob.setName(view.outputName);
    return blob;
  }

  return { convert, check, confirm, fetchResult };
})();
