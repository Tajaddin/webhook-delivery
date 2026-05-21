// Transport abstraction for actually sending a webhook. Production uses fetch;
// tests use a programmable fake that can fail N times then succeed, or fail
// permanently, so retry/DLQ behavior is verified without a network.

import { sign, signatureHeader } from "./signing.js";

export interface DeliveryResult {
  ok: boolean;
  status: number;
  error?: string;
}

export interface Transport {
  send(url: string, body: string, secret: string): Promise<DeliveryResult>;
}

export class HttpTransport implements Transport {
  constructor(private readonly timeoutMs = 5000) {}

  async send(url: string, body: string, secret: string): Promise<DeliveryResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-signature": signatureHeader(sign(body, secret)),
        },
        body,
        signal: controller.signal,
      });
      // 2xx is success; everything else is retryable (caller decides via policy).
      return { ok: resp.ok, status: resp.status, error: resp.ok ? undefined : `http ${resp.status}` };
    } catch (err) {
      return { ok: false, status: 0, error: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
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

  async send(url: string, _body: string, _secret: string): Promise<DeliveryResult> {
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
