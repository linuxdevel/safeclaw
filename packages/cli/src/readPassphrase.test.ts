import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { readPassphrase } from "./readPassphrase.js";

describe("readPassphrase", () => {
  it("masks input with asterisks and returns typed text", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding("utf8");

    const promise = readPassphrase("Enter passphrase: ", input, output);

    // Simulate typing "secret" then Enter
    for (const ch of "secret") {
      input.write(ch);
    }
    input.write("\r"); // Enter key

    const result = await promise;
    expect(result).toBe("secret");

    // Output should contain the prompt and asterisks
    const written = output.read() as string;
    expect(written).toContain("Enter passphrase: ");
    expect(written).toContain("*");
    expect(written).not.toContain("secret");
  });

  it("handles backspace", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding("utf8");

    const promise = readPassphrase("Pass: ", input, output);

    // Type "abc", backspace, "d", Enter
    input.write("a");
    input.write("b");
    input.write("c");
    input.write("\x7f"); // backspace
    input.write("d");
    input.write("\r");

    const result = await promise;
    expect(result).toBe("abd");
  });

  it("handles Ctrl+C by rejecting", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const promise = readPassphrase("Pass: ", input, output);

    input.write("\x03"); // Ctrl+C

    await expect(promise).rejects.toThrow("Aborted");
  });
});
