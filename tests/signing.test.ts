import { describe, expect, it } from "vitest";
import { parseSignatureHeader, sign, signatureHeader, verify } from "../src/signing.js";

describe("signing", () => {
  it("verifies a freshly signed body", () => {
    const parts = sign("hello", "secret", 1000);
    const header = signatureHeader(parts);
    expect(verify("hello", "secret", header, 300, 1000)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const header = signatureHeader(sign("hello", "secret", 1000));
    expect(verify("HELLO", "secret", header, 300, 1000)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const header = signatureHeader(sign("hello", "secret", 1000));
    expect(verify("hello", "other", header, 300, 1000)).toBe(false);
  });

  it("rejects an expired timestamp (replay protection)", () => {
    const header = signatureHeader(sign("hello", "secret", 1000));
    expect(verify("hello", "secret", header, 300, 1000 + 301)).toBe(false);
  });

  it("accepts within tolerance", () => {
    const header = signatureHeader(sign("hello", "secret", 1000));
    expect(verify("hello", "secret", header, 300, 1000 + 299)).toBe(true);
  });

  it("parses a header round trip", () => {
    const parts = sign("x", "s", 42);
    const parsed = parseSignatureHeader(signatureHeader(parts));
    expect(parsed).toEqual(parts);
  });

  it("returns null on malformed header", () => {
    expect(parseSignatureHeader("garbage")).toBeNull();
  });
});
