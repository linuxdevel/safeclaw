import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "./rate-limit.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests within limit", () => {
    const limiter = new RateLimiter(3, 60_000);

    expect(limiter.check("client-1")).toBe(true);
    expect(limiter.check("client-1")).toBe(true);
    expect(limiter.check("client-1")).toBe(true);
  });

  it("blocks requests over limit", () => {
    const limiter = new RateLimiter(2, 60_000);

    expect(limiter.check("client-1")).toBe(true);
    expect(limiter.check("client-1")).toBe(true);
    expect(limiter.check("client-1")).toBe(false);
  });

  it("refills tokens after window passes", () => {
    const limiter = new RateLimiter(2, 60_000);

    expect(limiter.check("client-1")).toBe(true);
    expect(limiter.check("client-1")).toBe(true);
    expect(limiter.check("client-1")).toBe(false);

    // Advance time past the full window
    vi.advanceTimersByTime(60_000);

    expect(limiter.check("client-1")).toBe(true);
  });

  it("tracks separate limits per client", () => {
    const limiter = new RateLimiter(1, 60_000);

    expect(limiter.check("client-a")).toBe(true);
    expect(limiter.check("client-a")).toBe(false);

    // Different client should still have its own allowance
    expect(limiter.check("client-b")).toBe(true);
    expect(limiter.check("client-b")).toBe(false);
  });

  it("reset clears client's state", () => {
    const limiter = new RateLimiter(1, 60_000);

    expect(limiter.check("client-1")).toBe(true);
    expect(limiter.check("client-1")).toBe(false);

    limiter.reset("client-1");

    expect(limiter.check("client-1")).toBe(true);
  });
});
