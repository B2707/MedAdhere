import type { NextConfig } from 'next';

/**
 * Next.js config for the MedAdhere dashboard.
 *
 * Host = Vercel (SC5 decision 2026-06-19 — the Amplify fallback). Vercel builds and
 * runs Next.js App Router SSR natively, installing the self-contained `dashboard/`
 * workspace directly, so NO `output: 'standalone'` and NO `outputFileTracingRoot`
 * are needed — both were Amplify WEB_COMPUTE self-hosting accommodations (the latter
 * the IN-03 hoisted-deps fix) and on Vercel they caused a doubled build path
 * (`/vercel/path0/path0/.next` → ENOENT routes-manifest) and the standalone server to
 * nest, so they are removed for the Vercel host.
 *
 * The dashboard tier never touches RDS (D-14): all data access is server-to-server
 * over the public data-API URL.
 */
/**
 * The Cognito hosted-UI origin, e.g. `https://medadhere-auth.auth.us-east-1.amazoncognito.com`.
 *
 * Sourced from `COGNITO_DOMAIN` (same var `src/lib/cognito.ts#cognitoDomain()` reads) but,
 * unlike that helper, this MUST NOT throw on a missing env: it runs at header-build time for
 * every response, so a missing build var would otherwise emit a CSP that blocks sign-in for
 * the whole app (SIGNIN-DIAGNOSIS.md §3 Slice C). Falls back to the known deployed domain
 * (`COGNITO_DOMAIN_PREFIX = 'medadhere-auth'` in `infra/lib/constructs/auth.ts`, region
 * `us-east-1` per project decision record).
 *
 * MALFORMED is guarded as well as MISSING. `SECURITY_HEADERS` is a module-level const, so this
 * runs at next.config evaluation time — a scheme-less value (the var is named "DOMAIN", and
 * these are re-entered BY HAND on the Vercel project) would make `new URL()` throw and fail the
 * whole build/boot, taking down every route rather than just sign-in.
 */
const FALLBACK_COGNITO_ORIGIN = 'https://medadhere-auth.auth.us-east-1.amazoncognito.com';

function cognitoAuthOrigin(): string {
  const domain = process.env.COGNITO_DOMAIN;
  if (!domain) return FALLBACK_COGNITO_ORIGIN;
  try {
    return new URL(domain.replace(/\/$/, '')).origin;
  } catch {
    return FALLBACK_COGNITO_ORIGIN;
  }
}

/**
 * D10 — dashboard security headers (Phase-6 OPS-03; the Phase-2 deferred
 * "before Phase 6" CSP/HSTS/X-Frame-Options obligation, applied here as code).
 * Sent on every response via Next's `headers()`.
 *
 * - HSTS `max-age=63072000; includeSubDomains` — Vercel already preloads its own
 *   domains, so this is belt-and-suspenders there and the meaningful control for a
 *   custom domain. `preload` is intentionally omitted (only add it if actually
 *   submitting the domain to the HSTS preload list).
 * - CSP allows `'unsafe-inline'` for script/style — an ACCEPTED RESIDUAL (Recharts +
 *   Next inline styles/hydration). A nonce-based CSP is explicitly out of scope for
 *   this honours project. `connect-src 'self'` is safe because all data-API access is
 *   server-to-server in RSC (D-14) — the browser makes no cross-origin fetch.
 * - `form-action 'self' <cognito-origin>` (SIGNIN-DIAGNOSIS.md §2.D / §3 Slice C) — every
 *   sign-in/sign-out control is a `<form method="get">` that immediately 302s cross-origin
 *   to the Cognito hosted UI. Without the Cognito origin here, browsers that re-check
 *   `form-action` on the redirect target (not Chromium, but not guaranteed elsewhere) kill
 *   every auth button in the app.
 * - `connect-src 'self' <cognito-origin>` is a backstop only (plan item 4.3) — it does NOT
 *   by itself fix the expired-session "buttons die silently" fault. That fault is the
 *   middleware's cross-origin 307 on Server Actions/RSC fetches (§2.C), which no `fetch`
 *   can complete regardless of CSP; the real fix is the method-aware redirect in
 *   `middleware.ts` (Slice A).
 */
const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    // next dev needs eval for react-refresh/source maps; production keeps the strict policy.
    value: `default-src 'self'; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${cognitoAuthOrigin()}; frame-ancestors 'none'; base-uri 'self'; form-action 'self' ${cognitoAuthOrigin()}; object-src 'none'`,
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
