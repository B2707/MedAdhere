import Link from 'next/link';
import { MessageCircle, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ReviewQueueNav({ activePath }: { activePath: string }) {
  const linkClass = (href: string) =>
    cn(
      'inline-flex min-h-11 items-center gap-2 rounded-md border px-4 text-sm font-semibold transition-colors duration-200',
      activePath === href
        ? 'border-[var(--color-accent)] bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--elev-1)]'
        : 'border-transparent text-[var(--color-ink)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface)]',
    );

  return (
    <nav
      aria-label="Review queues"
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas-raised)] p-1"
    >
      <ul className="flex flex-wrap gap-1">
        <li>
          <Link
            href="/reviews/safety"
            aria-current={activePath === '/reviews/safety' ? 'page' : undefined}
            className={linkClass('/reviews/safety')}
          >
            <ShieldCheck aria-hidden="true" size={17} />
            Safety events
          </Link>
        </li>
        <li>
          <Link
            href="/reviews/unknown"
            aria-current={activePath === '/reviews/unknown' ? 'page' : undefined}
            className={linkClass('/reviews/unknown')}
          >
            <MessageCircle aria-hidden="true" size={17} />
            Classifications and label matches
          </Link>
        </li>
      </ul>
    </nav>
  );
}
