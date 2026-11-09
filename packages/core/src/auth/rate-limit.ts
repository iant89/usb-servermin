/** Fixed-window counter with lockout, used for login attempts (§20 rate limiting). */
export class AttemptLimiter {
  private attempts = new Map<string, { count: number; first: number; lockedUntil: number }>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    private readonly lockoutMs: number,
  ) {}

  isLocked(key: string, now = Date.now()): number {
    const a = this.attempts.get(key);
    if (!a) return 0;
    if (a.lockedUntil > now) return a.lockedUntil - now;
    if (now - a.first > this.windowMs) this.attempts.delete(key);
    return 0;
  }

  fail(key: string, now = Date.now()) {
    const a = this.attempts.get(key);
    if (!a || now - a.first > this.windowMs) {
      this.attempts.set(key, { count: 1, first: now, lockedUntil: 0 });
      return;
    }
    a.count++;
    if (a.count >= this.maxAttempts) a.lockedUntil = now + this.lockoutMs;
  }

  succeed(key: string) {
    this.attempts.delete(key);
  }
}

/** Token bucket per client, used for the API as a whole. */
export class TokenBucket {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {}

  take(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refillPerSecond);
    b.at = now;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) for (const k of [...this.buckets.keys()].slice(0, 5000)) this.buckets.delete(k);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
