import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_DIR = process.env.STATE_DIR || ".pairflow";
const LOCK_FILE = `${LOCK_DIR}/lock`;

interface LockData {
  pid: number;
  started_at: string;
  nonce: string;
  crash_count: number;
  last_crash_time: string | null;
}

export async function acquireLock(): Promise<LockData> {
  await mkdir(dirname(LOCK_FILE), { recursive: true });

  const currentPid = process.pid;
  const now = new Date().toISOString();
  const nonce = randomUUID();

  // Check existing lock
  try {
    const raw = await readFile(LOCK_FILE, "utf-8");
    const existing: LockData = JSON.parse(raw);

    // Zombie check: same PID? Different PID but alive?
    if (existing.pid !== currentPid) {
      const pidAlive = isPidAlive(existing.pid);
      if (pidAlive) {
        const startedAt = new Date(existing.started_at).getTime();
        const elapsed = Date.now() - startedAt;
        if (elapsed < 5 * 60 * 1000) {
          throw new Error(`Lock held by PID ${existing.pid} (started ${existing.started_at}). Refusing to start.`);
        }
        // > 5min — zombie, overwrite
      }
    }

    // Crash loop detection
    const lastCrash = existing.last_crash_time ? new Date(existing.last_crash_time).getTime() : 0;
    if (Date.now() - lastCrash < 30_000) {
      const newCount = existing.crash_count + 1;
      if (newCount >= 3) {
        throw new Error(`Crash loop detected: ${newCount} crashes within 30s. Check environment.`);
      }
      await writeLock({ pid: currentPid, started_at: now, nonce, crash_count: newCount, last_crash_time: now });
      return { pid: currentPid, started_at: now, nonce, crash_count: newCount, last_crash_time: now };
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Lock held")) throw err;
    if (err instanceof Error && err.message.includes("Crash loop")) throw err;
    // File doesn't exist or is corrupt — fresh lock
  }

  await writeLock({ pid: currentPid, started_at: now, nonce, crash_count: 0, last_crash_time: null });
  return { pid: currentPid, started_at: now, nonce, crash_count: 0, last_crash_time: null };
}

export async function releaseLock(): Promise<void> {
  try {
    await unlink(LOCK_FILE);
  } catch { /* ignore */ }
}

async function writeLock(data: LockData): Promise<void> {
  await mkdir(dirname(LOCK_FILE), { recursive: true });
  await writeFile(LOCK_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
