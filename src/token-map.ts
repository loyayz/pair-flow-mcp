import { randomUUID } from "node:crypto";

/**
 * Process-level token → identity mapping.
 * Tokens expire on process restart — crash recovery re-registers.
 */
const tokenMap = new Map<string, string>();

/** Generate a UUID token and map it to the given identity. Returns the token. */
export function registerToken(identity: string): string {
  const token = randomUUID();
  tokenMap.set(token, identity);
  return token;
}

/**
 * Resolve a raw X-AI-Identity header value.
 * If the value is a known token, return the mapped identity.
 * Otherwise return the value unchanged (backward compatible with plaintext
 * identity headers).
 */
export function resolve(raw: string): string {
  return tokenMap.get(raw) ?? raw;
}
