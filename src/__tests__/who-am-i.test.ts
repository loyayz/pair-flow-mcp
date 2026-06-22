import { describe, it, expect } from "vitest";
import { parseIdentity, sanitizeIdentity } from "../identity.js";

describe("parseIdentity", () => {
  it("returns 'unknown' for undefined headers", () => {
    expect(parseIdentity(undefined)).toBe("unknown");
  });

  it("returns 'unknown' for empty headers", () => {
    expect(parseIdentity({})).toBe("unknown");
  });

  it("returns 'unknown' when x-ai-identity header is missing", () => {
    expect(parseIdentity({ "content-type": "application/json" })).toBe("unknown");
  });

  it("parses x-ai-identity header (lowercase)", () => {
    expect(parseIdentity({ "x-ai-identity": "test-ai" })).toBe("test-ai");
  });

  it("trims whitespace from identity", () => {
    expect(parseIdentity({ "x-ai-identity": "  claude-fable  " })).toBe("claude-fable");
  });

  it("returns 'unknown' when x-ai-identity is empty string", () => {
    expect(parseIdentity({ "x-ai-identity": "" })).toBe("unknown");
  });

  it("returns 'unknown' when x-ai-identity is whitespace only", () => {
    expect(parseIdentity({ "x-ai-identity": "   " })).toBe("unknown");
  });
});

describe("sanitizeIdentity", () => {
  it("passes valid identities", () => {
    expect(sanitizeIdentity("claude-fable")).toBe("claude-fable");
    expect(sanitizeIdentity("codebuddy_123")).toBe("codebuddy_123");
  });

  it("rejects path separators", () => {
    expect(() => sanitizeIdentity("../etc")).toThrow("Invalid identity");
    expect(() => sanitizeIdentity("a/b")).toThrow("Invalid identity");
    expect(() => sanitizeIdentity("a\\b")).toThrow("Invalid identity");
    expect(() => sanitizeIdentity("a:b")).toThrow("Invalid identity");
  });
});
