// HTTP API for the webhook delivery service. Enqueue deliveries, inspect
// status, and view the dead-letter queue. A background worker drains the queue
// on a fixed interval using the system clock.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { SystemClock } from "./clock.js";
import { DeliveryQueue } from "./queue.js";
import { HttpTransport } from "./transport.js";
import type { EnqueueRequest } from "./types.js";
import { DeliveryWorker } from "./worker.js";

const DEV_SECRET = "dev-secret-change-me";
const secret = process.env["WEBHOOK_SECRET"] ?? DEV_SECRET;

// Fail-fast in production: refuse to boot if the HMAC signing secret is
// missing or still the dev default. Receivers verify signatures with this
// secret; a known default trivially defeats the whole signing scheme.
if (process.env["NODE_ENV"] === "production" && secret === DEV_SECRET) {
  console.error(
    "FATAL: WEBHOOK_SECRET must be set to a real value in production. " +
    "The dev default 'dev-secret-change-me' is not allowed.",
  );
  process.exit(1);
}

const queue = new DeliveryQueue();
const worker = new DeliveryWorker(queue, new HttpTransport(), { secret, clock: new SystemClock() });

// Background drain loop (production uses the real clock).
const intervalMs = Number(process.env["TICK_MS"] ?? 200);
setInterval(() => {
  void worker.tick();
}, intervalMs);

const app = new Hono();

app.get("/healthz", (c) => c.json({ status: "ok" }));

app.post("/webhooks", async (c) => {
  const body = await c.req.json<EnqueueRequest>().catch(() => null);
  if (!body || typeof body.url !== "string" || !/^https?:\/\//.test(body.url)) {
    return c.json({ error: "url (http/https) and payload are required" }, 400);
  }
  const delivery = queue.enqueue(body);
  return c.json({ id: delivery.id, status: delivery.status, idempotencyKey: delivery.idempotencyKey }, 202);
});

app.get("/deliveries/:id", (c) => {
  const d = queue.get(c.req.param("id"));
  if (!d) return c.json({ error: "not found" }, 404);
  return c.json(d);
});

app.get("/dlq", (c) => c.json({ deadLetters: queue.deadLetters() }));

app.get("/stats", (c) => c.json(queue.stats()));

const port = Number(process.env["PORT"] ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`webhook-delivery listening on :${info.port}`);
});

export { app, queue, worker };
