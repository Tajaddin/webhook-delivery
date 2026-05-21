// Clock abstraction so the worker runs on wall-clock time in production and a
// controllable virtual clock in tests/benchmarks (no real waiting on backoff).

export interface Clock {
  nowMs(): number;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

export class VirtualClock implements Clock {
  constructor(public t = 0) {}

  nowMs(): number {
    return this.t;
  }

  /** Move the clock forward to `t` (never backward). */
  advanceTo(t: number): void {
    if (t > this.t) this.t = t;
  }
}
