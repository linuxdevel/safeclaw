import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from "@safeclaw/core";
import type { PeerIdentity } from "@safeclaw/core";

export class CliAdapter implements ChannelAdapter {
  readonly id = "cli";
  readonly peer: PeerIdentity = { channelId: "cli", peerId: "local" };
  private rl: ReadlineInterface | null = null;
  private handler:
    | ((msg: InboundMessage) => Promise<OutboundMessage>)
    | null = null;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;

  constructor(
    input?: NodeJS.ReadableStream,
    output?: NodeJS.WritableStream,
  ) {
    this.input = input ?? process.stdin;
    this.output = output ?? process.stdout;
  }

  async connect(): Promise<void> {
    this.rl = createInterface({
      input: this.input,
      output: this.output,
      prompt: "> ",
    });

    this.rl.on("line", (line: string) => {
      void this.handleLine(line);
    });

    this.rl.prompt();
  }

  async disconnect(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  onMessage(
    handler: (msg: InboundMessage) => Promise<OutboundMessage>,
  ): void {
    this.handler = handler;
  }

  async send(_peer: PeerIdentity, content: OutboundMessage): Promise<void> {
    const stream = this.output as NodeJS.WritableStream & {
      write(s: string): boolean;
    };
    stream.write(`${content.content}\n`);
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      this.rl?.prompt();
      return;
    }

    if (!this.handler) {
      this.rl?.prompt();
      return;
    }

    const inbound: InboundMessage = {
      peer: this.peer,
      content: trimmed,
      timestamp: new Date(),
    };

    const response = await this.handler(inbound);
    await this.send(this.peer, response);
    this.rl?.prompt();
  }
}
