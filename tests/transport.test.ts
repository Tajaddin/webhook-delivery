import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLIC_WEB } from "../src/ssrf.js";
import { HttpTransport } from "../src/transport.js";

let server: Server | undefined;

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

/** A receiver on 127.0.0.1 and a policy that allows only that receiver. */
async function receiver(handler: (req: IncomingMessage, body: string) => { status: number; headers?: Record<string, string> }) {
  const requests: { url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", headers: req.headers, body });
      const reply = handler(req, body);
      res.writeHead(reply.status, reply.headers).end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const policy = { ports: new Set([port]), isBlockedAddress: (address: string) => address !== "127.0.0.1" };
  return { base: `http://127.0.0.1:${port}`, requests, transport: new HttpTransport(2000, policy) };
}

describe("HttpTransport", () => {
  it("refuses internal destinations before connecting", async () => {
    const transport = new HttpTransport();
    for (const url of ["http://127.0.0.1/hook", "http://[::1]/hook", "http://169.254.169.254/latest/meta-data/"]) {
      const result = await transport.send(url, "{}", "s");
      expect(result).toMatchObject({ ok: false, status: 0 });
      expect(result.error).toMatch(/not allowed/);
    }
  });

  it("checks the resolved address of a hostname", async () => {
    // localhost passes the URL check (a name, port 80); only the guarded
    // lookup stands between it and a loopback connection.
    const result = await new HttpTransport(2000, PUBLIC_WEB).send("http://localhost/hook", "{}", "s");
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(result.error).toMatch(/non-public address/);
  });

  it("refuses ports other than 80 and 443", async () => {
    const result = await new HttpTransport().send("https://example.com:8443/hook", "{}", "s");
    expect(result.error).toMatch(/port 8443 is not allowed/);
  });

  it("does not follow redirects", async () => {
    const { base, requests, transport } = await receiver(() => ({ status: 302, headers: { location: "/internal" } }));
    const result = await transport.send(`${base}/hook`, "{}", "s");
    expect(result).toEqual({ ok: false, status: 302, error: "http 302" });
    expect(requests.map((r) => r.url)).toEqual(["/hook"]);
  });

  it("posts the body with a signature on 2xx", async () => {
    const { base, requests, transport } = await receiver(() => ({ status: 204 }));
    const result = await transport.send(`${base}/hook`, '{"a":1}', "s");
    expect(result).toEqual({ ok: true, status: 204, error: undefined });
    expect(requests[0]?.body).toBe('{"a":1}');
    expect(requests[0]?.headers["webhook-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });
});
