// In-memory delivery queue with idempotent enqueue and a dead-letter list.
// The interface is small so a Redis/Postgres-backed queue can replace it.

import { randomUUID } from "node:crypto";
import type { Delivery, EnqueueRequest } from "./types.js";

export class DeliveryQueue {
  private byId = new Map<string, Delivery>();
  private byIdempotencyKey = new Map<string, string>();

  /** Enqueue a delivery. Re-enqueuing the same idempotency key for the same
   *  endpoint returns the existing delivery instead of creating a duplicate. */
  enqueue(req: EnqueueRequest, now = Date.now()): Delivery {
    const key = req.idempotencyKey ?? randomUUID();
    const scopedKey = JSON.stringify([req.endpointId, key]);
    const existingId = this.byIdempotencyKey.get(scopedKey);
    if (existingId) {
      return this.byId.get(existingId)!;
    }
    const delivery: Delivery = {
      id: randomUUID(),
      idempotencyKey: key,
      endpointId: req.endpointId,
      url: req.url,
      body: JSON.stringify(req.payload),
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    };
    this.byId.set(delivery.id, delivery);
    this.byIdempotencyKey.set(scopedKey, delivery.id);
    return delivery;
  }

  get(id: string): Delivery | undefined {
    return this.byId.get(id);
  }

  /** Deliveries that are pending and due (nextAttemptAt <= now). */
  claimReady(now = Date.now()): Delivery[] {
    const ready: Delivery[] = [];
    for (const d of this.byId.values()) {
      if (d.status === "pending" && d.nextAttemptAt <= now) {
        ready.push(d);
      }
    }
    return ready;
  }

  deadLetters(): Delivery[] {
    return [...this.byId.values()].filter((d) => d.status === "dead");
  }

  /** All deliveries still pending (regardless of due time). */
  pending(): Delivery[] {
    return [...this.byId.values()].filter((d) => d.status === "pending");
  }

  stats(): Record<string, number> {
    const s = { pending: 0, delivered: 0, failed: 0, dead: 0 };
    for (const d of this.byId.values()) s[d.status]++;
    return s;
  }

  /** Number of distinct deliveries tracked. */
  get size(): number {
    return this.byId.size;
  }
}
