import type { IsomorphicHeaders } from "@modelcontextprotocol/sdk/types.js";
import { resolveSession } from "./token-map.js";

export interface ParsedSession {
  identity: string;
  workflowId: string | null;
  registered: boolean;
}

export function parseSession(headers: IsomorphicHeaders | undefined): ParsedSession {
  const raw = headers?.["x-ai-identity"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    const trimmed = raw.trim();
    const session = resolveSession(trimmed);
    if (session) return { ...session, registered: true };
    return { identity: "unknown", workflowId: null, registered: false };
  }
  return { identity: "unknown", workflowId: null, registered: false };
}

export function sanitizeIdentity(identity: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(identity)) {
    throw new Error("Invalid identity: only letters, numbers, underscores, and hyphens are allowed");
  }
  return identity;
}
