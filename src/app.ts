// HTTP API for the webhook delivery service. Register endpoints, enqueue
// deliveries, inspect status, and view the dead-letter queue. Every route
// except /healthz requires `Authorization: Bearer <apiToken>`.

import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { EndpointRegistry } from "./endpoints.js";
import type { DeliveryQueue } from "./queue.js";
import { checkUrl } from "./ssrf.js";

export function createApp(opts: { queue: DeliveryQueue; endpoints: EndpointRegistry; apiToken: string }): Hono {
  const { queue, endpoints } = opts;
  const app = new Hono();

  // Registered before the auth middleware, so health checks need no token.
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.use("*", bearerAuth({ token: opts.apiToken }));

  // The response is the only time the endpoint's signing secret is shown.
  app.post("/endpoints", async (c) => {
    const body = await c.req.json<{ url?: unknown }>().catch(() => null);
    if (!body || typeof body.url !== "string") return c.json({ error: "url is required" }, 400);
    const refused = checkUrl(body.url);
    if (refused) return c.json({ error: refused }, 400);
    return c.json(endpoints.register(body.url), 201);
  });

  app.post("/webhooks", async (c) => {
    const body = await c.req
      .json<{ endpointId?: unknown; payload?: unknown; idempotencyKey?: unknown }>()
      .catch(() => null);
    if (!body || typeof body.endpointId !== "string" || body.payload === undefined) {
      return c.json({ error: "endpointId and payload are required" }, 400);
    }
    const { endpointId, payload, idempotencyKey } = body;
    if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
      return c.json({ error: "idempotencyKey must be a string" }, 400);
    }
    const endpoint = endpoints.get(endpointId);
    if (!endpoint) return c.json({ error: "unknown endpoint" }, 404);
    const delivery = queue.enqueue({ endpointId, url: endpoint.url, payload, idempotencyKey });
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
