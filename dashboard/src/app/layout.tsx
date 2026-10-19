import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { IBM_Plex_Mono, Public_Sans } from 'next/font/google';
import './globals.css';

const publicSans = Public_Sans({
  subsets: ['latin'],
  variable: '--font-public-sans',
  display: 'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'MedAdhere',
  description: 'MedAdhere clinician dashboard',
};

/*
 * Root layout. next/font downloads the supplied handoff families at build time and
 * self-hosts them, so browsers never call a third-party font service.
 *
 * `data-theme` hook (DESIGN-SPEC.md §1.2, §5 Lane B): globals.css ships a light/dark
 * pair gated on `prefers-color-scheme` PLUS a `[data-theme]` override that wins in
 * both directions. No toggle control exists yet — reading an optional `theme` cookie
 * here is what lets a future one flip the attribute server-side with zero
 * flash-of-wrong-theme; today, with no cookie set, the system preference alone decides.
 */
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const themeCookie = (await cookies()).get('theme')?.value;
  const dataTheme = themeCookie === 'dark' || themeCookie === 'light' ? themeCookie : undefined;

  return (
    <html
      lang="en"
      data-theme={dataTheme}
      className={`${publicSans.variable} ${ibmPlexMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
