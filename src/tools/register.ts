import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState, saveState } from "../state.js";
import { logEvent } from "../logger.js";
import { stateMutex } from "../mutex.js";
import { err, ok } from "../response.js";

export async function register(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") {
    return err("identity required — set X-AI-Identity header");
  }

  const supervisor = args.supervisor === true;
  const developer = args.developer === true;
  const workDir = (args.work_dir as string) ?? ""; // P0-28: work_dir 参数

  return stateMutex.runExclusive(async () => {
    const state = await loadState();
    const now = new Date().toISOString();

    // Validate phase — allow re-registration in any phase after crash recovery
    if (state.phase !== "idle" && !state.require_re_register) {
      return err(`register only allowed in IDLE phase, current: ${state.phase}`);
    }

    // Crash recovery re-registration: idempotent update (retro-2 §4.2)
    if (state.require_re_register) {
      const recoveredPeer = state.peers.find((p) => p.identity === identity);
      if (!recoveredPeer) {
        return err(`identity "${identity}" not found in recovered peers — recovered identities: ${state.peers.map(p => p.identity).join(", ")}`);
      }
      // Idempotent update: refresh registered_at to confirm online presence
      recoveredPeer.registered_at = now;
      if (workDir) recoveredPeer.work_dir = workDir;
      // Check all peers re-registered: each peer's registered_at must be >= the first re-register's time
      const allReRegistered = state.peers.every((p) => {
        const t = new Date(p.registered_at).getTime();
        const nowMs = Date.now();
        return (nowMs - t) < 60_000; // registered within last 60 seconds
      });
      if (allReRegistered) {
        state.require_re_register = false;
      }
      await saveState(state);
      await logEvent("register", { identity, supervisor, developer, re_register: true, all_re_registered: !state.require_re_register });
      return ok({ ok: true, identity, role: recoveredPeer.role, is_developer: recoveredPeer.is_developer, re_register: true, all_re_registered: !state.require_re_register },
        { tool: "wait_for_turn", when: "已重新确认在线状态，等待推进" });
    }

    // P0-28: 校验 work_dir（第二个 peer 注册时）
    if (workDir && state.peers.length === 1) {
      const firstPeer = state.peers[0];
      if (firstPeer.work_dir && firstPeer.work_dir !== workDir) {
        return err(
          `work_dir mismatch — yours: "${workDir}", ${firstPeer.identity}'s: "${firstPeer.work_dir}". Verify same git repository.`
        );
      }
    }

    // Check for existing registration
    const existing = state.peers.find((p) => p.identity === identity);
    const overwritten = existing !== undefined;
    if (overwritten) {
      // Validate supervisor uniqueness on re-registration
      if (supervisor) {
        const existingSupervisor = state.peers.find((p) => p.role === "supervisor" && p.identity !== identity);
        if (existingSupervisor) {
          return err(`supervisor already registered: ${existingSupervisor.identity}`);
        }
      }
      const warning = `previous connection had in-flight operation, completed before override`;
      // Remove old, add new
      state.peers = state.peers.filter((p) => p.identity !== identity);
      state.peers.push({ identity, role: supervisor ? "supervisor" : "peer", is_developer: developer, registered_at: now, work_dir: workDir || existing.work_dir });
      await saveState(state);
      await logEvent("register", { identity, supervisor, developer, work_dir: workDir, overwritten: true });
      return ok({ ok: true, identity, role: supervisor ? "supervisor" : "peer", is_developer: developer, warning, recovered: state.recovered || undefined },
        { tool: "wait_for_turn", when: "已重新注册，等待推进" });
    }

    // Validate role constraints
    if (supervisor) {
      const existingSupervisor = state.peers.find((p) => p.role === "supervisor");
      if (existingSupervisor) {
        return err(`supervisor already registered: ${existingSupervisor.identity}`);
      }
    }

    state.peers.push({ identity, role: supervisor ? "supervisor" : "peer", is_developer: developer, registered_at: now, work_dir: workDir || undefined });
    await saveState(state);
    await logEvent("register", { identity, supervisor, developer, work_dir: workDir });

    const bothRegistered = state.peers.length >= 2;
    return ok({ ok: true, identity, role: supervisor ? "supervisor" : "peer", is_developer: developer, recovered: state.recovered || undefined },
      { tool: "wait_for_turn", when: bothRegistered ? "双方已注册，等待 supervisor advance" : "等待对方注册" });
  });
}
