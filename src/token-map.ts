import { randomUUID } from "node:crypto";

export interface Session {
  identity: string;
  workflowId: string | null;
}

const tokenMap = new Map<string, Session>();

export function registerToken(identity: string): string {
  const token = randomUUID();
  tokenMap.set(token, { identity, workflowId: null });
  return token;
}

export function bindWorkflow(token: string, workflowId: string): void {
  const session = tokenMap.get(token);
  if (session) {
    session.workflowId = workflowId;
  }
}

export function unbindWorkflow(workflowId: string): void {
  for (const session of tokenMap.values()) {
    if (session.workflowId === workflowId) session.workflowId = null;
  }
}

export function resolveSession(raw: string): Session | null {
  return tokenMap.get(raw) ?? null;
}
