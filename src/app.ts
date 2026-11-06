// HTTP API for the webhook delivery service. Enqueue deliveries, inspect
// status, and view the dead-letter queue. Every route except /healthz requires
// `Authorization: Bearer <apiToken>`.

import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { DeliveryQueue } from "./queue.js";
import { checkUrl } from "./ssrf.js";
import type { EnqueueRequest } from "./types.js";

export function createApp(opts: { queue: DeliveryQueue; apiToken: string }): Hono {
  const { queue } = opts;
  const app = new Hono();

  // Registered before the auth middleware, so health checks need no token.
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.use("*", bearerAuth({ token: opts.apiToken }));

  app.post("/webhooks", async (c) => {
    const body = await c.req.json<EnqueueRequest>().catch(() => null);
    if (!body || typeof body.url !== "string") {
      return c.json({ error: "url (http/https) and payload are required" }, 400);
    }
    const refused = checkUrl(body.url);
    if (refused) return c.json({ error: refused }, 400);
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

  return app;
}
