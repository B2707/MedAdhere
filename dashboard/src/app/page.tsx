import { redirect } from 'next/navigation';

/* Root route → the dashboard. /patients is gated by the jose middleware (SC2). */
export default function Home() {
  redirect('/patients');
}
