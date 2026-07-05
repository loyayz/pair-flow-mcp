import { describe, it, expect } from "vitest";
import { registerToken, resolveSession } from "../token-map.js";

describe("token-map", () => {
  it("resolves token to identity", () => {
    const token = registerToken("claude");
    expect(resolveSession(token)?.identity).toBe("claude");
  });

  it("passes through unknown values", () => {
    expect(resolveSession("unknown-identity")).toBeNull();
    expect(resolveSession("")).toBeNull();
  });
});
