'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Silently re-fetches the current server-rendered route on an interval so new
 * conversation turns appear without a manual reload. Pauses while the tab is
 * hidden; every refresh re-runs the page's no-store data fetches (D-14 reads).
 *
 * `isAuthenticated` (SIGNIN-DIAGNOSIS.md §3 Slice D): a poller that can't succeed is
 * what turns one session expiry into a storm of redirect legs — every protected page,
 * including this one left open in a background tab, independently re-enters
 * `/api/auth/login` every 10s with no de-duplication. The caller passes `false` the
 * moment its own render tells it the session is gone (an unauthenticated response),
 * so the interval stops on that render rather than depending on this component
 * happening to unmount cleanly first.
 */
export function AutoRefresh({
  intervalMs = 10_000,
  isAuthenticated = true,
}: {
  intervalMs?: number;
  isAuthenticated?: boolean;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!isAuthenticated) return;
    const tick = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const timer = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [router, intervalMs, isAuthenticated]);

  return null;
}
