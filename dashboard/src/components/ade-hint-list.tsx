import { adeHintInputSchema, buildAdeHint } from '../../../packages/shared/src/ade-hint';
import { AlertTriangle, Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * Renders label_match rows through the corrected shared DB contract. Invalid API
 * rows are omitted so a drifted value cannot produce an "undefined" hint.
 */
export function AdeHintList({
  hints,
  showElevatedBadge = true,
}: {
  hints: unknown[];
  showElevatedBadge?: boolean;
}) {
  const parsedHints = hints.flatMap((hint) => {
    const parsed = adeHintInputSchema.safeParse(hint);
    return parsed.success ? [parsed.data] : [];
  });

  if (parsedHints.length === 0) return null;

  return (
    <ul aria-label="Label-match hints" className="flex flex-col gap-2">
      {parsedHints.map((hint, index) => (
        <li
          key={`${hint.matched_phrase}-${hint.meddra_pt}-${index}`}
          className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-canvas-raised)] p-2"
        >
          {hint.hint_level === 'elevated' ? (
            <AlertTriangle
              aria-hidden="true"
              className="mt-1 shrink-0 text-[var(--color-danger-700)]"
              size={17}
            />
          ) : (
            <Info
              aria-hidden="true"
              className="mt-1 shrink-0 text-[var(--color-ink-muted)]"
              size={17}
            />
          )}
          <span className="flex flex-col items-start gap-1">
            {showElevatedBadge && hint.hint_level === 'elevated' && (
              <Badge variant="destructive">Elevated label match</Badge>
            )}
            <span className="text-sm text-[var(--color-ink-secondary)]">{buildAdeHint(hint)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
