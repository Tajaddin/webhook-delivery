// Outbound destination policy. Webhook URLs come from API clients, so the
// service must not become a proxy into its own network. Every hostname is
// resolved inside the socket's own lookup, every resolved address must be
// public, and the socket connects to exactly the addresses that were checked,
// so a second DNS answer (rebinding) cannot swap in an internal one.

import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

// IPv4 ranges that are not globally reachable (IANA special-purpose registry):
// this-network, private, CGNAT, loopback, link-local (cloud metadata lives at
// 169.254.169.254), protocol assignments, documentation, 6to4 relay,
// benchmarking, multicast and reserved/broadcast.
const BLOCKED_V4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_V4.addSubnet(network, prefix, "ipv4");
}

// IPv6: only global unicast (2000::/3) is allowed. Everything outside it is
// blocked, which covers loopback, unspecified, ULA fc00::/7 (AWS metadata is
// fd00:ec2::254), link-local fe80::/10, multicast and NAT64 64:ff9b::/96.
// Inside 2000::/3, block IETF protocol assignments (incl. Teredo), 6to4
// (tunnels to arbitrary IPv4) and the documentation prefixes.
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ["::", 3],
  ["4000::", 2],
  ["8000::", 1],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  BLOCKED_V6.addSubnet(network, prefix, "ipv6");
}

const V4_MAPPED = new BlockList();
V4_MAPPED.addSubnet("::ffff:0:0", 96, "ipv6");

/** True if a connection to this IP literal must be refused. Non-IPs are refused. */
export function isBlockedAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return BLOCKED_V4.check(address, "ipv4");
    case 6:
      // ::ffff:a.b.c.d reaches the IPv4 host a.b.c.d; BlockList matches it
      // against the IPv4 rules.
      return V4_MAPPED.check(address, "ipv6")
        ? BLOCKED_V4.check(address, "ipv6")
        : BLOCKED_V6.check(address, "ipv6");
    default:
      return true;
  }
}

export interface DestinationPolicy {
  ports: ReadonlySet<number>;
  isBlockedAddress(address: string): boolean;
}

/** Public internet only, on the standard web ports. */
export const PUBLIC_WEB: DestinationPolicy = { ports: new Set([80, 443]), isBlockedAddress };

/**
 * Checks that need no DNS: scheme, port, and IP-literal hosts (which never
 * reach the lookup). Returns why the URL is refused, or null if it may be used.
 */
export function checkUrl(raw: string, policy: DestinationPolicy = PUBLIC_WEB): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid url";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "url must be http or https";
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!policy.ports.has(port)) return `port ${port} is not allowed`;
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(host) !== 0 && policy.isBlockedAddress(host)) return `address ${host} is not allowed`;
  return null;
}

type Resolve = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * A `lookup` for http.request/net.connect that refuses the connection if any
 * address the name resolves to is blocked, and otherwise hands the socket the
 * same addresses it checked.
 */
export function guardedLookup(policy: DestinationPolicy = PUBLIC_WEB, resolve: Resolve = dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const first = addresses[0];
      if (!first) return callback(Object.assign(new Error(`${hostname} did not resolve`), { code: "ENOTFOUND" }), []);
      if (addresses.some((a) => policy.isBlockedAddress(a.address))) {
        return callback(new Error(`${hostname} resolves to a non-public address`), []);
      }
      if (options.all) callback(null, addresses);
      else callback(null, first.address, first.family);
    });
  };
}
