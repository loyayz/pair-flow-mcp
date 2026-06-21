import type { IsomorphicHeaders } from "@modelcontextprotocol/sdk/types.js";

/**
 * 从 HTTP header 解析 AI 身份。
 * 无有效 X-AI-Identity header → "unknown"。
 */
export function parseIdentity(headers: IsomorphicHeaders | undefined): string {
  const raw = headers?.["x-ai-identity"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return "unknown";
}
