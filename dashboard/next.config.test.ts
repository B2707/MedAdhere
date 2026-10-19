import { afterEach, describe, expect, it, vi } from 'vitest';
import nextConfig from './next.config';

/** The Cognito hosted-UI origin the fallback resolves to when `COGNITO_DOMAIN` is unset. */
const FALLBACK_COGNITO_ORIGIN = 'https://medadhere-auth.auth.us-east-1.amazoncognito.com';

async function csp(): Promise<string> {
  const routes = (await nextConfig.headers?.()) ?? [];
  const route = routes.find((candidate) => candidate.source === '/:path*');
  const header = route?.headers.find((candidate) => candidate.key === 'Content-Security-Policy');
  if (!header) throw new Error('Content-Security-Policy header missing from next.config headers()');
  return header.value;
}

/**
 * next.config.ts computes SECURITY_HEADERS once at module-evaluation time (matching
 * production: Next reads next.config at build/start, not per-request). To exercise a
 * different `COGNITO_DOMAIN` we must force a fresh module evaluation, which is also what
 * actually happens across two different build environments.
 */
async function cspWithFreshEnv(): Promise<string> {
  vi.resetModules();
  const mod = await import('./next.config');
  const routes = (await mod.default.headers?.()) ?? [];
  const route = routes.find((candidate) => candidate.source === '/:path*');
  const header = route?.headers.find((candidate) => candidate.key === 'Content-Security-Policy');
  if (!header) throw new Error('Content-Security-Policy header missing from next.config headers()');
  return header.value;
}

describe('next.config security headers', () => {
  it('disables browser camera, microphone, and geolocation capabilities on every route', async () => {
    const routes = await nextConfig.headers?.();
    const allRoutes = routes ?? [];
    const route = allRoutes.find((candidate) => candidate.source === '/:path*');

    expect(allRoutes).toHaveLength(1);
    expect(route?.headers).toContainEqual({
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=()',
    });
  });

  // SIGNIN-DIAGNOSIS.md §2.D / §3 Slice C: sign-in/sign-out is a form GET that 302s
  // cross-origin to Cognito, so `form-action` must allow that origin; `connect-src`
  // is a backstop for the same origin (the real button-death fix is middleware.ts).
  describe('Cognito origin (form-action + connect-src)', () => {
    afterEach(() => {
      delete process.env.COGNITO_DOMAIN;
    });

    it('falls back to the documented literal Cognito origin when COGNITO_DOMAIN is unset', async () => {
      delete process.env.COGNITO_DOMAIN;
      const value = await cspWithFreshEnv();

      expect(value).toMatch(new RegExp(`form-action 'self' ${FALLBACK_COGNITO_ORIGIN}(?:;| |$)`));
      expect(value).toMatch(new RegExp(`connect-src 'self' ${FALLBACK_COGNITO_ORIGIN}(?:;| |$)`));
    });

    it('sources the origin from process.env.COGNITO_DOMAIN when present, stripping the path', async () => {
      process.env.COGNITO_DOMAIN = 'https://custom-pool.auth.us-east-1.amazoncognito.com/';
      const value = await cspWithFreshEnv();

      expect(value).toContain(
        "form-action 'self' https://custom-pool.auth.us-east-1.amazoncognito.com;",
      );
      expect(value).toContain(
        "connect-src 'self' https://custom-pool.auth.us-east-1.amazoncognito.com;",
      );
    });

    it('falls back (never throws) when COGNITO_DOMAIN is malformed — e.g. entered without a scheme', async () => {
      // The var is named "DOMAIN" and is re-entered by hand on the Vercel project, so a
      // scheme-less value is the realistic drift. `new URL()` throws on it, and this runs at
      // module-evaluation time — an unguarded throw fails the whole build, every route.
      process.env.COGNITO_DOMAIN = 'medadhere-auth.auth.us-east-1.amazoncognito.com';
      const value = await cspWithFreshEnv();

      expect(value).toContain(`form-action 'self' ${FALLBACK_COGNITO_ORIGIN};`);
      expect(value).toContain(`connect-src 'self' ${FALLBACK_COGNITO_ORIGIN};`);
    });

    it('does not add the Cognito origin to default-src or script-src', async () => {
      const value = await csp();
      const defaultSrc = value
        .split(';')
        .find((directive) => directive.trim().startsWith('default-src'));
      const scriptSrc = value
        .split(';')
        .find((directive) => directive.trim().startsWith('script-src'));

      expect(defaultSrc?.trim()).toBe("default-src 'self'");
      expect(scriptSrc).not.toContain(FALLBACK_COGNITO_ORIGIN);
    });
  });
});
