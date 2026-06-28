import { describe, it, expect } from "vitest";
import { registerToken, resolve } from "../token-map.js";

describe("token-map", () => {
  it("resolves token to identity", () => {
    const token = registerToken("claude");
    expect(resolve(token)).toBe("claude");
  });

  it("passes through unknown values", () => {
    expect(resolve("unknown-identity")).toBe("unknown-identity");
    expect(resolve("")).toBe("");
  });
});
