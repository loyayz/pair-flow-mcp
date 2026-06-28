import type { IsomorphicHeaders } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "./token-map.js";

/**
 * 从 HTTP header 解析 AI 身份。
 * 无有效 X-AI-Identity header → "unknown"。
 * Token 值会被解析为注册时对应的身份名。
 */
export function parseIdentity(headers: IsomorphicHeaders | undefined): string {
  const raw = headers?.["x-ai-identity"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return resolve(sanitizeIdentity(raw.trim()));
  }
  return "unknown";
}

/**
 * Sanitize identity for safe use in filenames.
 * Rejects path separators and ".." to prevent path traversal.
 */
export function sanitizeIdentity(identity: string): string {
  if (/[\\/:]/.test(identity) || identity.includes("..")) {
    throw new Error(`Invalid identity: must not contain path separators or ".."`);
  }
  return identity;
}
