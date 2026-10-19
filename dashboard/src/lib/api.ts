import 'server-only';
import { cookies } from 'next/headers';
import type { ZodType, ZodTypeDef } from 'zod';
import { ID_TOKEN_COOKIE } from './auth';
import { dataApiUrl } from './cognito';

/**
 * api.ts — the typed, server-only Bearer fetch wrapper for the data API (06-03a).
 *
 * Formalizes the RSC data-fetch pattern first written inline in
 * `patients/page.tsx:33-55`: read the Cognito `id_token` cookie, forward it as a
 * `Bearer` header to the internal data API (server-to-server, D-10), never cache
 * (`no-store` — reads must reflect live state), and map the response to a small
 * discriminated union the caller can render exhaustively.
 *
 * `import 'server-only'` (D-14): this module — like the whole dashboard tier — must
 * never end up in a Client Component bundle. It forwards a session token and talks to
 * the in-VPC data API; the bundler errors if a Client Component imports it.
 *
 * 06-03b adopts this in patients/page.tsx; W3's drill-down/queue pages consume it too.
 */

/** The result of a data-API read, discriminated on `status`. */
export type ApiResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'unauthenticated' }
  | { status: 'error' }
  | { status: 'not_found' };

type CollectionApiResult<T> = Exclude<ApiResult<T>, { status: 'not_found' }>;

interface ApiFetchOptions {
  includeNotFound: true;
}

/**
 * Fetch `path` (an absolute API path beginning with `/`, e.g. `/api/patients`) from
 * the data API, forwarding the caller's `id_token` as a Bearer token.
 *
 * - No `id_token` cookie, or a 401 from the API → `{ status: 'unauthenticated' }`.
 * - 404 → `{ status: 'not_found' }` when a detail reader opts in; otherwise the
 *   historical collection-route behavior remains `{ status: 'error' }`.
 * - Any other non-2xx, or a network/parse failure → `{ status: 'error' }` (never
 *   leaks internals; the caller renders a calm error state).
 * - 2xx → `{ status: 'ok', data }`, with `data` typed as the caller's `T`.
 */
// `ZodType<T, ZodTypeDef, unknown>` pins `T` to the schema's OUTPUT type, so schemas whose input
// differs from their output (e.g. `.default()`-tolerant contract fields) still yield the parsed
// output type to callers — `safeParse` accepts unknown JSON either way.
export function apiFetch<T>(
  path: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  options: ApiFetchOptions,
): Promise<ApiResult<T>>;
export function apiFetch<T>(
  path: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<CollectionApiResult<T>>;
export async function apiFetch<T>(
  path: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  options?: ApiFetchOptions,
): Promise<ApiResult<T>> {
  const idToken = (await cookies()).get(ID_TOKEN_COOKIE)?.value;
  if (!idToken) {
    // No session token to forward — surface as the unauthenticated state.
    return { status: 'unauthenticated' };
  }

  try {
    const res = await fetch(`${dataApiUrl()}${path}`, {
      headers: { Authorization: `Bearer ${idToken}` },
      cache: 'no-store',
    });

    if (res.status === 401) return { status: 'unauthenticated' };
    if (res.status === 404) {
      return options?.includeNotFound === true ? { status: 'not_found' } : { status: 'error' };
    }
    if (!res.ok) return { status: 'error' };

    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) {
      // A contract drift used to vanish silently into the calm error state. Log the request path
      // plus issue PATHS and CODES only ("messages.8.clarification_topic invalid_enum_value") —
      // never `issue.message` or response content, both of which quote received values (PHI).
      console.error(
        `apiFetch contract mismatch ${path}: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.code}`)
          .join(', ')}`,
      );
      return { status: 'error' };
    }
    return { status: 'ok', data: parsed.data };
  } catch {
    // Network failure / data API unreachable / bad JSON — calm error, no internals.
    return { status: 'error' };
  }
}
