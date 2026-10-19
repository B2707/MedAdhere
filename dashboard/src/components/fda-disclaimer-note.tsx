import {
  FDA_DISCLAIMER_RETRIEVED_DATE,
  FDA_DISCLAIMER_SOURCE,
  FDA_LABEL_DISCLAIMER,
} from '../../../packages/shared/src/fda-disclaimer';
import { ExternalLink, Info } from 'lucide-react';

export function FdaDisclaimerNote() {
  return (
    <footer className="flex items-start gap-2 border-t border-[var(--color-border-subtle)] pt-4 text-sm text-[var(--color-ink-muted)]">
      <Info aria-hidden="true" className="mt-1 shrink-0" size={16} />
      <div className="flex flex-col gap-1">
        <p>{FDA_LABEL_DISCLAIMER}</p>
        <p>
          <a
            href={FDA_DISCLAIMER_SOURCE}
            className="inline-flex min-h-11 items-center gap-1 font-semibold text-[var(--color-ink)] underline decoration-[var(--color-accent)] decoration-2 underline-offset-4"
          >
            openFDA drug label API
            <ExternalLink aria-hidden="true" size={14} />
          </a>{' '}
          disclaimer retrieved {FDA_DISCLAIMER_RETRIEVED_DATE}.
        </p>
      </div>
    </footer>
  );
}
