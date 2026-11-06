// Fault-injection benchmark: enqueue N deliveries against endpoints that fail
// transiently at a configurable rate, then drain with retries and report the
// eventual delivery rate plus dispatch throughput.
//
// The hero claim: at-least-once + bounded retries delivers 100% of messages
// whose endpoints are not permanently down, even at a high transient-failure
// rate. Deterministic (seeded RNG, virtual clock), no network, no waiting.
//
//   npx tsx benchmarks/fault_injection.ts --count 20000 --failure-rate 0.3

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_BACKOFF } from "../src/backoff.js";
import { VirtualClock } from "../src/clock.js";
import { DeliveryQueue } from "../src/queue.js";
import { FakeTransport } from "../src/transport.js";
import { DeliveryWorker } from "../src/worker.js";

// Small deterministic PRNG (mulberry32) so runs are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseArgs(argv: string[]) {
  const args = { count: 20000, failureRate: 0.3, deadFraction: 0.0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--count") args.count = Number(argv[++i]);
    else if (argv[i] === "--failure-rate") args.failureRate = Number(argv[++i]);
    else if (argv[i] === "--dead-fraction") args.deadFraction = Number(argv[++i]);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rand = mulberry32(7);
  const clock = new VirtualClock(0);
  const queue = new DeliveryQueue();

  // A fraction of endpoints are permanently down (should end in the DLQ).
  const deadUrls = new Set<string>();
  for (let i = 0; i < args.count; i++) {
    const url = `https://hooks.example.com/e/${i}`;
    if (rand() < args.deadFraction) deadUrls.add(url);
    queue.enqueue({ endpointId: `e-${i}`, url, payload: { i }, idempotencyKey: `k-${i}` }, clock.nowMs());
  }

  const transport = new FakeTransport({
    alwaysFail: deadUrls,
    randomFailureRate: args.failureRate,
    rand: mulberry32(99),
  });
  const worker = new DeliveryWorker(queue, transport, {
    policy: DEFAULT_BACKOFF,
    clock,
    rand,
  });

  const start = performance.now();
  const attempts = await worker.drain();
  const elapsedMs = performance.now() - start;

  const stats = queue.stats();
  const deliverable = args.count - deadUrls.size;
  const eventualDeliveryRate = deliverable === 0 ? 1 : stats["delivered"]! / deliverable;

  const summary = {
    count: args.count,
    transient_failure_rate: args.failureRate,
    permanently_dead_endpoints: deadUrls.size,
    total_transport_attempts: transport.calls,
    attempts_per_delivery: Number((attempts / args.count).toFixed(3)),
    delivered: stats["delivered"],
    dead: stats["dead"],
    pending: stats["pending"],
    eventual_delivery_rate_pct: Number((eventualDeliveryRate * 100).toFixed(2)),
    dispatch_throughput_per_sec: Math.round((attempts / elapsedMs) * 1000),
    wall_ms: Number(elapsedMs.toFixed(1)),
  };

  mkdirSync(dirname("benchmarks/results/fault_injection.json"), { recursive: true });
  writeFileSync("benchmarks/results/fault_injection.json", JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
