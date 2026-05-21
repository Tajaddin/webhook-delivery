// HMAC-SHA256 payload signing, the standard webhook authenticity mechanism
// (Stripe/GitHub style). The receiver recomputes the signature over the raw
// body with the shared secret and compares in constant time.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SignatureParts {
  /** Unix seconds at signing time, included to bound replay windows. */
  timestamp: number;
  /** Hex-encoded HMAC-SHA256 over `${timestamp}.${body}`. */
  signature: string;
}

export function sign(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): SignatureParts {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return { timestamp, signature: mac };
}

/** Format as a single header value: `t=<ts>,v1=<sig>` (Stripe convention). */
export function signatureHeader(parts: SignatureParts): string {
  return `t=${parts.timestamp},v1=${parts.signature}`;
}

export function parseSignatureHeader(header: string): SignatureParts | null {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const idx = kv.indexOf("=");
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }),
  );
  const t = Number(parts["t"]);
  const v1 = parts["v1"];
  if (!Number.isFinite(t) || typeof v1 !== "string" || v1.length === 0) return null;
  return { timestamp: t, signature: v1 };
}

/**
 * Verify a signature in constant time. Rejects if the timestamp is older than
 * `toleranceSeconds` (replay protection).
 */
export function verify(
  body: string,
  secret: string,
  header: string,
  toleranceSeconds = 300,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(now - parsed.timestamp) > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret).update(`${parsed.timestamp}.${body}`).digest();
  const actual = Buffer.from(parsed.signature, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
