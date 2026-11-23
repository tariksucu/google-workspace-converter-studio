/* global CsErrors */
/* eslint @typescript-eslint/no-unused-vars: ["error", { "varsIgnorePattern": "^Cs[A-Z]" }] -- Apps Script shares top-level names across the project's files */

/**
 * Signing in with the user's Google account. Plain JavaScript: it gets the user's properties,
 * Google's identity token and the API client's exchange passed in.
 *
 * - **Sign in** ("Continue with Google"): Google's identity token for the user
 *   (`ScriptApp.getIdentityToken()`, an OpenID Connect ID token, given with the `openid` and
 *   `userinfo.email` scopes) goes to Converter Studio once. Converter Studio checks it, finds the
 *   account of that Google account or makes a free one (as "Continue with Google" on
 *   converter.studio does), and answers with a session that lasts an hour.
 * - The session is kept in the user's properties (Google keeps it with this add-on and this Google
 *   account; other users never see it) and sent only to the API's own address.
 * - **Renewal** needs no click: five minutes before the session ends, or when Converter Studio
 *   refuses it, a new identity token is exchanged the same way, but asking Converter Studio not to
 *   make an account (`signUp: false`): if the user deleted their account since, the add-on signs
 *   out and says so; only a click on "Continue with Google" makes a new one.
 * - **Sign out** deletes the session. The add-on then shows the sign-in card and renews nothing
 *   until the user signs in again. The add-on's access to the Google account itself is removed in
 *   the Google account (third-party connections).
 */
const CsSession = (function () {
  const SESSION = 'CS_SESSION';
  /**
   * Where 1.0.0 kept the API key the user pasted (a key that lives until it is deleted on
   * converter.studio). Nothing reads it any more: it is deleted from the user's properties.
   */
  const LEGACY_API_KEY = 'CS_API_KEY';
  /** A session this close to its end is renewed before a request rather than refused during it. */
  const RENEW_BEFORE_MS = 5 * 60 * 1000;

  /** The stored session (`{ token, expiresAt }`, the end on the add-on's own clock), or null. */
  function read(user) {
    const raw = user.getProperty(SESSION);
    if (!raw) return null;
    try {
      const session = JSON.parse(raw);
      if (session && typeof session.token === 'string' && typeof session.expiresAt === 'number')
        return session;
    } catch {
      // Not ours: as if signed out.
    }
    return null;
  }

  function forget(user) {
    user.deleteProperty(SESSION);
  }

  /**
   * @param {{
   *   user: { getProperty: Function, setProperty: Function, deleteProperty: Function },
   *   identityToken: () => string | null,
   *   exchange: (idToken: string, signUp: boolean) => { token: string, expiresIn: number, newAccount?: boolean },
   *   now?: () => number,
   * }} options
   */
  function create(options) {
    const now = options.now || (() => Date.now());
    if (options.user.getProperty(LEGACY_API_KEY) !== null)
      options.user.deleteProperty(LEGACY_API_KEY);

    /**
     * Exchanges a fresh identity token for a session and keeps it. `signUp` false (a renewal):
     * no account is made; when there is none (deleted since), the add-on signs out.
     */
    function signIn(signUp) {
      // Null when Google has not granted `openid`; Main.js's `identityToken` then asks Google for it
      // (Google's permission card) before this says so.
      const idToken = options.identityToken();
      if (!idToken) throw new CsErrors.CsError('noIdentity');
      let answer;
      try {
        answer = options.exchange(idToken, signUp !== false);
      } catch (error) {
        if (
          error instanceof CsErrors.CsError &&
          error.params &&
          error.params.reason === 'noAccount'
        ) {
          forget(options.user);
          throw new CsErrors.CsError('accountGone');
        }
        throw error;
      }
      const session = { token: answer.token, expiresAt: now() + answer.expiresIn * 1000 };
      options.user.setProperty(SESSION, JSON.stringify(session));
      return { token: session.token, newAccount: answer.newAccount === true };
    }

    /** A renewal: never makes an account. */
    const renewal = () => signIn(false).token;

    return {
      signedIn: () => read(options.user) !== null,
      signIn: () => signIn(true),
      /**
       * The session for a request, renewed first when it is about to end (if the renewal fails
       * while the old one still has minutes left, the old one is used); null when signed out.
       */
      token() {
        const session = read(options.user);
        if (!session) return null;
        if (session.expiresAt - now() > RENEW_BEFORE_MS) return session.token;
        try {
          return renewal();
        } catch (error) {
          // Google asking for a permission (the identity token's) ends the execution here too.
          CsErrors.passGoogleStop(error);
          const gone = error instanceof CsErrors.CsError && error.code === 'accountGone';
          if (!gone && session.expiresAt > now()) return session.token;
          throw error;
        }
      },
      /** A new session after Converter Studio refused this one; null when signed out meanwhile. */
      renew() {
        return read(options.user) ? renewal() : null;
      },
      signOut: () => forget(options.user),
    };
  }

  return { SESSION, LEGACY_API_KEY, RENEW_BEFORE_MS, read, forget, create };
})();
