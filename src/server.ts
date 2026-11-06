// Entry point: wires the queue, worker and HTTP API together. A background
// worker drains the queue on a fixed interval using the system clock.

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { SystemClock } from "./clock.js";
import { EndpointRegistry } from "./endpoints.js";
import { DeliveryQueue } from "./queue.js";
import { HttpTransport } from "./transport.js";
import { DeliveryWorker } from "./worker.js";

// No default: an open enqueue endpoint lets anyone send signed requests from
// this service.
const apiToken = process.env["API_TOKEN"];
if (!apiToken) {
  console.error("FATAL: API_TOKEN must be set. Every route except /healthz requires it as a bearer token.");
  process.exit(1);
}

const endpoints = new EndpointRegistry();
const queue = new DeliveryQueue();
const transport = new HttpTransport((endpointId) => endpoints.get(endpointId)?.secret);
const worker = new DeliveryWorker(queue, transport, { clock: new SystemClock() });

// Background drain loop (production uses the real clock).
const intervalMs = Number(process.env["TICK_MS"] ?? 200);
setInterval(() => {
  void worker.tick();
}, intervalMs);

const app = createApp({ queue, endpoints, apiToken });

const port = Number(process.env["PORT"] ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`webhook-delivery listening on :${info.port}`);
});

export { app, endpoints, queue, worker };
