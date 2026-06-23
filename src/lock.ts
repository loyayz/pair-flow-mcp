import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_DIR = process.env.STATE_DIR || ".pairflow";
const LOCK_FILE = `${LOCK_DIR}/lock`;
const HEARTBEAT_INTERVAL_MS = 15_000; // 15s heartbeat interval
const HEARTBEAT_TIMEOUT_MS = 30_000;   // 30s timeout → consider zombie

interface LockData {
  pid: number;
  started_at: string;
  nonce: string;
  crash_count: number;
  last_crash_time: string | null;
  last_heartbeat: string | null; // #3: 心跳时间戳
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

async function startHeartbeat(): Promise<void> {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(async () => {
    try {
      const raw = await readFile(LOCK_FILE, "utf-8");
      const data: LockData = JSON.parse(raw);
      data.last_heartbeat = new Date().toISOString();
      await writeFile(LOCK_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch { /* lock file not found or corrupt — skip heartbeat */ }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
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

    // #3 heartbeat: check if existing holder is zombie (heartbeat timeout)
    if (existing.pid !== currentPid) {
      const pidAlive = isPidAlive(existing.pid);
      if (pidAlive) {
        // Check heartbeat — if timed out, consider zombie and overwrite
        const lastHb = existing.last_heartbeat ? new Date(existing.last_heartbeat).getTime() : 0;
        const isZombie = Date.now() - lastHb > HEARTBEAT_TIMEOUT_MS;
        if (isZombie) {
          console.log("[pair-flow] Lock holder PID", existing.pid, "heartbeat timeout — overwriting zombie lock");
          // #5: reset crash_count — zombie isn't a crash, it's an unresponsive process
          existing.crash_count = 0;
        } else {
          throw new Error(`Lock held by PID ${existing.pid} (started ${existing.started_at}). Refusing to start.`);
        }
      }
    }

    // Crash loop detection
    const lastCrash = existing.last_crash_time ? new Date(existing.last_crash_time).getTime() : 0;
    if (Date.now() - lastCrash < 30_000) {
      const newCount = existing.crash_count + 1;
      if (newCount >= 3) {
        throw new Error(`Crash loop detected: ${newCount} crashes within 30s. Check environment.`);
      }
      const lockData: LockData = { pid: currentPid, started_at: now, nonce, crash_count: newCount, last_crash_time: now, last_heartbeat: now };
      await writeLock(lockData);
      await startHeartbeat();
      return lockData;
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Lock held")) throw err;
    if (err instanceof Error && err.message.includes("Crash loop")) throw err;
    // File doesn't exist or is corrupt — fresh lock
  }

  const lockData: LockData = { pid: currentPid, started_at: now, nonce, crash_count: 0, last_crash_time: null, last_heartbeat: now };
  await writeLock(lockData);
  await startHeartbeat();
  return lockData;
}

export async function releaseLock(): Promise<void> {
  stopHeartbeat();
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
