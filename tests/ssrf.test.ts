import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { checkUrl, guardedLookup, isBlockedAddress } from "../src/ssrf.js";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::a00:1",
    "2002:a00:1::1",
    "2001:db8::1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"])(
    "allows %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe("checkUrl", () => {
  it.each([
    ["ftp://example.com/hook", /http or https/],
    ["file:///etc/passwd", /http or https/],
    ["not a url", /invalid url/],
    ["http://example.com:8080/hook", /port 8080/],
    ["https://example.com:22/", /port 22/],
    ["http://127.0.0.1/hook", /127\.0\.0\.1 is not allowed/],
    ["http://169.254.169.254/latest/meta-data/", /not allowed/],
    ["http://[::1]/hook", /::1 is not allowed/],
    ["http://[::ffff:127.0.0.1]/hook", /not allowed/],
    // The URL parser normalizes these spellings of 127.0.0.1.
    ["http://2130706433/hook", /127\.0\.0\.1 is not allowed/],
    ["http://0x7f.0.0.1/hook", /127\.0\.0\.1 is not allowed/],
  ])("refuses %s", (url, reason) => {
    expect(checkUrl(url)).toMatch(reason);
  });

  it.each(["https://example.com/hook", "http://example.com:80/hook", "http://example.com:443/hook", "https://8.8.8.8/hook"])(
    "accepts %s",
    (url) => {
      expect(checkUrl(url)).toBeNull();
    },
  );
});

describe("guardedLookup", () => {
  const resolvingTo =
    (...addresses: string[]) =>
    (_host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) =>
      cb(
        null,
        addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
      );

  function run(lookup: ReturnType<typeof guardedLookup>, all: boolean) {
    return new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
      lookup("hooks.example.com", { all }, (err, address, family) => resolve({ err, address, family })),
    );
  }

  it("refuses a name if any of its addresses is internal", async () => {
    const lookup = guardedLookup(undefined, resolvingTo("93.184.215.14", "10.0.0.5"));
    const { err } = await run(lookup, true);
    expect(err?.message).toMatch(/non-public address/);
  });

  it("hands the socket exactly the addresses it checked", async () => {
    const lookup = guardedLookup(undefined, resolvingTo("93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"));
    expect((await run(lookup, true)).address).toEqual([
      { address: "93.184.215.14", family: 4 },
      { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 },
    ]);
    expect(await run(lookup, false)).toMatchObject({ err: null, address: "93.184.215.14", family: 4 });
  });

  it("passes resolver errors through", async () => {
    const failing = (_h: string, _o: unknown, cb: (err: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) =>
      cb(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }), []);
    const { err } = await run(guardedLookup(undefined, failing), true);
    expect(err?.message).toMatch(/ENOTFOUND/);
  });
});
