import { describe, expect, it } from "vitest";
import { parseSignatureHeader, sign, signatureHeader, verify } from "../src/signing.js";

const msg = { webhookId: "d-1", endpointId: "ep-1", body: "hello" };

describe("signing", () => {
  it("verifies a freshly signed body", () => {
    const parts = sign(msg, "secret", 1000);
    const header = signatureHeader(parts);
    expect(verify(msg, "secret", header, 300, 1000)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const header = signatureHeader(sign(msg, "secret", 1000));
    expect(verify({ ...msg, body: "HELLO" }, "secret", header, 300, 1000)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const header = signatureHeader(sign(msg, "secret", 1000));
    expect(verify(msg, "other", header, 300, 1000)).toBe(false);
  });

  it("rejects a signature presented with a different webhook id", () => {
    const header = signatureHeader(sign(msg, "secret", 1000));
    expect(verify({ ...msg, webhookId: "d-2" }, "secret", header, 300, 1000)).toBe(false);
  });

  it("rejects a signature issued to another endpoint, even under the same secret", () => {
    const header = signatureHeader(sign({ ...msg, endpointId: "attacker-ep" }, "secret", 1000));
    expect(verify(msg, "secret", header, 300, 1000)).toBe(false);
  });

  it("rejects an expired timestamp (replay protection)", () => {
    const header = signatureHeader(sign(msg, "secret", 1000));
    expect(verify(msg, "secret", header, 300, 1000 + 301)).toBe(false);
  });

  it("accepts within tolerance", () => {
    const header = signatureHeader(sign(msg, "secret", 1000));
    expect(verify(msg, "secret", header, 300, 1000 + 299)).toBe(true);
  });

  it("parses a header round trip", () => {
    const parts = sign(msg, "s", 42);
    const parsed = parseSignatureHeader(signatureHeader(parts));
    expect(parsed).toEqual(parts);
  });

  it("returns null on malformed header", () => {
    expect(parseSignatureHeader("garbage")).toBeNull();
  });
});
