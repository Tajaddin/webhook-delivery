export type DeliveryStatus = "pending" | "delivered" | "failed" | "dead";

export interface Delivery {
  /** Sent as `webhook-id` on every attempt, so receivers can drop retried duplicates. */
  id: string;
  /** Idempotency key; duplicate enqueues with the same key for the same endpoint are deduped. */
  idempotencyKey: string;
  endpointId: string;
  url: string;
  body: string;
  status: DeliveryStatus;
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  /** Earliest time (epoch ms) the delivery is eligible to be attempted. */
  nextAttemptAt: number;
  /** Set by claimReady while a worker attempts the delivery; nobody else can
   *  claim it until that attempt is recorded. */
  inFlight: boolean;
}

export interface EnqueueRequest {
  endpointId: string;
  url: string;
  payload: unknown;
  idempotencyKey?: string;
}
