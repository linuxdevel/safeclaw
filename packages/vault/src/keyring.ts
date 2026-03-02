import { execFileSync } from "node:child_process";

/**
 * OS keyring provider using `secret-tool` (GNOME Keyring / libsecret).
 */
export class KeyringProvider {
  private readonly appName: string;

  constructor(appName: string = "safeclaw") {
    this.appName = appName;
  }

  /**
   * Store a master key in the OS keyring.
   */
  store(key: Buffer): void {
    execFileSync(
      "secret-tool",
      [
        "store",
        "--label",
        `${this.appName} master key`,
        "application",
        this.appName,
        "type",
        "master-key",
      ],
      {
        input: key.toString("base64"),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  }

  /**
   * Retrieve the master key from the OS keyring.
   * Returns null if no entry is found or the keyring is unavailable.
   */
  retrieve(): Buffer | null {
    try {
      const output = execFileSync(
        "secret-tool",
        ["lookup", "application", this.appName, "type", "master-key"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const base64 = output.toString("utf8").trim();
      if (!base64) {
        return null;
      }
      return Buffer.from(base64, "base64");
    } catch {
      return null;
    }
  }
}
