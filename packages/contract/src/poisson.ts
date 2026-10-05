// Poisson tail probabilities for the volume-aware anomaly rules (docs/02).
//
// Everything here is computed in log-space so the rules stay stable when the
// baseline (lambda) is large or the observed count sits deep in a tail — a
// naive product of `lambda^k / k!` overflows or underflows to 0/Inf long before
// the probability itself does. The rules only ever need the *lower* tail
// P(X <= k) (a surprisingly-low count is the drop we care about), so that is the
// public surface; the pmf and lnGamma helpers are exported because the tests
// pin them against known values (e.g. P(X=0 | lambda=6.2) = e^-6.2 ~= 0.00203,
// the worked example in docs/02).

// --- ln Gamma (Lanczos approximation, g=7) -------------------------------
// ln(Gamma(z)) for z > 0; the reflection formula handles z < 0.5. Accurate to
// ~15 significant digits across the range the rules exercise.
const LANCZOS_G = 7;
const LANCZOS_COEF = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
] as const;

export function lnGamma(z: number): number {
  if (Number.isNaN(z)) return Number.NaN;
  if (z < 0.5) {
    // Reflection: Gamma(z)Gamma(1-z) = pi / sin(pi z)
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  z -= 1;
  let x = LANCZOS_COEF[0];
  for (let i = 1; i < LANCZOS_G + 2; i++) {
    x += LANCZOS_COEF[i]! / (z + i);
  }
  const t = z + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** ln(n!) via ln(Gamma(n+1)). */
export function lnFactorial(n: number): number {
  return lnGamma(n + 1);
}

/** ln P(X = k | lambda) for a Poisson(lambda). */
export function lnPoissonPmf(k: number, lambda: number): number {
  if (lambda < 0) throw new RangeError('lambda must be >= 0');
  if (k < 0 || !Number.isInteger(k)) return Number.NEGATIVE_INFINITY;
  if (lambda === 0) return k === 0 ? 0 : Number.NEGATIVE_INFINITY; // all mass at 0
  return -lambda + k * Math.log(lambda) - lnFactorial(k);
}

/** P(X = k | lambda). */
export function poissonPmf(k: number, lambda: number): number {
  return Math.exp(lnPoissonPmf(Math.trunc(k), lambda));
}

/**
 * Lower-tail CDF P(X <= k | lambda), summed in log-space over terms 0..k.
 * k is floored (counts are integers); negative k -> 0; lambda === 0 -> 1.
 */
export function poissonLowerTail(k: number, lambda: number): number {
  if (lambda < 0) throw new RangeError('lambda must be >= 0');
  const kk = Math.floor(k);
  if (kk < 0) return 0;
  if (lambda === 0) return 1; // all mass sits at 0, and kk >= 0
  let logSum = Number.NEGATIVE_INFINITY;
  for (let i = 0; i <= kk; i++) {
    logSum = logAdd(logSum, lnPoissonPmf(i, lambda));
  }
  const p = Math.exp(logSum);
  return p > 1 ? 1 : p; // clamp floating-point overshoot
}

/** log(exp(a) + exp(b)), overflow-safe. */
function logAdd(a: number, b: number): number {
  if (a === Number.NEGATIVE_INFINITY) return b;
  if (b === Number.NEGATIVE_INFINITY) return a;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return hi + Math.log1p(Math.exp(lo - hi));
}
