// HMAC-SHA256 payload signing, the standard webhook authenticity mechanism
// (Stripe/GitHub style). The receiver recomputes the signature over the raw
// body with its endpoint secret and compares in constant time.

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * What a signature covers. Binding the delivery id and the receiving
 * endpoint's id means a signed request cannot be replayed as a different
 * delivery or to a different endpoint.
 */
export interface SignedMessage {
  /** The `webhook-id` header: the delivery id, stable across retries. */
  webhookId: string;
  /** The receiving endpoint's id. Receivers pass their own, not a header value. */
  endpointId: string;
  /** The raw request body. */
  body: string;
}

export interface SignatureParts {
  /** Unix seconds at signing time, included to bound replay windows. */
  timestamp: number;
  /** Hex-encoded HMAC-SHA256 over `${timestamp}.${webhookId}.${endpointId}.${body}`. */
  signature: string;
}

function mac(msg: SignedMessage, secret: string, timestamp: number): Buffer {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${msg.webhookId}.${msg.endpointId}.${msg.body}`)
    .digest();
}

export function sign(msg: SignedMessage, secret: string, timestamp = Math.floor(Date.now() / 1000)): SignatureParts {
  return { timestamp, signature: mac(msg, secret, timestamp).toString("hex") };
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
  msg: SignedMessage,
  secret: string,
  header: string,
  toleranceSeconds = 300,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(now - parsed.timestamp) > toleranceSeconds) return false;

  const expected = mac(msg, secret, parsed.timestamp);
  const actual = Buffer.from(parsed.signature, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
