// Entry point: wires the queue, worker and HTTP API together. A background
// worker drains the queue on a fixed interval using the system clock.

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { SystemClock } from "./clock.js";
import { DeliveryQueue } from "./queue.js";
import { HttpTransport } from "./transport.js";
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

// No default: an open enqueue endpoint lets anyone send signed requests from
// this service.
const apiToken = process.env["API_TOKEN"];
if (!apiToken) {
  console.error("FATAL: API_TOKEN must be set. Every route except /healthz requires it as a bearer token.");
  process.exit(1);
}

const queue = new DeliveryQueue();
const worker = new DeliveryWorker(queue, new HttpTransport(), { secret, clock: new SystemClock() });

// Background drain loop (production uses the real clock).
const intervalMs = Number(process.env["TICK_MS"] ?? 200);
setInterval(() => {
  void worker.tick();
}, intervalMs);

const app = createApp({ queue, apiToken });

const port = Number(process.env["PORT"] ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`webhook-delivery listening on :${info.port}`);
});

export { app, queue, worker };
