import { describe, expect, it, vi } from "vitest";
import { sendDiagnosticReply } from "../diagnostic-ipc.js";

describe("diagnostic IPC replies", () => {
  it("skips a disconnected channel and consumes a close race through the send callback", async () => {
    const channelClosed = Object.assign(new Error("channel closed"), {
      code: "ERR_IPC_CHANNEL_CLOSED",
    });
    const send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => {
      if (!callback) throw channelClosed;
      callback(channelClosed);
      return false;
    });
    const channel: Pick<NodeJS.Process, "connected" | "send"> = {
      connected: false,
      send: send as NodeJS.Process["send"],
    };
    const message = {
      type: "pairflow:workflow-waiter-count",
      requestId: 1,
      workflowId: "20260716000001",
      count: 0,
    };

    expect(() => sendDiagnosticReply(channel, message)).not.toThrow();
    expect(send).not.toHaveBeenCalled();

    channel.connected = true;

    expect(() => sendDiagnosticReply(channel, message)).not.toThrow();
    expect(send).toHaveBeenCalledWith(message, expect.any(Function));
  });
});
