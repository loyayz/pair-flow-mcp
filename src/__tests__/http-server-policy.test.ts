import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { HTTP_SERVER_OPTIONS } from "../http-server-policy.js";

describe("HTTP server policy", () => {
  it("limits request receipt without setting a response timeout", () => {
    const server = createServer(HTTP_SERVER_OPTIONS);

    expect(server.headersTimeout).toBe(10_000);
    expect(server.requestTimeout).toBe(30_000);
    expect(HTTP_SERVER_OPTIONS.connectionsCheckingInterval).toBe(1_000);
    expect(server.timeout).toBe(0);
    server.close();
  });
});
