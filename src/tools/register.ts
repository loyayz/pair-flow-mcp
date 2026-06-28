import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState, saveState } from "../state.js";
import { logEvent } from "../logger.js";
import { stateMutex } from "../mutex.js";
import { err, ok } from "../response.js";
import { registerToken } from "../token-map.js";

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
  const workDir = args.work_dir as string;
  if (!workDir) {
    return err("work_dir is required — provide project root directory path");
  }

  return stateMutex.runExclusive(async () => {
    const state = await loadState();
    const now = new Date().toISOString();

    if (state.phase !== "idle") {
      return err(`register only allowed in IDLE phase, current: ${state.phase}`);
    }

    // work_dir 一致性校验（第二个 peer 注册时与第一个比对）
    if (state.peers.length === 1) {
      const firstPeer = state.peers[0];
      if (firstPeer.work_dir !== workDir) {
        return err(
          `work_dir mismatch — yours: "${workDir}", ${firstPeer.identity}'s: "${firstPeer.work_dir}". Verify same project directory.`
        );
      }
    }

    // Identity already registered
    if (state.peers.some((p) => p.identity === identity)) {
      return err(`identity "${identity}" already registered`);
    }

    // Validate role constraints: exactly one supervisor, one developer
    if (supervisor && state.peers.some((p) => p.role === "supervisor")) {
      return err("supervisor already registered");
    }
    if (developer && state.peers.some((p) => p.is_developer)) {
      return err("developer already registered");
    }

    state.peers.push({ identity, role: supervisor ? "supervisor" : "peer", is_developer: developer, registered_at: now, work_dir: workDir });
    await saveState(state);
    await logEvent("register", { identity, supervisor, developer, work_dir: workDir });

    const token = registerToken(identity);

    const prefix = `Set X-AI-Identity: ${token} header on all subsequent requests`;
    const identityInfo = `当前身份: ${identity}(${supervisor ? "supervisor" : developer ? "developer" : "reviewer"})`;
    const tip = supervisor
      ? `${prefix}。${identityInfo}。下一步调用 confirm_dir 接口，参数 work_dir="${workDir}"`
      : `${prefix}。${identityInfo}。下一步调用 wait_for_turn 接口，等待 supervisor 推进`;

    return ok({
      ok: true, identity, token, is_supervisor: supervisor, is_developer: developer,
      phase: state.phase,
    }, tip);
  });
}
