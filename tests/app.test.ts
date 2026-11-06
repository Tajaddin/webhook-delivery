import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { EndpointRegistry } from "../src/endpoints.js";
import { DeliveryQueue } from "../src/queue.js";

const TOKEN = "test-token";

function setup() {
  const queue = new DeliveryQueue();
  const endpoints = new EndpointRegistry();
  return { queue, endpoints, app: createApp({ queue, endpoints, apiToken: TOKEN }) };
}

function post(app: ReturnType<typeof createApp>, path: string, body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("API", () => {
  it("rejects requests without a token or with a wrong one", async () => {
    const { app, queue, endpoints } = setup();
    const { id: endpointId } = endpoints.register("https://example.com/hook");
    for (const token of [null, "wrong"]) {
      expect((await post(app, "/webhooks", { endpointId, payload: {} }, token)).status).toBe(401);
      expect((await post(app, "/endpoints", { url: "https://example.com/hook" }, token)).status).toBe(401);
    }
    expect(queue.size).toBe(0);
  });

  it("requires the token on read routes too", async () => {
    const { app } = setup();
    for (const path of ["/deliveries/x", "/dlq", "/stats"]) {
      expect((await app.request(path)).status).toBe(401);
    }
  });

  it("leaves /healthz open", async () => {
    const { app } = setup();
    expect((await app.request("/healthz")).status).toBe(200);
  });

  it("registers an endpoint with its own secret, then enqueues to it", async () => {
    const { app, queue } = setup();
    const created = await post(app, "/endpoints", { url: "https://example.com/hook" });
    expect(created.status).toBe(201);
    const endpoint = (await created.json()) as { id: string; url: string; secret: string };
    expect(endpoint.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const other = (await (await post(app, "/endpoints", { url: "https://example.com/hook" })).json()) as { secret: string };
    expect(other.secret).not.toBe(endpoint.secret);

    const res = await post(app, "/webhooks", { endpointId: endpoint.id, payload: { a: 1 } });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    expect(queue.get(id)).toMatchObject({ status: "pending", endpointId: endpoint.id, url: "https://example.com/hook" });
  });

  it("does not expose endpoint secrets on delivery reads", async () => {
    const { app, endpoints } = setup();
    const endpoint = endpoints.register("https://example.com/hook");
    const { id } = (await (await post(app, "/webhooks", { endpointId: endpoint.id, payload: {} })).json()) as { id: string };
    const read = await app.request(`/deliveries/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(await read.text()).not.toContain(endpoint.secret);
  });

  it("rejects enqueue to an unknown endpoint or without a payload", async () => {
    const { app, endpoints, queue } = setup();
    const { id: endpointId } = endpoints.register("https://example.com/hook");
    expect((await post(app, "/webhooks", { endpointId: "nope", payload: {} })).status).toBe(404);
    expect((await post(app, "/webhooks", { endpointId })).status).toBe(400);
    expect((await post(app, "/webhooks", { endpointId, payload: {}, idempotencyKey: 42 })).status).toBe(400);
    expect(queue.size).toBe(0);
  });

  it("refuses internal and non-web endpoint URLs", async () => {
    const { app } = setup();
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1/admin", "http://example.com:6379/"]) {
      expect((await post(app, "/endpoints", { url })).status).toBe(400);
    }
  });
});
