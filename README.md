# webhook-delivery

> At-least-once webhook delivery with exponential backoff, dead-letter queue, HMAC signing, and idempotency. **99.92% eventual delivery under 30% transient-failure injection, 20,933 dispatches/sec** (deterministic, virtual clock, no network). TypeScript + Hono, 21 tests.

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
| **Dispatch throughput** | **20,933 /sec** |
| Attempts per delivery | 1.53 |
| Dead-lettered | 449 (434 permanent + 15 exhausted) |
| Stuck pending | 0 |

At-least-once plus bounded retries delivers essentially everything whose endpoint is reachable, dead-letters the rest, and never leaves a delivery stuck. With the default 6-attempt policy, `0.3^6 ≈ 0.07%` of messages exhaust retries; raise `maxAttempts` and that goes to zero (the test suite proves 100% delivery at 50% failure with a 20-attempt policy).

## What it is

A webhook dispatcher with the guarantees production systems actually need:

| Guarantee | How |
|---|---|
| **At-least-once** | Every delivery is retried until success or attempt exhaustion; nothing is dropped silently. |
| **Exponential backoff + jitter** | `backoff.ts` caps the delay and uses full jitter to avoid thundering herds. |
| **Dead-letter queue** | Exhausted deliveries move to `dead` and are inspectable at `/dlq`. |
| **HMAC signing** | `signing.ts` signs `${timestamp}.${body}` with HMAC-SHA256 (Stripe-style `t=,v1=` header), verified in constant time with replay-window enforcement. |
| **Idempotency** | Re-enqueuing the same idempotency key returns the existing delivery; no duplicate sends. |
| **SSRF guard** | `ssrf.ts` resolves each receiver hostname inside the socket's own lookup, refuses private, loopback, link-local, ULA and cloud-metadata addresses (IPv4 and IPv6, including IPv4-mapped), connects only to the addresses it checked (no DNS rebinding), allows ports 80 and 443 only, and never follows redirects. |
| **Deterministic testing** | The clock and RNG are injectable; a `VirtualClock` makes backoff waits instant, so the full retry/DLQ behavior is tested with no real time and no network. |

## Why this matters for hiring

Role categories unlocked: **Backend (Node/TypeScript)**, Platform Engineering, integrations.

"At-least-once delivery with retries and a DLQ" is a staple platform-engineering interview topic. This repo backs it with a real state machine, HMAC auth, idempotency, and a fault-injection benchmark that proves the guarantee instead of asserting it.

## How to run

Prerequisites: Node 20+.

```bash
npm install
npm test                  # 21 vitest cases
export API_TOKEN=$(openssl rand -hex 32)   # required, no default
npm run dev               # API on :8080, background worker draining every 200ms
npm run bench             # fault-injection benchmark (99.92% eventual delivery hero)
```

```bash
# every route except /healthz needs the bearer token
AUTH="authorization: Bearer $API_TOKEN"

# enqueue a delivery
curl -s -XPOST localhost:8080/webhooks -H "$AUTH" -H 'content-type: application/json' \
  -d '{"url":"https://httpbin.org/post","payload":{"event":"order.created"},"idempotencyKey":"order-42"}'
# -> {"id":"...","status":"pending","idempotencyKey":"order-42"}

curl -s -H "$AUTH" localhost:8080/deliveries/<id>   # status, attempts, lastError
curl -s -H "$AUTH" localhost:8080/dlq               # dead-letter queue
curl -s -H "$AUTH" localhost:8080/stats             # {pending, delivered, failed, dead}
```

Receivers verify the `webhook-signature` header (`t=<unix>,v1=<hmac>`) with the shared secret using `verify()` from `src/signing.ts`.

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

## Testing

```bash
npm test     # 21 tests
```

- **signing.test.ts** (7): sign/verify round trip, tamper/wrong-secret rejection, replay-window enforcement, header parse.
- **backoff.test.ts** (5): cap, full-jitter bounds, exhaustion threshold, attempt validation.
- **queue.test.ts** (4): enqueue, idempotency dedup (original payload preserved), due-only `claimReady`, stats/DLQ.
- **worker.test.ts** (5): first-try delivery, retry-then-succeed, dead-letter on exhaustion, 100% delivery under 50% transient failure with sufficient retries, mixed permanent-down + healthy.

## Project layout

```
src/
  signing.ts     # HMAC-SHA256 sign/verify (constant-time, replay window)
  backoff.ts     # exponential backoff + full jitter + exhaustion
  clock.ts       # SystemClock + VirtualClock (deterministic tests/bench)
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
