// Delivery worker: drives deliveries through the at-least-once state machine.
//
//   pending --(transport ok)--> delivered
//   pending --(fail, retries left)--> pending (nextAttemptAt = now + backoff)
//   pending --(fail, exhausted)--> dead  (dead-letter queue)
//
// The clock and RNG are injectable so tests and the benchmark run
// deterministically with no real waiting.

import { backoffDelayMs, DEFAULT_BACKOFF, isExhausted, type BackoffPolicy } from "./backoff.js";
import { type Clock, SystemClock, VirtualClock } from "./clock.js";
import type { DeliveryQueue } from "./queue.js";
import type { DeliveryResult, Transport } from "./transport.js";
import type { Delivery } from "./types.js";

export interface WorkerOptions {
  policy?: BackoffPolicy;
  clock?: Clock;
  rand?: () => number;
}

export class DeliveryWorker {
  private readonly policy: BackoffPolicy;
  private readonly clock: Clock;
  private readonly rand: () => number;
  private ticking = false;

  constructor(
    private readonly queue: DeliveryQueue,
    private readonly transport: Transport,
    opts: WorkerOptions = {},
  ) {
    this.policy = opts.policy ?? DEFAULT_BACKOFF;
    this.clock = opts.clock ?? new SystemClock();
    this.rand = opts.rand ?? Math.random;
  }

  /**
   * Attempt one claimed delivery, advancing its state and releasing the claim.
   * Returns the new status. A delivered or dead delivery is never sent again,
   * and a result that lands after another attempt made the delivery final
   * does not overwrite it.
   */
  async attempt(delivery: Delivery): Promise<Delivery["status"]> {
    if (delivery.status !== "pending") return delivery.status;
    let result: DeliveryResult;
    try {
      result = await this.transport.send(delivery);
    } catch (err) {
      result = { ok: false, status: 0, error: (err as Error).message };
    }
    delivery.inFlight = false;
    delivery.attempts += 1;
    delivery.updatedAt = this.clock.nowMs();
    if (delivery.status !== "pending") return delivery.status;

    if (result.ok) {
      delivery.status = "delivered";
      delivery.lastError = undefined;
      return "delivered";
    }

    delivery.lastError = result.error ?? `http ${result.status}`;
    if (isExhausted(delivery.attempts, this.policy)) {
      delivery.status = "dead";
      return "dead";
    }
    delivery.status = "pending";
    delivery.nextAttemptAt = this.clock.nowMs() + backoffDelayMs(delivery.attempts + 1, this.policy, this.rand);
    return "pending";
  }

  /**
   * Process every ready delivery once. Returns how many were attempted. While
   * a previous tick is still sending, a new one returns 0 immediately, so an
   * interval timer cannot stack up overlapping ticks behind a slow receiver.
   */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const ready = this.queue.claimReady(this.clock.nowMs());
      for (const d of ready) {
        await this.attempt(d);
      }
      return ready.length;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Drive the queue to a terminal state (delivered or dead). With a
   * VirtualClock, backoff waits are skipped by jumping the clock to the next
   * due delivery, so this returns immediately with no real sleeping.
   * Returns the number of attempts made.
   */
  async drain(maxAttempts = 1_000_000): Promise<number> {
    let attempts = 0;
    while (attempts < maxAttempts) {
      const ready = this.queue.claimReady(this.clock.nowMs());
      if (ready.length > 0) {
        for (const d of ready) {
          await this.attempt(d);
          attempts++;
        }
        continue;
      }
      // Deliveries another caller is sending are its to finish.
      const pending = this.queue.pending().filter((d) => !d.inFlight);
      if (pending.length === 0) break;
      // Pending but not due: advance the virtual clock to the soonest.
      if (this.clock instanceof VirtualClock) {
        const soonest = Math.min(...pending.map((d) => d.nextAttemptAt));
        this.clock.advanceTo(soonest);
      } else {
        break; // real clock: caller must wait and tick again
      }
    }
    return attempts;
  }
}
