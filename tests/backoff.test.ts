import { describe, expect, it } from "vitest";
import { backoffDelayMs, DEFAULT_BACKOFF, isExhausted } from "../src/backoff.js";

describe("backoff", () => {
  it("is bounded by the cap with full jitter (rand=1)", () => {
    const policy = { baseMs: 100, maxMs: 1000, maxAttempts: 10, factor: 2 };
    // attempt 1 -> 100, 2 -> 200, 3 -> 400, 4 -> 800, 5 -> capped 1000
    expect(backoffDelayMs(1, policy, () => 1)).toBe(100);
    expect(backoffDelayMs(3, policy, () => 1)).toBe(400);
    expect(backoffDelayMs(5, policy, () => 1)).toBe(1000);
    expect(backoffDelayMs(9, policy, () => 1)).toBe(1000); // still capped
  });

  it("returns 0 with rand=0 (full jitter low end)", () => {
    expect(backoffDelayMs(3, DEFAULT_BACKOFF, () => 0)).toBe(0);
  });

  it("scales delay between 0 and the cap", () => {
    const d = backoffDelayMs(4, DEFAULT_BACKOFF, () => 0.5);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
  });

  it("throws on attempt < 1", () => {
    expect(() => backoffDelayMs(0, DEFAULT_BACKOFF)).toThrow();
  });

  it("reports exhaustion at the attempt limit", () => {
    expect(isExhausted(5, { ...DEFAULT_BACKOFF, maxAttempts: 6 })).toBe(false);
    expect(isExhausted(6, { ...DEFAULT_BACKOFF, maxAttempts: 6 })).toBe(true);
  });
});
