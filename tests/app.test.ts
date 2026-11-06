import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DeliveryQueue } from "../src/queue.js";

const TOKEN = "test-token";

function setup() {
  const queue = new DeliveryQueue();
  return { queue, app: createApp({ queue, apiToken: TOKEN }) };
}

function enqueue(app: ReturnType<typeof createApp>, body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return app.request("/webhooks", { method: "POST", headers, body: JSON.stringify(body) });
}

describe("API", () => {
  it("rejects enqueue without a token or with a wrong one", async () => {
    const { app, queue } = setup();
    const body = { url: "https://example.com/hook", payload: {} };
    expect((await enqueue(app, body, null)).status).toBe(401);
    expect((await enqueue(app, body, "wrong")).status).toBe(401);
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

  it("enqueues with a valid token", async () => {
    const { app, queue } = setup();
    const res = await enqueue(app, { url: "https://example.com/hook", payload: { a: 1 } });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    expect(queue.get(id)?.status).toBe("pending");
  });

  it("refuses internal and non-web destinations at enqueue", async () => {
    const { app, queue } = setup();
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1/admin", "http://example.com:6379/"]) {
      expect((await enqueue(app, { url, payload: {} })).status).toBe(400);
    }
    expect(queue.size).toBe(0);
  });
});
