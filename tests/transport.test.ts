import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { verify } from "../src/signing.js";
import { PUBLIC_WEB } from "../src/ssrf.js";
import { HttpTransport } from "../src/transport.js";

const SECRETS: Record<string, string> = { "ep-1": "secret-1", "ep-2": "secret-2" };
const secretFor = (endpointId: string) => SECRETS[endpointId];
const webhook = (url: string, endpointId = "ep-1") => ({ id: "d-1", endpointId, url, body: '{"a":1}' });

let server: Server | undefined;

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

/** A receiver on 127.0.0.1 and a policy that allows only that receiver. */
async function receiver(reply: { status: number; headers?: Record<string, string> }) {
  const requests: { url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", headers: req.headers, body });
      res.writeHead(reply.status, reply.headers).end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const policy = { ports: new Set([port]), isBlockedAddress: (address: string) => address !== "127.0.0.1" };
  return { base: `http://127.0.0.1:${port}`, requests, transport: new HttpTransport(secretFor, 2000, policy) };
}

describe("HttpTransport", () => {
  it("refuses internal destinations before connecting", async () => {
    const transport = new HttpTransport(secretFor);
    for (const url of ["http://127.0.0.1/hook", "http://[::1]/hook", "http://169.254.169.254/latest/meta-data/"]) {
      const result = await transport.send(webhook(url));
      expect(result).toMatchObject({ ok: false, status: 0 });
      expect(result.error).toMatch(/not allowed/);
    }
  });

  it("checks the resolved address of a hostname", async () => {
    // localhost passes the URL check (a name, port 80); only the guarded
    // lookup stands between it and a loopback connection.
    const result = await new HttpTransport(secretFor, 2000, PUBLIC_WEB).send(webhook("http://localhost/hook"));
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(result.error).toMatch(/non-public address/);
  });

  it("refuses ports other than 80 and 443", async () => {
    const result = await new HttpTransport(secretFor).send(webhook("https://example.com:8443/hook"));
    expect(result.error).toMatch(/port 8443 is not allowed/);
  });

  it("does not follow redirects", async () => {
    const { base, requests, transport } = await receiver({ status: 302, headers: { location: "/internal" } });
    const result = await transport.send(webhook(`${base}/hook`));
    expect(result).toEqual({ ok: false, status: 302, error: "http 302" });
    expect(requests.map((r) => r.url)).toEqual(["/hook"]);
  });

  it("sends webhook-id and endpoint id, signed with that endpoint's secret", async () => {
    const { base, requests, transport } = await receiver({ status: 204 });
    const result = await transport.send(webhook(`${base}/hook`));
    expect(result).toEqual({ ok: true, status: 204, error: undefined });

    const req = requests[0]!;
    expect(req.body).toBe('{"a":1}');
    expect(req.headers["webhook-id"]).toBe("d-1");
    expect(req.headers["webhook-endpoint-id"]).toBe("ep-1");
    const header = req.headers["webhook-signature"] as string;
    const received = { webhookId: "d-1", endpointId: "ep-1", body: req.body };
    expect(verify(received, "secret-1", header)).toBe(true);
    // Another endpoint cannot accept it: different secret and endpoint id.
    expect(verify({ ...received, endpointId: "ep-2" }, "secret-2", header)).toBe(false);
  });

  it("does not send for an unregistered endpoint", async () => {
    const { base, requests, transport } = await receiver({ status: 204 });
    const result = await transport.send(webhook(`${base}/hook`, "ep-unknown"));
    expect(result).toEqual({ ok: false, status: 0, error: "unknown endpoint" });
    expect(requests).toHaveLength(0);
  });
});
