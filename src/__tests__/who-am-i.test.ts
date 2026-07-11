import { describe, it, expect } from "vitest";
import { parseSession, sanitizeIdentity } from "../identity.js";
import { registerToken } from "../token-map.js";

describe("parseSession", () => {
  it("returns unknown for undefined headers", () => {
    expect(parseSession(undefined).identity).toBe("unknown");
  });

  it("returns unknown for empty headers", () => {
    expect(parseSession({}).identity).toBe("unknown");
  });

  it("returns unknown when x-ai-identity header is missing", () => {
    expect(parseSession({ "content-type": "application/json" }).identity).toBe("unknown");
  });

  it("returns unknown for non-token x-ai-identity header", () => {
    const s = parseSession({ "x-ai-identity": "test-ai" });
    expect(s.identity).toBe("unknown");
    expect(s.workflowId).toBeNull();
    expect(s.registered).toBe(false);
  });

  it("marks token-backed sessions as registered", () => {
    const token = registerToken("registered-ai");
    const s = parseSession({ "x-ai-identity": token });
    expect(s.identity).toBe("registered-ai");
    expect(s.workflowId).toBeNull();
    expect(s.registered).toBe(true);
  });

  it("trims whitespace from identity", () => {
    expect(parseSession({ "x-ai-identity": "  claude-fable  " }).identity).toBe("unknown");
  });

  it("returns unknown when x-ai-identity is empty string", () => {
    expect(parseSession({ "x-ai-identity": "" }).identity).toBe("unknown");
  });

  it("returns unknown when x-ai-identity is whitespace only", () => {
    expect(parseSession({ "x-ai-identity": "   " }).identity).toBe("unknown");
  });
});

describe("sanitizeIdentity", () => {
  it("passes valid identities", () => {
    expect(sanitizeIdentity("claude-fable")).toBe("claude-fable");
    expect(sanitizeIdentity("codebuddy_123")).toBe("codebuddy_123");
    expect(sanitizeIdentity("Claude_Fable")).toBe("claude_fable");
  });

  it("rejects path separators", () => {
    expect(() => sanitizeIdentity("../etc")).toThrow("Invalid identity");
    expect(() => sanitizeIdentity("a/b")).toThrow("Invalid identity");
    expect(() => sanitizeIdentity("a\\b")).toThrow("Invalid identity");
    expect(() => sanitizeIdentity("a:b")).toThrow("Invalid identity");
  });

  it("rejects whitespace and punctuation", () => {
    expect(() => sanitizeIdentity("bad identity")).toThrow("Invalid identity");
    expect(() => sanitizeIdentity("bad.identity")).toThrow("Invalid identity");
    expect(() => sanitizeIdentity("bad@identity")).toThrow("Invalid identity");
  });

  it("limits identity to 64 characters", () => {
    const longestValidIdentity = "a".repeat(64);

    expect(sanitizeIdentity(longestValidIdentity)).toBe(longestValidIdentity);
    expect(() => sanitizeIdentity("a".repeat(65))).toThrow("Invalid identity");
  });

  it("rejects reserved identity values case-insensitively", () => {
    for (const identity of ["unknown", "UNKNOWN", "idle", "Idle"]) {
      expect(() => sanitizeIdentity(identity)).toThrow("reserved");
    }
  });

  it("rejects non-string identities at runtime", () => {
    expect(() => sanitizeIdentity(123 as unknown as string)).toThrow("Invalid identity");
  });
});
