export type DeliveryStatus = "pending" | "delivered" | "failed" | "dead";

export interface Delivery {
  id: string;
  /** Idempotency key; duplicate enqueues with the same key are deduped. */
  idempotencyKey: string;
  url: string;
  body: string;
  status: DeliveryStatus;
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  /** Earliest time (epoch ms) the delivery is eligible to be attempted. */
  nextAttemptAt: number;
}

export interface EnqueueRequest {
  url: string;
  payload: unknown;
  idempotencyKey?: string;
}
