/**
 * Read a passphrase from the terminal with asterisk masking.
 *
 * Uses raw mode when available (real TTY), otherwise falls back to
 * character-by-character reading (works with PassThrough in tests).
 */
export function readPassphrase(
  prompt: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string> {
  output.write(prompt);

  return new Promise<string>((resolve, reject) => {
    const chars: string[] = [];

    const onData = (data: Buffer): void => {
      const str = data.toString("utf8");

      for (const ch of str) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          output.write("\n");
          resolve(chars.join(""));
          return;
        }

        if (ch === "\x03") {
          cleanup();
          output.write("\n");
          reject(new Error("Aborted"));
          return;
        }

        if (ch === "\x7f" || ch === "\b") {
          if (chars.length > 0) {
            chars.pop();
            output.write("\b \b");
          }
          continue;
        }

        // Printable character
        chars.push(ch);
        output.write("*");
      }
    };

    const cleanup = (): void => {
      input.removeListener("data", onData);
      if (
        "setRawMode" in input &&
        typeof (input as NodeJS.ReadStream).setRawMode === "function"
      ) {
        (input as NodeJS.ReadStream).setRawMode(false);
      }
    };

    // Enable raw mode if available (real TTY)
    if (
      "setRawMode" in input &&
      typeof (input as NodeJS.ReadStream).setRawMode === "function"
    ) {
      (input as NodeJS.ReadStream).setRawMode(true);
    }

    input.on("data", onData);
  });
}
