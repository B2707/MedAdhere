/**
 * Shared cookie options for the auth flow.
 *
 * L5 — the `Secure` flag is HOST-CONDITIONAL. `http://localhost:3000` is an
 * allow-listed callback host (D-02), but an unconditional `Secure` cookie is
 * dropped over plain HTTP, so local login silently fails to persist. We set
 * `secure: true` only in production (HTTPS), `false` on localhost/HTTP.
 *
 * All auth cookies are `httpOnly` + `SameSite=lax` UNCONDITIONALLY (D-06):
 * httpOnly blocks XSS token theft (T-02-13); SameSite=lax is part of the CSRF
 * defense for the OAuth callback (T-02-14).
 */

/** True when running in a production (HTTPS) deployment. */
export function isProdHost(): boolean {
  return process.env.NODE_ENV === 'production';
}

interface AuthCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge?: number;
}

/** Options for the long-lived session cookies (id_token / refresh_token). */
export function sessionCookieOptions(): AuthCookieOptions {
  return {
    httpOnly: true,
    secure: isProdHost(),
    sameSite: 'lax',
    path: '/',
  };
}

/** Options for the short-lived PKCE/state cookies (cleared after callback). */
export function shortLivedCookieOptions(): AuthCookieOptions {
  return {
    httpOnly: true,
    secure: isProdHost(),
    sameSite: 'lax',
    path: '/',
    maxAge: 600, // 10 minutes — long enough for the managed-login round-trip
  };
}

/**
 * H1 / CR-01 — delete an auth cookie at the SAME `Path=/` it was written with.
 *
 * `ResponseCookies.delete(name)` emits `Set-Cookie: name=; Max-Age=0` with NO
 * `Path` attribute, so the browser scopes the deletion to the response URL's
 * default path (e.g. `/api/auth/logout`). Per RFC 6265 a deletion only clears a
 * stored cookie when the `Path` matches — so a no-path delete is a NO-OP on the
 * `Path=/` auth cookies and the session/PKCE/state cookies survive. Always pass
 * `{ name, path:'/' }` so the `Set-Cookie` matches what was written.
 */
export function deleteCookie(
  res: { cookies: { delete: (opts: { name: string; path: string }) => unknown } },
  name: string,
): void {
  res.cookies.delete({ name, path: '/' });
}
