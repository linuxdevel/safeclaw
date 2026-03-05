import { describe, it, expect } from "vitest";
import { validateConfig } from "./validate.js";

describe("validateConfig", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(() => validateConfig({})).not.toThrow();
  });

  it("accepts a valid full config", () => {
    expect(() =>
      validateConfig({
        model: "claude-sonnet-4",
        systemPrompt: "Hello",
        maxToolRounds: 5,
        temperature: 0.7,
        maxTokens: 4096,
        gateway: { host: "127.0.0.1", port: 8080 },
        sandbox: { enabled: true, timeout: 10000 },
      }),
    ).not.toThrow();
  });

  it("rejects non-object config", () => {
    expect(() => validateConfig("string")).toThrow(/must be a JSON object/);
    expect(() => validateConfig(null)).toThrow(/must be a JSON object/);
    expect(() => validateConfig(42)).toThrow(/must be a JSON object/);
  });

  it("rejects unknown top-level keys", () => {
    expect(() => validateConfig({ foo: "bar" })).toThrow(
      /Unknown config key: "foo"/,
    );
  });

  it("rejects model when not a string", () => {
    expect(() => validateConfig({ model: 123 })).toThrow(
      /"model" must be a non-empty string/,
    );
  });

  it("rejects empty model string", () => {
    expect(() => validateConfig({ model: "" })).toThrow(
      /"model" must be a non-empty string/,
    );
  });

  it("rejects systemPrompt when not a string", () => {
    expect(() => validateConfig({ systemPrompt: 123 })).toThrow(
      /"systemPrompt" must be a string/,
    );
  });

  it("rejects maxToolRounds when not a positive integer", () => {
    expect(() => validateConfig({ maxToolRounds: 0 })).toThrow(
      /"maxToolRounds" must be a positive integer/,
    );
    expect(() => validateConfig({ maxToolRounds: -1 })).toThrow(
      /"maxToolRounds" must be a positive integer/,
    );
    expect(() => validateConfig({ maxToolRounds: 1.5 })).toThrow(
      /"maxToolRounds" must be a positive integer/,
    );
  });

  it("rejects temperature outside 0.0–2.0 range", () => {
    expect(() => validateConfig({ temperature: -0.1 })).toThrow(
      /"temperature" must be a number between 0 and 2/,
    );
    expect(() => validateConfig({ temperature: 2.1 })).toThrow(
      /"temperature" must be a number between 0 and 2/,
    );
  });

  it("accepts temperature at boundaries", () => {
    expect(() => validateConfig({ temperature: 0 })).not.toThrow();
    expect(() => validateConfig({ temperature: 2 })).not.toThrow();
  });

  it("rejects maxTokens when not a positive integer", () => {
    expect(() => validateConfig({ maxTokens: 0 })).toThrow(
      /"maxTokens" must be a positive integer/,
    );
  });

  it("rejects gateway when not an object", () => {
    expect(() => validateConfig({ gateway: "localhost" })).toThrow(
      /"gateway" must be an object/,
    );
  });

  it("rejects unknown gateway keys", () => {
    expect(() => validateConfig({ gateway: { unknown: true } })).toThrow(
      /Unknown gateway key: "unknown"/,
    );
  });

  it("rejects gateway.host when not a string", () => {
    expect(() => validateConfig({ gateway: { host: 123 } })).toThrow(
      /"gateway.host" must be a non-empty string/,
    );
  });

  it("rejects gateway.port when not a valid port number", () => {
    expect(() => validateConfig({ gateway: { port: 0 } })).toThrow(
      /"gateway.port" must be an integer between 1 and 65535/,
    );
    expect(() => validateConfig({ gateway: { port: 70000 } })).toThrow(
      /"gateway.port" must be an integer between 1 and 65535/,
    );
  });

  it("rejects sandbox when not an object", () => {
    expect(() => validateConfig({ sandbox: true })).toThrow(
      /"sandbox" must be an object/,
    );
  });

  it("rejects unknown sandbox keys", () => {
    expect(() => validateConfig({ sandbox: { bad: 1 } })).toThrow(
      /Unknown sandbox key: "bad"/,
    );
  });

  it("rejects sandbox.enabled when not a boolean", () => {
    expect(() => validateConfig({ sandbox: { enabled: "yes" } })).toThrow(
      /"sandbox.enabled" must be a boolean/,
    );
  });

  it("rejects sandbox.timeout when not a positive integer", () => {
    expect(() => validateConfig({ sandbox: { timeout: -1 } })).toThrow(
      /"sandbox.timeout" must be a positive integer/,
    );
  });

  it("returns the validated value", () => {
    const input = { model: "gpt-4.1", maxToolRounds: 20 };
    const result = validateConfig(input);
    expect(result).toEqual(input);
  });
});
