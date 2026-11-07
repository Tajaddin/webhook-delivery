import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";
import { DeliveryQueue } from "../src/queue.js";
import { FakeTransport, type DeliveryResult, type Transport } from "../src/transport.js";
import { DeliveryWorker } from "../src/worker.js";

function setup(transport: Transport, policyOverrides = {}) {
  const queue = new DeliveryQueue();
  const clock = new VirtualClock(0);
  const worker = new DeliveryWorker(queue, transport, {
    clock,
    rand: () => 0.5,
    policy: { baseMs: 100, maxMs: 1000, maxAttempts: 4, factor: 2, ...policyOverrides },
  });
  return { queue, clock, worker };
}

describe("DeliveryWorker", () => {
  it("delivers on first try when the endpoint is healthy", async () => {
    const { queue, worker } = setup(new FakeTransport());
    queue.enqueue({ endpointId: "ep", url: "https://ok.com", payload: {} });
    await worker.drain();
    expect(queue.stats().delivered).toBe(1);
  });

  it("retries transient failures then delivers", async () => {
    const transport = new FakeTransport({ failuresByUrl: { "https://flaky.com": 2 } });
    const { queue, worker } = setup(transport);
    const d = queue.enqueue({ endpointId: "ep", url: "https://flaky.com", payload: {} });
    await worker.drain();
    expect(queue.get(d.id)!.status).toBe("delivered");
    expect(queue.get(d.id)!.attempts).toBe(3); // 2 failures + 1 success
  });

  it("dead-letters after exhausting retries", async () => {
    const transport = new FakeTransport({ alwaysFail: new Set(["https://down.com"]) });
    const { queue, worker } = setup(transport);
    const d = queue.enqueue({ endpointId: "ep", url: "https://down.com", payload: {} });
    await worker.drain();
    expect(queue.get(d.id)!.status).toBe("dead");
    expect(queue.get(d.id)!.attempts).toBe(4); // maxAttempts
    expect(queue.deadLetters()).toHaveLength(1);
  });

  it("delivers 100% of deliverable messages under 50% transient failure", async () => {
    const transport = new FakeTransport({ randomFailureRate: 0.5, rand: () => seqRand() });
    const { queue, worker } = setup(transport, { maxAttempts: 20 });
    for (let i = 0; i < 200; i++) queue.enqueue({ endpointId: "ep", url: `https://h.com/${i}`, payload: { i } });
    await worker.drain();
    expect(queue.stats().delivered).toBe(200);
    expect(queue.stats().dead).toBe(0);
  });

  it("eventually dead-letters a permanently down endpoint while delivering the rest", async () => {
    const transport = new FakeTransport({ alwaysFail: new Set(["https://h.com/1"]) });
    const { queue, worker } = setup(transport);
    for (let i = 0; i < 5; i++) queue.enqueue({ endpointId: "ep", url: `https://h.com/${i}`, payload: { i } });
    await worker.drain();
    expect(queue.stats().delivered).toBe(4);
    expect(queue.stats().dead).toBe(1);
  });
});

/**
 * A slow receiver: every send stays in flight until release(). The first
 * send succeeds; later ones get 409, like a receiver that rejects duplicates.
 */
class SlowReceiver implements Transport {
  sends = 0;
  private held: (() => void)[] = [];

  async send(): Promise<DeliveryResult> {
    const n = ++this.sends;
    await new Promise<void>((resolve) => this.held.push(resolve));
    return n === 1 ? { ok: true, status: 200 } : { ok: false, status: 409, error: "http 409" };
  }

  release(): void {
    for (const resolve of this.held.splice(0)) resolve();
  }
}

describe("DeliveryWorker under concurrency", () => {
  it("does not start a tick while the previous one is still sending", async () => {
    // server.ts fires tick() on an interval whether or not the last one finished.
    const transport = new SlowReceiver();
    const { queue, worker } = setup(transport);
    const d = queue.enqueue({ endpointId: "ep", url: "https://slow.example/hook", payload: {} }, 0);
    const ticks = [worker.tick(), worker.tick(), worker.tick()];
    transport.release();
    expect(await Promise.all(ticks)).toEqual([1, 0, 0]);
    expect(transport.sends).toBe(1);
    expect(d).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("lets only one of several workers sharing a queue claim a delivery", async () => {
    const transport = new SlowReceiver();
    const { queue, clock } = setup(transport);
    const workers = [new DeliveryWorker(queue, transport, { clock }), new DeliveryWorker(queue, transport, { clock })];
    const d = queue.enqueue({ endpointId: "ep", url: "https://slow.example/hook", payload: {} }, 0);
    const ticks = workers.map((w) => w.tick());
    transport.release();
    expect(await Promise.all(ticks)).toEqual([1, 0]);
    expect(transport.sends).toBe(1);
    expect(d.status).toBe("delivered");
  });

  it("never lets a late failure overwrite a delivered status", async () => {
    const transport = new SlowReceiver();
    const { queue, worker } = setup(transport);
    const d = queue.enqueue({ endpointId: "ep", url: "https://slow.example/hook", payload: {} }, 0);
    const attempts = [worker.attempt(d), worker.attempt(d)];
    transport.release();
    await Promise.all(attempts);
    expect(d.status).toBe("delivered");
    expect(d.lastError).toBeUndefined();
    expect(await worker.tick()).toBe(0);
  });

  it("records a transport that throws as a failed attempt and frees the delivery", async () => {
    const throwing: Transport = {
      send: async () => {
        throw new Error("socket hang up");
      },
    };
    const { queue, clock, worker } = setup(throwing);
    const d = queue.enqueue({ endpointId: "ep", url: "https://x.example/hook", payload: {} }, 0);
    await worker.tick();
    expect(d).toMatchObject({ status: "pending", attempts: 1, lastError: "socket hang up" });
    clock.advanceTo(d.nextAttemptAt);
    expect(await worker.tick()).toBe(1);
  });
});

// deterministic-ish sequence so the 50%-failure test is reproducible
let _s = 12345;
function seqRand(): number {
  _s = (_s * 1103515245 + 12345) & 0x7fffffff;
  return _s / 0x7fffffff;
}
