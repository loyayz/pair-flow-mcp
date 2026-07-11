import type { IsomorphicHeaders } from "@modelcontextprotocol/sdk/types.js";
import { resolveSession } from "./token-map.js";

const IDENTITY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const RESERVED_IDENTITIES = new Set(["unknown", "idle"]);

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
  if (typeof identity !== "string" || !IDENTITY_PATTERN.test(identity)) {
    throw new Error("Invalid identity: use 1 to 64 letters, numbers, underscores, or hyphens");
  }
  if (RESERVED_IDENTITIES.has(identity.toLowerCase())) {
    throw new Error('Invalid identity: "unknown" and "idle" are reserved');
  }
  return identity;
}

export function isValidIdentity(identity: string): boolean {
  return IDENTITY_PATTERN.test(identity) && !RESERVED_IDENTITIES.has(identity.toLowerCase());
}
