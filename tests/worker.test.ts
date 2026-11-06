import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";
import { DeliveryQueue } from "../src/queue.js";
import { FakeTransport } from "../src/transport.js";
import { DeliveryWorker } from "../src/worker.js";

function setup(transport: FakeTransport, policyOverrides = {}) {
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

// deterministic-ish sequence so the 50%-failure test is reproducible
let _s = 12345;
function seqRand(): number {
  _s = (_s * 1103515245 + 12345) & 0x7fffffff;
  return _s / 0x7fffffff;
}
