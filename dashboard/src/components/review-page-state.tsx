import { AlertTriangle, XCircle } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/*
 * ReviewPageState — the ONE unauthenticated/error surface shared by every review-queue page
 * (Lane F). Clinical Swiss token pass only: no behavior change here (SIGNIN-DIAGNOSIS.md §3
 * Slice D). The sign-in control stays a plain form GET to `/api/auth/login` — Slice C's CSP
 * change (`form-action 'self' <cognito-origin>`) is what makes that redirect complete, not a
 * client-side navigation, so this file must NOT convert it to a `<Link>` or an onClick handler.
 */
export function ReviewPageState({
  pageTitle,
  title,
  message,
  signIn = false,
  retryPath,
}: {
  pageTitle: string;
  title: string;
  message: string;
  signIn?: boolean;
  retryPath: string;
}) {
  return (
    <AppShell pageTitle={pageTitle} pageDescription="Clinical review queue">
      <Card className="mx-auto max-w-[42rem]">
        <CardHeader>
          <div className="flex items-center gap-2">
            {signIn ? (
              <XCircle aria-hidden="true" className="text-[var(--color-danger-700)]" size={24} />
            ) : (
              <AlertTriangle
                aria-hidden="true"
                className="text-[var(--color-danger-700)]"
                size={24}
              />
            )}
            <CardTitle>{title}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="mt-4 flex flex-col items-start gap-4">
          <p>{message}</p>
          {/* Form GET stays (SIGNIN-DIAGNOSIS.md §3 Slice D) — never a Link or client navigation. */}
          <form action={signIn ? '/api/auth/login' : retryPath} method="get">
            <Button type="submit" variant={signIn ? 'primary' : 'secondary'}>
              {signIn ? 'Sign in' : 'Retry'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </AppShell>
  );
}
