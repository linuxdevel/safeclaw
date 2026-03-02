import { describe, it, expect } from "vitest";
import { validateAuthToken, verifyToken, AuthError } from "./auth.js";

describe("validateAuthToken", () => {
  it("accepts a 32+ character token", () => {
    expect(() => validateAuthToken("a".repeat(32))).not.toThrow();
  });

  it("accepts a token longer than 32 characters", () => {
    expect(() => validateAuthToken("a".repeat(64))).not.toThrow();
  });

  it("rejects an empty token", () => {
    expect(() => validateAuthToken("")).toThrow(AuthError);
  });

  it("rejects a short token (< 32 characters)", () => {
    expect(() => validateAuthToken("short-token")).toThrow(AuthError);
    expect(() => validateAuthToken("a".repeat(31))).toThrow(AuthError);
  });

  it("includes guidance about mandatory auth in error message", () => {
    expect(() => validateAuthToken("short")).toThrow(/no "none" mode/);
  });
});

describe("verifyToken", () => {
  const token = "a".repeat(32);

  it("returns true for matching tokens", () => {
    expect(verifyToken(token, token)).toBe(true);
  });

  it("returns false for wrong token of same length", () => {
    const wrong = "b".repeat(32);
    expect(verifyToken(wrong, token)).toBe(false);
  });

  it("returns false for different length tokens", () => {
    expect(verifyToken("short", token)).toBe(false);
    expect(verifyToken(token + "extra", token)).toBe(false);
  });
});
