// Transport abstraction for actually sending a webhook. Production uses
// node:http(s) behind the SSRF guard; tests use a programmable fake that can
// fail N times then succeed, or fail permanently, so retry/DLQ behavior is
// verified without a network.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { sign, signatureHeader } from "./signing.js";
import { checkUrl, guardedLookup, PUBLIC_WEB, type DestinationPolicy } from "./ssrf.js";
import type { Delivery } from "./types.js";

export interface DeliveryResult {
  ok: boolean;
  status: number;
  error?: string;
}

/** The parts of a delivery an attempt needs. */
export type OutboundWebhook = Pick<Delivery, "id" | "endpointId" | "url" | "body">;

export interface Transport {
  send(webhook: OutboundWebhook): Promise<DeliveryResult>;
}

export class HttpTransport implements Transport {
  private readonly lookup: LookupFunction;

  constructor(
    /** The signing secret of an endpoint; undefined if it is not registered. */
    private readonly secretFor: (endpointId: string) => string | undefined,
    private readonly timeoutMs = 5000,
    private readonly policy: DestinationPolicy = PUBLIC_WEB,
  ) {
    this.lookup = guardedLookup(policy);
  }

  async send(webhook: OutboundWebhook): Promise<DeliveryResult> {
    const { id, endpointId, url, body } = webhook;
    const secret = this.secretFor(endpointId);
    if (secret === undefined) return { ok: false, status: 0, error: "unknown endpoint" };
    const refused = checkUrl(url, this.policy);
    if (refused) return { ok: false, status: 0, error: refused };

    const target = new URL(url);
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve) => {
      const req = request(
        target,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "webhook-id": id,
            "webhook-endpoint-id": endpointId,
            "webhook-signature": signatureHeader(sign({ webhookId: id, endpointId, body }, secret)),
          },
          lookup: this.lookup,
          signal: AbortSignal.timeout(this.timeoutMs),
        },
        (res) => {
          // The body is not needed. Redirects are not followed: a 3xx is a
          // failed attempt like any other non-2xx, retried by policy.
          res.destroy();
          const status = res.statusCode ?? 0;
          const ok = status >= 200 && status < 300;
          resolve({ ok, status, error: ok ? undefined : `http ${status}` });
        },
      );
      req.on("error", (err) => resolve({ ok: false, status: 0, error: err.message }));
      req.end(body);
    });
  }
}

/**
 * Programmable transport for tests/benchmarks.
 * - failuresByUrl: number of leading failures before a URL starts succeeding.
 * - alwaysFail: URLs that never succeed (drive the DLQ path).
 * - randomFailureRate: independent per-attempt transient failure probability.
 */
export class FakeTransport implements Transport {
  public calls = 0;
  private remaining = new Map<string, number>();

  constructor(
    private readonly opts: {
      failuresByUrl?: Record<string, number>;
      alwaysFail?: Set<string>;
      randomFailureRate?: number;
      rand?: () => number;
    } = {},
  ) {
    for (const [url, n] of Object.entries(opts.failuresByUrl ?? {})) {
      this.remaining.set(url, n);
    }
  }

  async send({ url }: OutboundWebhook): Promise<DeliveryResult> {
    this.calls++;
    if (this.opts.alwaysFail?.has(url)) {
      return { ok: false, status: 500, error: "permanent failure" };
    }
    const left = this.remaining.get(url) ?? 0;
    if (left > 0) {
      this.remaining.set(url, left - 1);
      return { ok: false, status: 503, error: "transient failure" };
    }
    const rate = this.opts.randomFailureRate ?? 0;
    if (rate > 0) {
      const r = (this.opts.rand ?? Math.random)();
      if (r < rate) return { ok: false, status: 503, error: "transient failure (random)" };
    }
    return { ok: true, status: 200 };
  }
}
