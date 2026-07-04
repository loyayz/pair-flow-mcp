import type { IsomorphicHeaders } from "@modelcontextprotocol/sdk/types.js";
import { resolveSession } from "./token-map.js";

export interface ParsedSession {
  identity: string;
  workflowId: string | null;
}

export function parseSession(headers: IsomorphicHeaders | undefined): ParsedSession {
  const raw = headers?.["x-ai-identity"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    const trimmed = raw.trim();
    const session = resolveSession(trimmed);
    if (session) return session;
    // Fallback: plaintext identity (backward compatible, no workflow bound)
    return { identity: sanitizeIdentity(trimmed), workflowId: null };
  }
  return { identity: "unknown", workflowId: null };
}

export function sanitizeIdentity(identity: string): string {
  if (/[\\/:]/.test(identity) || identity.includes("..")) {
    throw new Error(`Invalid identity: must not contain path separators or ".."`);
  }
  return identity;
}
