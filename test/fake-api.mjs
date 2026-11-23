/**
 * An in-process Converter Studio API for the unit tests: the routes the add-on calls, with the
 * real API's answers (https://converter.studio/developers; `ConversionView`, the error body,
 * Idempotency-Key replays, `?wait=`). The formats list is the real one (fixtures/formats.json,
 * the API's own answer). The time it takes is simulated on a shared clock, so a long conversion
 * costs no real time.
 *
 * Scenarios by the uploaded file's name: "slow" takes 90 s, "quote" costs 30 credits, "broken"
 * fails, "big" reports a 30 MB result; anything else is done after 3 s for 1 credit.
 *
 * Sign-in as the real API does it (`POST /v1/google-workspace/session`): an identity token issued
 * to AUDIENCE, not expired, with a verified e-mail, becomes an hour's session; a new Google
 * account gets a free account. The fake reads the token's claims without a signature (the real
 * API's checks are tested in apps/api and by e2e/run.mjs).
 */
import { readFileSync } from 'node:fs';

/** The add-on's OAuth client id, which identity tokens must be issued to. */
export const AUDIENCE = '123456789012-addon.apps.googleusercontent.com';
/** The Google account a test world signs in as, with a Pro account behind it. */
export const ADA = { sub: '1001', email: 'reader@example.com' };
/** A session the fake API knows from the start: a world begins signed in with it. */
export const SESSION = 'cvs_gws_' + 'S'.repeat(48);
export const FORMATS = JSON.parse(
  readFileSync(new URL('./fixtures/formats.json', import.meta.url), 'utf8'),
);
const SIGN_IN_FAILED =
  "Signing in with Google didn't work. Please try again. If it keeps failing, sign in at converter.studio.";

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  body,
});
const fail = (status, code, message, params) =>
  json(status, { error: { code, message, ...(params ? { params } : {}) } });

export function fakeApi({
  base = 'https://converter.studio/api',
  clock,
  partBytes = 95 * 1024 * 1024,
} = {}) {
  const uploads = new Map();
  const conversions = new Map();
  const keys = new Map();
  /** Converter Studio accounts by Google id, and the sessions handed out (token → Google id). */
  const accounts = new Map([[ADA.sub, { email: ADA.email, plan: 'pro', credits: 480 }]]);
  const sessions = new Map([[SESSION, { sub: ADA.sub, expiresAt: clock.now + 3600_000 }]]);
  const state = {
    uploads,
    conversions,
    keys,
    accounts,
    sessions,
    /** The claims of every identity token sent to the exchange. */
    exchanges: [],
    /** E-mails of accounts the exchange will not join (unverified address): 409. */
    notLinked: new Set(),
    /** The add-on's sign-in switched off on the server: the exchange is 404. */
    signInOff: false,
    failNext: null,
    dropNext: null,
    partBytes,
  };
  let n = 0;

  const formatOf = (name) => {
    const lower = String(name).toLowerCase();
    let best = null;
    for (const f of FORMATS.formats)
      for (const e of f.extensions)
        if (lower.endsWith('.' + e) && (!best || e.length > best.e.length)) best = { id: f.id, e };
    return best?.id ?? null;
  };
  const extensionOf = (id) => FORMATS.formats.find((f) => f.id === id)?.extensions[0] ?? id;

  function settle(c) {
    if ((c.status === 'queued' || c.status === 'processing') && clock.now >= c.settleAt) {
      if (c.inputName.includes('broken')) {
        c.status = 'failed';
        c.error = {
          code: 'conversionFailed',
          message: 'This file is damaged and could not be read.',
        };
      } else {
        c.status = 'done';
      }
    } else if (c.status === 'queued' && clock.now >= c.startedAt + 1000) {
      c.status = 'processing';
    }
  }

  function view(c) {
    settle(c);
    const done = c.status === 'done';
    const base64 = c.inputName.replace(/\.[^.]+$/, '');
    const outputName = `${base64}.${extensionOf(c.to)}`;
    return {
      id: c.id,
      status: c.status,
      from: c.from,
      to: c.to,
      inputName: c.inputName,
      inputSize: c.inputSize,
      credits: c.credits,
      maxCredits: c.maxCredits,
      progress: done ? 1 : c.status === 'processing' ? 0.4 : null,
      outputName: done ? outputName : null,
      outputSize: done ? (c.inputName.includes('big') ? 30_000_000 : c.output.length) : null,
      downloadUrl: done ? `${base}/jobs/${c.id}/download?token=tok_${c.id}` : null,
      expiresAt: new Date(c.startedAt + 6 * 3600_000).toISOString(),
      error: c.error ?? null,
      next: '…',
    };
  }

  function handler(request) {
    clock.now += 100;
    if (!request.url.startsWith(base + '/')) return null;
    if (state.dropNext && request.method === state.dropNext) {
      state.dropNext = null;
      throw { network: true };
    }
    const url = new URL(request.url);
    const path = url.pathname.slice(new URL(base).pathname.length);
    const bearer = String(request.headers.Authorization ?? '').replace(/^Bearer /, '');
    const live = sessions.get(bearer);
    const account = live && live.expiresAt > clock.now ? accounts.get(live.sub) : null;
    const body = () => JSON.parse(request.body?.toString('utf8') ?? 'null');

    if (request.method === 'GET' && path === '/v1/formats')
      return json(200, { formats: FORMATS.formats });

    const download = /^\/jobs\/([^/]+)\/download$/.exec(path);
    if (request.method === 'GET' && download) {
      const c = conversions.get(download[1]);
      if (!c || url.searchParams.get('token') !== `tok_${c.id}` || view(c).status !== 'done')
        return fail(404, 'notFound', 'This file is not here.');
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment',
        },
        body: c.output,
      };
    }

    const put = /^\/v1\/uploads\/([^/]+)$/.exec(path);
    if (request.method === 'PUT' && put) {
      const u = uploads.get(put[1]);
      if (!u || url.searchParams.get('token') !== `tok_${u.id}`)
        return fail(404, 'notFound', 'No such upload.');
      if (request.headers['Content-Type'] !== 'application/octet-stream')
        return fail(400, 'invalidRequest', 'Send the bytes as application/octet-stream.');
      const offset =
        request.headers['Upload-Offset'] === undefined
          ? 0
          : Number(request.headers['Upload-Offset']);
      if (offset !== u.received.length) return fail(409, 'invalidRequest', 'Wrong offset.');
      u.received = Buffer.concat([u.received, request.body]);
      if (u.received.length < u.size)
        return json(200, { status: 'partial', received: u.received.length });
      u.ready = true;
      return json(200, { status: 'ready', file: { format: formatOf(u.fileName) } });
    }

    if (request.method === 'POST' && path === '/v1/google-workspace/session') {
      // Switched off, the path is unknown to the server: its 404 has no message.
      if (state.signInOff) return json(404, { error: 'notFound' });
      let claims = null;
      try {
        claims = JSON.parse(Buffer.from(body().idToken.split('.')[1], 'base64url').toString());
      } catch {
        // Not a token.
      }
      state.exchanges.push(claims);
      const refuse = (reason) => fail(401, 'googleSignInFailed', SIGN_IN_FAILED, { reason });
      if (!claims) return refuse('malformed');
      if (claims.aud !== AUDIENCE) return refuse('audience');
      if (!(claims.exp * 1000 > clock.now)) return refuse('expired');
      if (!claims.email) return refuse('noEmail');
      if (claims.email_verified !== true) return refuse('emailUnverified');
      if (state.notLinked.has(claims.email))
        return fail(
          409,
          'googleAccountNotLinked',
          "An account with this email address already exists at converter.studio, but the address isn't verified yet. Sign in there with your password and we'll send you a link to verify it, then try again.",
        );
      const newAccount = !accounts.has(claims.sub);
      // A renewal finds the account but makes none.
      if (newAccount && body().signUp === false) return refuse('noAccount');
      if (newAccount) accounts.set(claims.sub, { email: claims.email, plan: 'guest', credits: 13 });
      const token = `cvs_gws_fake${++n}`;
      sessions.set(token, { sub: claims.sub, expiresAt: clock.now + 3600_000 });
      return json(200, {
        token,
        tokenType: 'Bearer',
        expiresAt: new Date(clock.now + 3600_000).toISOString(),
        expiresIn: 3600,
        newAccount,
      });
    }

    if (!account)
      return fail(401, 'googleSignInFailed', SIGN_IN_FAILED, { reason: 'sessionEnded' });

    if (request.method === 'GET' && path === '/v1/account')
      return json(200, {
        email: account.email,
        plan: account.plan,
        credits: account.credits,
        allApps: account.plan !== 'guest',
      });

    if (request.method === 'POST' && path === '/v1/uploads') {
      const { fileName, size } = body();
      if (size > 100_000_000)
        return fail(
          413,
          'fileTooLarge',
          'This file is larger than 100 MB, the limit on your plan.',
        );
      const id = 'up' + ++n;
      uploads.set(id, { id, fileName, size, received: Buffer.alloc(0), ready: false });
      return json(201, {
        id,
        uploadUrl: `${base}/v1/uploads/${id}?token=tok_${id}`,
        method: 'PUT',
        maxBytes: 100_000_000,
        partBytes: state.partBytes,
        expiresAt: new Date(clock.now + 3600_000).toISOString(),
      });
    }

    if (request.method === 'POST' && path === '/v1/conversions') {
      const input = body();
      const key = request.headers['Idempotency-Key'];
      const fingerprint = JSON.stringify([
        input.uploadId,
        input.to,
        input.options ?? null,
        input.maxCredits ?? 20,
      ]);
      if (key && keys.has(key)) {
        const prior = keys.get(key);
        if (prior.fingerprint !== fingerprint)
          return fail(
            409,
            'idempotencyKeyReused',
            'This Idempotency-Key was used for another request.',
          );
        return json(200, view(conversions.get(prior.id)), { 'Idempotent-Replayed': 'true' });
      }
      const u = uploads.get(input.uploadId);
      if (!u || !u.ready) return fail(404, 'notFound', 'No such upload.');
      const from = formatOf(u.fileName);
      const targets = FORMATS.formats.find((f) => f.id === from)?.to ?? [];
      if (!targets.includes(input.to))
        return fail(
          422,
          'unsupportedConversion',
          `Converter Studio cannot make ${input.to} from this file.`,
        );
      const credits = u.fileName.includes('quote') ? 30 : 1;
      const maxCredits = input.maxCredits ?? 20;
      const c = {
        id: u.id,
        from,
        to: input.to,
        options: input.options ?? null,
        inputName: u.fileName,
        inputSize: u.size,
        credits,
        maxCredits,
        startedAt: clock.now,
        settleAt: clock.now + (u.fileName.includes('slow') ? 90_000 : 3000),
        status: credits > maxCredits ? 'quoted' : 'queued',
        output: Buffer.from(`converted ${u.fileName} to ${input.to}`),
      };
      conversions.set(c.id, c);
      uploads.delete(u.id);
      if (key) keys.set(key, { fingerprint, id: c.id });
      if (state.failNext === 'POST /v1/conversions') {
        // The conversion is made, but its answer is lost on the way back.
        state.failNext = null;
        return fail(503, 'serverBusy', 'Converter Studio is busy.');
      }
      return json(201, view(c));
    }

    const one = /^\/v1\/conversions\/([^/]+)(\/confirm)?$/.exec(path);
    if (one) {
      const c = conversions.get(one[1]);
      if (!c) return fail(404, 'notFound', 'Converter Studio has no conversion with this id.');
      if (request.method === 'POST' && one[2]) {
        if (c.status === 'quoted') {
          c.status = 'queued';
          c.startedAt = clock.now;
          c.settleAt = clock.now + 3000;
        }
        return json(200, view(c));
      }
      if (request.method === 'GET' && !one[2]) {
        const wait = Number(url.searchParams.get('wait') ?? 0);
        if (wait > 0) {
          settle(c);
          if (c.status === 'queued' || c.status === 'processing') {
            clock.now += Math.max(0, Math.min(wait * 1000, c.settleAt - clock.now));
          }
        }
        return json(200, view(c));
      }
    }
    return fail(404, 'notFound', 'No such route.');
  }

  return { handler, state };
}
