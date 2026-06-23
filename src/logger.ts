import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

const LOG_DIR = process.env.STATE_DIR || ".pairflow";
const LOG_FILE = `${LOG_DIR}/pairflow.log`;
const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 5;

export type LogEvent =
  | "register" | "claim_turn" | "submit" | "create_issue" | "resolve_issue"
  | "defer_issue" | "escalate" | "force_converge" | "advance" | "timeout"
  | "crash_recovery" | "phase_change" | "blind_review";

export async function logEvent(event: LogEvent, details: Record<string, unknown> = {}): Promise<void> {
  await mkdir(dirname(LOG_FILE), { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }) + "\n";
  await appendFile(LOG_FILE, line, "utf-8");

  // Check rotation
  try {
    const s = await stat(LOG_FILE);
    if (s.size > MAX_SIZE) {
      await rotate();
    }
  } catch { /* ignore */ }
}

async function rotate(): Promise<void> {
  for (let i = MAX_FILES - 1; i >= 0; i--) {
    const old = i === 0 ? LOG_FILE : `${LOG_FILE}.${i}`;
    const next = `${LOG_FILE}.${i + 1}`;
    try {
      await rename(old, next);
    } catch { /* file doesn't exist, skip */ }
  }
}
