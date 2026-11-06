import { describe, expect, it } from "vitest";
import { DeliveryQueue } from "../src/queue.js";

describe("DeliveryQueue", () => {
  it("enqueues a pending delivery", () => {
    const q = new DeliveryQueue();
    const d = q.enqueue({ endpointId: "ep", url: "https://x.com", payload: { a: 1 } }, 1000);
    expect(d.status).toBe("pending");
    expect(d.attempts).toBe(0);
    expect(d.body).toBe(JSON.stringify({ a: 1 }));
    expect(q.size).toBe(1);
  });

  it("dedupes by idempotency key", () => {
    const q = new DeliveryQueue();
    const first = q.enqueue({ endpointId: "ep", url: "https://x.com", payload: { a: 1 }, idempotencyKey: "k1" });
    const second = q.enqueue({ endpointId: "ep", url: "https://x.com", payload: { a: 2 }, idempotencyKey: "k1" });
    expect(second.id).toBe(first.id);
    expect(q.size).toBe(1);
    // original payload preserved (not overwritten by the duplicate)
    expect(q.get(first.id)!.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("scopes idempotency keys to the endpoint", () => {
    const q = new DeliveryQueue();
    const a = q.enqueue({ endpointId: "ep-a", url: "https://a.com", payload: {}, idempotencyKey: "order-42" });
    const b = q.enqueue({ endpointId: "ep-b", url: "https://b.com", payload: {}, idempotencyKey: "order-42" });
    expect(b.id).not.toBe(a.id);
    expect(q.size).toBe(2);
  });

  it("claimReady returns only due, pending deliveries", () => {
    const q = new DeliveryQueue();
    const a = q.enqueue({ endpointId: "ep", url: "https://a.com", payload: {} }, 1000);
    const b = q.enqueue({ endpointId: "ep", url: "https://b.com", payload: {} }, 1000);
    b.nextAttemptAt = 5000; // not due yet
    const ready = q.claimReady(2000);
    expect(ready.map((d) => d.id)).toEqual([a.id]);
  });

  it("tracks stats and dead letters", () => {
    const q = new DeliveryQueue();
    const d = q.enqueue({ endpointId: "ep", url: "https://x.com", payload: {} });
    d.status = "dead";
    expect(q.stats().dead).toBe(1);
    expect(q.deadLetters().map((x) => x.id)).toEqual([d.id]);
  });
});
