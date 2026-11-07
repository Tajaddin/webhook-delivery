# webhook-delivery

> At-least-once webhook delivery with exponential backoff, dead-letter queue, per-endpoint HMAC signing, idempotency and an SSRF guard. **99.92% eventual delivery under 30% transient-failure injection** (deterministic simulation: virtual clock, fake transport, no network). TypeScript + Hono, 91 tests.

[![ci](https://github.com/Tajaddin/webhook-delivery/actions/workflows/ci.yml/badge.svg)](https://github.com/Tajaddin/webhook-delivery/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-20%2B-green)](package.json)

## Hero metrics

Reproducible in ~1.5 seconds with no network:

```bash
npx tsx benchmarks/fault_injection.ts --count 20000 --failure-rate 0.3 --dead-fraction 0.02
```

| Metric | Value |
|---|---:|
| Deliveries | 20,000 |
| Transient failure injected | 30% per attempt |
| Permanently-down endpoints | 434 (2%) |
| **Eventual delivery rate (deliverable)** | **99.92%** |
| Dispatch throughput (in-process, fake transport) | 35,759 /sec |
| Attempts per delivery | 1.53 |
| Dead-lettered | 449 (434 permanent + 15 exhausted) |
| Stuck pending | 0 |

Every row except throughput is deterministic and identical on every run. Throughput is wall-clock: the median of 5 consecutive runs (range 31,449 to 46,622 /sec) on an i5-13600KF with Node 24.14, and it moves with machine load. `benchmarks/results/fault_injection.json` holds the last run.

At-least-once plus bounded retries delivers essentially everything whose endpoint is reachable, dead-letters the rest, and never leaves a delivery stuck. With the default 6-attempt policy, `0.3^6 ≈ 0.07%` of messages exhaust retries; raise `maxAttempts` and that goes to zero (the test suite proves 100% delivery at 50% failure with a 20-attempt policy).

## What it is

A webhook dispatcher with the guarantees production systems actually need:

| Guarantee | How |
|---|---|
| **At-least-once** | Every delivery is retried until success or attempt exhaustion; nothing is dropped silently. |
| **Exponential backoff + jitter** | `backoff.ts` caps the delay and uses full jitter to avoid thundering herds. |
| **Dead-letter queue** | Exhausted deliveries move to `dead` and are inspectable at `/dlq`. |
| **HMAC signing, per endpoint** | Each registered endpoint gets its own secret. `signing.ts` signs `${timestamp}.${webhook-id}.${endpoint-id}.${body}` with HMAC-SHA256 (Stripe-style `t=,v1=` header), verified in constant time with replay-window enforcement, so a signed request cannot be replayed to another endpoint or as another delivery. |
| **Idempotency** | Re-enqueuing the same idempotency key for the same endpoint returns the existing delivery instead of creating a second one. Every attempt carries the delivery id as `webhook-id`, so receivers can drop retried duplicates. |
| **SSRF guard** | `ssrf.ts` resolves each receiver hostname inside the socket's own lookup, refuses private, loopback, link-local, ULA and cloud-metadata addresses (IPv4 and IPv6, including IPv4-mapped), connects only to the addresses it checked (no DNS rebinding), allows ports 80 and 443 only, and never follows redirects. |
| **Deterministic testing** | The clock and RNG are injectable; a `VirtualClock` makes backoff waits instant, so the full retry/DLQ behavior is tested with no real time and no network. |

## Why this matters for hiring

Role categories unlocked: **Backend (Node/TypeScript)**, Platform Engineering, integrations.

"At-least-once delivery with retries and a DLQ" is a staple platform-engineering interview topic. This repo backs it with a real state machine, HMAC auth, idempotency, and a fault-injection benchmark that proves the guarantee instead of asserting it.

## How to run

Prerequisites: Node 20+.

```bash
npm install
npm test                  # 91 vitest cases
export API_TOKEN=$(openssl rand -hex 32)   # required, no default
npm run dev               # API on :8080, background worker draining every 200ms
npm run bench             # fault-injection benchmark (99.92% eventual delivery hero)
```

```bash
# every route except /healthz needs the bearer token
AUTH="authorization: Bearer $API_TOKEN"

# register a receiver; the response is the only time its signing secret is shown
curl -s -XPOST localhost:8080/endpoints -H "$AUTH" -H 'content-type: application/json' \
  -d '{"url":"https://httpbin.org/post"}'
# -> {"id":"<endpoint-id>","url":"https://httpbin.org/post","secret":"...","createdAt":...}

# enqueue a delivery to it
curl -s -XPOST localhost:8080/webhooks -H "$AUTH" -H 'content-type: application/json' \
  -d '{"endpointId":"<endpoint-id>","payload":{"event":"order.created"},"idempotencyKey":"order-42"}'
# -> {"id":"...","status":"pending","idempotencyKey":"order-42"}

curl -s -H "$AUTH" localhost:8080/deliveries/<id>   # status, attempts, lastError
curl -s -H "$AUTH" localhost:8080/dlq               # dead-letter queue
curl -s -H "$AUTH" localhost:8080/stats             # {pending, delivered, failed, dead}
```

Each request carries `webhook-id` (the delivery id, the same on every retry), `webhook-endpoint-id` and `webhook-signature` (`t=<unix>,v1=<hmac>`). Receivers check it with `verify({ webhookId, endpointId, body }, secret, header)` from `src/signing.ts`, passing their own endpoint id and secret (not the header's endpoint id) and the raw body.

## The delivery state machine

```
            transport ok
   pending ───────────────► delivered
      │
      │ fail, retries left           fail, exhausted
      ├──────────────► pending ──────────────────────► dead (DLQ)
      │ (nextAttemptAt =
      │  now + backoff(attempt))
```

`claimReady` marks every delivery it hands out as in flight, and nothing else can claim it until that attempt is recorded. A tick that starts while the previous one is still sending returns at once. A late result never overwrites `delivered` or `dead`. Delivery is still at-least-once: if a receiver handles a request but its response is lost, the retry arrives with the same `webhook-id`.

## Testing

```bash
npm test     # 91 tests
```

- **signing.test.ts** (9): sign/verify round trip, tamper/wrong-secret rejection, a signature presented with another webhook id or endpoint id is rejected, replay-window enforcement, header parse.
- **backoff.test.ts** (5): cap, full-jitter bounds, exhaustion threshold, attempt validation.
- **queue.test.ts** (6): enqueue, idempotency dedup (original payload preserved) scoped per endpoint, due-only `claimReady`, one claimer at a time, stats/DLQ.
- **worker.test.ts** (9): first-try delivery, retry-then-succeed, dead-letter on exhaustion, 100% delivery under 50% transient failure with sufficient retries, mixed permanent-down + healthy; under concurrency against a slow receiver: overlapping ticks and two workers send once, a late failure never overwrites `delivered`, a throwing transport counts as a failed attempt.
- **ssrf.test.ts** (49, mostly table cases): blocked and allowed IPv4/IPv6 addresses (private, loopback, link-local, metadata, ULA, IPv4-mapped, NAT64, 6to4), URL checks (scheme, port, IP-literal spellings), and the guarded lookup.
- **transport.test.ts** (6): internal destinations and non-web ports refused before connecting, `localhost` refused via the resolved address, redirects not followed, headers and per-endpoint signature against a real local receiver, unknown endpoint not sent.
- **app.test.ts** (7): bearer token required everywhere except `/healthz`, endpoint registration with distinct secrets, enqueue validation, secrets never exposed on reads, internal URLs refused.

## Project layout

```
src/
  signing.ts     # HMAC-SHA256 sign/verify (constant-time, replay window)
  backoff.ts     # exponential backoff + full jitter + exhaustion
  clock.ts       # SystemClock + VirtualClock (deterministic tests/bench)
  endpoints.ts   # endpoint registry, one signing secret per endpoint
  queue.ts       # in-memory delivery queue + idempotency + DLQ
  ssrf.ts        # outbound address/port policy + guarded DNS lookup
  transport.ts   # HttpTransport (node:http, SSRF-guarded) + FakeTransport (programmable failures)
  worker.ts      # the at-least-once state machine
  app.ts         # Hono API (bearer-token auth)
  server.ts      # entry point: env, wiring, background drain loop
benchmarks/fault_injection.ts   # eventual-delivery + throughput hero
```

## Stack

TypeScript (strict, `noUncheckedIndexedAccess`), Hono + @hono/node-server, node:crypto HMAC, Vitest, Docker (alpine), GitHub Actions.

## License

MIT
