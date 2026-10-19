import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function tokenValue(css: string, token: string): string {
  const match = css.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`));
  if (match?.[1] === undefined) throw new Error(`Missing ${token}`);
  return match[1];
}

/** Reads a token's value from inside the explicit `:root[data-theme='dark']` block only —
 *  the same token name also appears (with a different value) in the light `@theme` block
 *  and inside the `@media (prefers-color-scheme: dark)` block, so a plain `tokenValue`
 *  scan would find the wrong occurrence. */
function darkTokenValue(css: string, token: string): string {
  const block = css.match(/:root\[data-theme=['"]dark['"]]\s*\{([^}]*)\}/s)?.[1];
  if (block === undefined) throw new Error("Missing :root[data-theme='dark'] block");
  return tokenValue(block, token);
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('dashboard visual contract — Clinical Swiss token system (DESIGN-SPEC.md §1)', () => {
  const css = readFileSync(resolve(process.cwd(), 'dashboard/src/app/globals.css'), 'utf8');

  describe('light neutrals + accent (§1.1)', () => {
    it('declares the full neutral ramp', () => {
      expect(css).toContain('--color-canvas: #edf1f7');
      expect(css).toContain('--color-canvas-raised: #f1f5f9');
      expect(css).toContain('--color-surface: #ffffff');
      expect(css).toContain('--color-surface-hover: #f8fafc');
      expect(css).toContain('--color-border-subtle: #e2e8f0');
      expect(css).toContain('--color-border: #cbd5e1');
      expect(css).toContain('--color-border-strong: #64748b');
      expect(css).toContain('--color-ink: #0f172a');
      expect(css).toContain('--color-ink-secondary: #334155');
      expect(css).toContain('--color-ink-muted: #475569');
    });

    it('declares the reserved accent ramp', () => {
      expect(css).toContain('--color-accent-50: #f0fdfa');
      expect(css).toContain('--color-accent-100: #ccfbf1');
      expect(css).toContain('--color-accent-graphic: #0d9488');
      expect(css).toContain('--color-accent: #0f766e');
      expect(css).toContain('--color-accent-hover: #115e59');
      expect(css).toContain('--color-accent-press: #134e4a');
      expect(css).toContain('--color-on-accent: #ffffff');
    });

    it('meets AAA body-text contrast on --color-surface for the ink ramp', () => {
      const surface = tokenValue(css, '--color-surface');
      expect(contrastRatio(tokenValue(css, '--color-ink'), surface)).toBeGreaterThanOrEqual(7);
      expect(
        contrastRatio(tokenValue(css, '--color-ink-secondary'), surface),
      ).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(tokenValue(css, '--color-ink-muted'), surface)).toBeGreaterThanOrEqual(
        7,
      );
    });

    it('meets AA text contrast (≥4.5:1) for the accent and its on-color', () => {
      const surface = tokenValue(css, '--color-surface');
      expect(contrastRatio(tokenValue(css, '--color-accent'), surface)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(tokenValue(css, '--color-on-accent'), tokenValue(css, '--color-accent')),
      ).toBeGreaterThanOrEqual(4.5);
    });

    it('meets ≥3:1 graphics contrast for --color-accent-graphic', () => {
      expect(
        contrastRatio(
          tokenValue(css, '--color-accent-graphic'),
          tokenValue(css, '--color-surface'),
        ),
      ).toBeGreaterThanOrEqual(3);
    });
  });

  describe('semantic tier ramp (§1.1) — the load-bearing set', () => {
    it('declares a 50-tint fill + 700-tier text for every tier', () => {
      expect(css).toContain('--color-danger-50: #fef2f2');
      expect(css).toContain('--color-danger-700: #b91c1c');
      expect(css).toContain('--color-warning-50: #fffbeb');
      expect(css).toContain('--color-warning-700: #b45309');
      expect(css).toContain('--color-success-50: #ecfdf5');
      expect(css).toContain('--color-success-700: #047857');
      expect(css).toContain('--color-info-50: #eff6ff');
      expect(css).toContain('--color-info-700: #1d4ed8');
      expect(css).toContain('--color-neutral-50: #f1f5f9');
      expect(css).toContain('--color-neutral-700: #475569');
    });

    it('every 700-tier color meets ≥4.5:1 as text on --color-surface', () => {
      const surface = tokenValue(css, '--color-surface');
      for (const tier of ['danger', 'warning', 'success', 'info', 'neutral']) {
        const ratio = contrastRatio(tokenValue(css, `--color-${tier}-700`), surface);
        expect(ratio, `${tier}-700 on surface`).toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  describe('dark mode (§1.2) — desaturated tonal variants, verified independently', () => {
    it('gates the palette on prefers-color-scheme AND an explicit [data-theme] override', () => {
      expect(css).toMatch(/@media \(prefers-color-scheme:\s*dark\)/);
      expect(css).toMatch(/:root:not\(\[data-theme=['"]light['"]]\)/);
      expect(css).toMatch(/:root\[data-theme=['"]dark['"]]/);
    });

    it('sets color-scheme: light dark (not light-only) so native controls follow the theme', () => {
      expect(css).toMatch(/html\s*\{[^}]*color-scheme:\s*light dark;/s);
    });

    it('every dark token has a light counterpart declared in @theme (never dark-only)', () => {
      const themeBlock = css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
      const darkBlock = css.match(/:root\[data-theme=['"]dark['"]]\s*\{([^}]*)\}/s)?.[1] ?? '';
      const darkTokenNames = [...darkBlock.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]);
      expect(darkTokenNames.length).toBeGreaterThan(10);
      for (const name of darkTokenNames) {
        expect(themeBlock, `${name} must have a light (@theme) definition`).toContain(`${name}:`);
      }
    });

    it('declares the dark neutral + accent ramp', () => {
      expect(darkTokenValue(css, '--color-canvas')).toBe('#0b1220');
      expect(darkTokenValue(css, '--color-surface')).toBe('#18212f');
      expect(darkTokenValue(css, '--color-ink')).toBe('#f1f5f9');
      expect(darkTokenValue(css, '--color-accent')).toBe('#2dd4bf');
      expect(darkTokenValue(css, '--color-on-accent')).toBe('#042f2e');
    });

    it('meets AA/AAA contrast independently in dark mode (not inferred from light)', () => {
      const darkSurface = darkTokenValue(css, '--color-surface');
      expect(contrastRatio(darkTokenValue(css, '--color-ink'), darkSurface)).toBeGreaterThanOrEqual(
        7,
      );
      expect(
        contrastRatio(darkTokenValue(css, '--color-ink-muted'), darkSurface),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(darkTokenValue(css, '--color-accent'), darkSurface),
      ).toBeGreaterThanOrEqual(4.5);
      for (const tier of ['danger', 'warning', 'success', 'info', 'neutral']) {
        const ratio = contrastRatio(darkTokenValue(css, `--color-${tier}-700`), darkSurface);
        expect(ratio, `dark ${tier}-700 on dark surface`).toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  describe('type scale (§1.3) — base 16px, hard floor 12px', () => {
    it('declares all 8 steps with the spec sizes', () => {
      const sizes: Record<string, string> = {
        xs: '12px',
        sm: '13px',
        base: '15px',
        md: '17px',
        lg: '20px',
        xl: '26px',
        '2xl': '34px',
        input: '16px',
      };
      for (const [step, px] of Object.entries(sizes)) {
        expect(css, `--text-${step}`).toMatch(new RegExp(`--text-${step}:\\s*${px};`));
      }
    });

    it('enforces --text-input on every native form control at the base layer (F2 cannot drift)', () => {
      expect(css).toMatch(
        /input,\s*\n\s*select,\s*\n\s*textarea\s*\{\s*\n\s*font-size:\s*var\(--text-input\)/,
      );
    });

    it('does not redeclare a redundant custom font-weight scale (Tailwind defaults already match 400/500/600/700)', () => {
      expect(css).not.toContain('--font-weight-regular');
    });
  });

  describe('radius (§1.5) — 3 steps + full', () => {
    it('declares the radius scale', () => {
      expect(css).toContain('--radius-sm: 6px');
      expect(css).toContain('--radius-md: 10px');
      expect(css).toContain('--radius-lg: 16px');
      expect(css).toContain('--radius-full: 9999px');
    });

    it('deletes the old ad-hoc radius tokens', () => {
      expect(css).not.toContain('--radius-card');
      expect(css).not.toContain('--radius-control');
    });
  });

  describe('elevation (§1.5) — 4-step ladder', () => {
    it('declares 4 steps, distinct from the Tailwind --shadow-* namespace', () => {
      expect(css).toContain('--elev-0: none');
      expect(css).toMatch(/--elev-1:\s*0 1px 2px rgb\(15 23 42 \/ 0\.06\)/);
      expect(css).toMatch(/--elev-2:\s*0 2px 4px rgb\(15 23 42 \/ 0\.06\)/);
      expect(css).toMatch(/--elev-3:\s*0 12px 24px -6px rgb\(15 23 42 \/ 0\.12\)/);
    });

    it('dark elevation reuses light geometry with rgb(0 0 0 / .5) plus a 1px top highlight', () => {
      const darkBlock = css.match(/:root\[data-theme=['"]dark['"]]\s*\{([^}]*)\}/s)?.[1] ?? '';
      expect(darkBlock).toMatch(
        /--elev-1:.*inset 0 1px 0 rgb\(255 255 255 \/ 0\.04\).*rgb\(0 0 0 \/ 0\.5\)/s,
      );
    });

    it('deletes the old 2-step shadow tokens', () => {
      expect(css).not.toContain('--shadow-card');
      expect(css).not.toContain('--shadow-raised');
    });
  });

  describe('motion (§1.6) — existing tokens kept, --motion-exit added', () => {
    it('keeps the existing rhythm', () => {
      expect(css).toContain('--motion-fast: 180ms');
      expect(css).toContain('--motion-normal: 350ms');
      expect(css).toContain('--ease-smooth: cubic-bezier(0.22, 1, 0.36, 1)');
      expect(css).toContain('--ease-sharp: cubic-bezier(0.4, 0, 0.2, 1)');
    });

    it('adds --motion-exit at ~65% of --motion-fast', () => {
      expect(css).toContain('--motion-exit: 120ms');
    });

    it('honours prefers-reduced-motion globally', () => {
      expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)/);
    });
  });

  describe('focus (§1.1, A2/R11)', () => {
    it('sets the global focus-visible ring to outline-offset 2px (was 3px)', () => {
      expect(css).toMatch(
        /:focus-visible\s*\{\s*outline:\s*3px solid var\(--color-focus-ring\);\s*outline-offset:\s*2px;/,
      );
    });

    it('ships a .focus-inset utility that renders inside the border box (immune to overflow/contain clipping)', () => {
      expect(css).toMatch(
        /@utility focus-inset\s*\{\s*outline:\s*2px solid var\(--color-focus-ring\);\s*outline-offset:\s*-2px;/,
      );
    });
  });

  it('binds the handoff font tokens to self-hosted Next font variables', () => {
    expect(css).toContain("'Public Sans'");
    expect(css).toContain("'IBM Plex Mono'");
    expect(css).toContain('var(--font-public-sans)');
    expect(css).toContain('var(--font-ibm-plex-mono)');
    expect(css).toContain('--font-mono:');
    const layout = readFileSync(resolve(process.cwd(), 'dashboard/src/app/layout.tsx'), 'utf8');
    expect(layout).toContain("from 'next/font/google'");
    expect(layout).toContain("variable: '--font-public-sans'");
    expect(layout).toContain("variable: '--font-ibm-plex-mono'");
    // The <html> tag is multi-line since Lane B added the DESIGN-SPEC.md §1.2/§5 `data-theme`
    // hook, so assert the facts (lang, both font variables bound, theme hook present) rather
    // than one exact source line.
    expect(layout).toMatch(/<html\b[^>]*\blang="en"/);
    expect(layout).toMatch(
      /className=\{`\$\{publicSans\.variable\}\s+\$\{ibmPlexMono\.variable\}`\}/,
    );
    expect(layout).toMatch(/<html\b[^>]*\bdata-theme=/);
  });

  it('clips document-level horizontal overflow while preserving component scrollers', () => {
    expect(css).toMatch(/html\s*\{[^}]*overflow-x:\s*clip;/s);
  });
});
