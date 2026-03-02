export class RateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private maxTokens: number;
  private windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxTokens = maxRequests;
    this.windowMs = windowMs;
  }

  /** Check if a request from clientId is allowed. Returns true if allowed. */
  check(clientId: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(clientId);

    if (!bucket) {
      this.buckets.set(clientId, { tokens: this.maxTokens - 1, lastRefill: now });
      return true;
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    const refill = Math.floor((elapsed / this.windowMs) * this.maxTokens);

    if (refill > 0) {
      bucket.tokens = Math.min(this.maxTokens, bucket.tokens + refill);
      bucket.lastRefill = now;
    }

    if (bucket.tokens > 0) {
      bucket.tokens--;
      return true;
    }

    return false;
  }

  /** Reset rate limit state for a client */
  reset(clientId: string): void {
    this.buckets.delete(clientId);
  }
}
