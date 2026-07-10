import { describe, it, expect } from "vitest";
import { bindWorkflow, registerToken, resolveSession, unbindWorkflow } from "../token-map.js";

describe("token-map", () => {
  it("resolves token to identity", () => {
    const token = registerToken("claude");
    expect(resolveSession(token)?.identity).toBe("claude");
  });

  it("passes through unknown values", () => {
    expect(resolveSession("unknown-identity")).toBeNull();
    expect(resolveSession("")).toBeNull();
  });

  it("unbinds every token for a completed workflow", () => {
    const first = registerToken("alice");
    const second = registerToken("alice");
    const unrelated = registerToken("bob");
    bindWorkflow(first, "workflow-a");
    bindWorkflow(second, "workflow-a");
    bindWorkflow(unrelated, "workflow-b");

    unbindWorkflow("workflow-a");

    expect(resolveSession(first)?.workflowId).toBeNull();
    expect(resolveSession(second)?.workflowId).toBeNull();
    expect(resolveSession(unrelated)?.workflowId).toBe("workflow-b");
  });
});
