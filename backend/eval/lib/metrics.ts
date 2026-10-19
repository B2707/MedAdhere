/**
 * metrics.ts — statistical core of the SC5/SC6 eval harness (Plan 04-05).
 *
 * Clopper-Pearson exact intervals are THE reporting contract: every headline
 * metric ships as "point [lower, upper]", never a bare number. The interval
 * is computed from the beta-quantile identity:
 *   lower = BetaInv(alpha/2, x, n-x+1)     (0 when x = 0)
 *   upper = BetaInv(1-alpha/2, x+1, n-x)   (1 when x = n)
 * The regularized incomplete beta is evaluated with the standard Lentz
 * continued fraction; the inverse is a bisection (monotone, [0,1] bracket).
 */

export interface ConfidenceInterval {
  readonly lower: number;
  readonly upper: number;
}

const DEFAULT_ALPHA = 0.05;
const BISECTION_ITERATIONS = 200;

/** ln Γ(x) — Lanczos approximation (g=7, n=9), accurate to ~1e-13 for x > 0. */
function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = c[0];
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized incomplete beta I_x(a, b) via the Lentz continued fraction. */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lnBeta) / a;
  // symmetry keeps the continued fraction in its fast-converging region
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedIncompleteBeta(1 - x, b, a);
  }
  const TINY = 1e-30;
  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= 300; i++) {
    const m = Math.floor(i / 2);
    let numerator: number;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) d = TINY;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) c = TINY;
    const delta = c * d;
    f *= delta;
    if (Math.abs(1 - delta) < 1e-12) break;
  }
  return front * (f - 1);
}

/** Inverse of I_x(a, b) in x, by bisection — monotone on [0, 1]. */
function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < BISECTION_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (regularizedIncompleteBeta(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 95% (default) Clopper-Pearson exact interval for x successes in n trials. */
export function clopperPearsonInterval(
  successes: number,
  trials: number,
  alpha: number = DEFAULT_ALPHA,
): ConfidenceInterval {
  if (!Number.isInteger(successes) || !Number.isInteger(trials)) {
    throw new Error(`clopperPearson: successes/trials must be integers (${successes}/${trials})`);
  }
  if (trials <= 0 || successes < 0 || successes > trials) {
    throw new Error(`clopperPearson: invalid inputs ${successes}/${trials}`);
  }
  const lower =
    successes === 0 ? 0 : betaQuantile(alpha / 2, successes, trials - successes + 1);
  const upper =
    successes === trials ? 1 : betaQuantile(1 - alpha / 2, successes + 1, trials - successes);
  return { lower, upper };
}

/** "0.933 [0.881, 0.967]" — the never-a-bare-number reporting format. */
export function formatMetric(point: number, ci: ConfidenceInterval): string {
  const f = (v: number) => v.toFixed(3);
  return `${f(point)} [${f(ci.lower)}, ${f(ci.upper)}]`;
}

export interface LabeledResult {
  readonly gold: string;
  readonly predicted: string;
}

export interface ClassMetrics {
  readonly precision: number;
  readonly recall: number;
  readonly support: number;
  readonly truePositives: number;
  readonly predictedCount: number;
}

/** Per-class one-vs-rest precision/recall with support counts. */
export function perClassPrecisionRecall(
  results: readonly LabeledResult[],
): Record<string, ClassMetrics> {
  const classes = new Set<string>();
  for (const r of results) {
    classes.add(r.gold);
    classes.add(r.predicted);
  }
  const out: Record<string, ClassMetrics> = {};
  for (const cls of classes) {
    const tp = results.filter((r) => r.gold === cls && r.predicted === cls).length;
    const predicted = results.filter((r) => r.predicted === cls).length;
    const support = results.filter((r) => r.gold === cls).length;
    out[cls] = {
      precision: predicted === 0 ? 0 : tp / predicted,
      recall: support === 0 ? 0 : tp / support,
      support,
      truePositives: tp,
      predictedCount: predicted,
    };
  }
  return out;
}

export function accuracy(results: readonly LabeledResult[]): number {
  if (results.length === 0) throw new Error('accuracy: empty result set');
  return results.filter((r) => r.gold === r.predicted).length / results.length;
}
