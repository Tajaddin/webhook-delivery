// Exponential backoff with full jitter. Bounds the retry delay and decides
// when attempts are exhausted (the trigger to dead-letter a delivery).

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
  /** Multiply delay by this each attempt. */
  factor: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 100,
  maxMs: 30_000,
  maxAttempts: 6,
  factor: 2,
};

/**
 * Delay before the given attempt (1-indexed). Uses "full jitter":
 * a uniform random value in [0, cappedExponential]. `rand` is injectable for
 * deterministic tests.
 */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy, rand: () => number = Math.random): number {
  if (attempt < 1) throw new Error("attempt must be >= 1");
  const exp = policy.baseMs * Math.pow(policy.factor, attempt - 1);
  const capped = Math.min(exp, policy.maxMs);
  return Math.floor(rand() * capped);
}

/** True once `attempts` has reached the policy limit (no retries left). */
export function isExhausted(attempts: number, policy: BackoffPolicy): boolean {
  return attempts >= policy.maxAttempts;
}
