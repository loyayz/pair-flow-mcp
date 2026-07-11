import { describe, expect, it, vi } from "vitest";
import { runWithTransportCleanup } from "../transport-lifecycle.js";

describe("MCP transport lifecycle", () => {
  it("closes the transport when request handling fails", async () => {
    const failure = new Error("request failed");
    const transport = { close: vi.fn().mockResolvedValue(undefined) };

    await expect(runWithTransportCleanup(transport, async () => {
      throw failure;
    })).rejects.toBe(failure);
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("closes the transport after successful request handling", async () => {
    const transport = { close: vi.fn().mockResolvedValue(undefined) };

    await expect(runWithTransportCleanup(transport, async () => "done")).resolves.toBe("done");
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("preserves the request error when cleanup also fails", async () => {
    const requestFailure = new Error("request failed");
    const transport = { close: vi.fn().mockRejectedValue(new Error("close failed")) };

    await expect(runWithTransportCleanup(transport, async () => {
      throw requestFailure;
    })).rejects.toBe(requestFailure);
  });
});
