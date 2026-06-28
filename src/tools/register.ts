import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { sanitizeIdentity } from "../identity.js";
import { loadState, saveState } from "../state.js";
import { logEvent } from "../logger.js";
import { stateMutex } from "../mutex.js";
import { err, ok } from "../response.js";
import { registerToken } from "../token-map.js";

const REGISTER_CURL = `curl -s -X POST http://localhost:3100/mcp \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register","arguments":{"identity":"<你的身份名>","supervisor":<true|false>,"developer":<true|false>,"work_dir":"<项目根目录绝对路径>"}}}'

- identity: 你的身份名称，如 "claude"。只能包含字母、数字、下划线、连字符
- supervisor: 是否为监督者，true 或 false。两个 AI 中只能有一个监督者
- developer: 是否为开发者，true 或 false。两个 AI 中只能有一个开发者
- work_dir: 项目根目录绝对路径，两个 AI 必须相同`;

function badParam(paramName: string, reason: "缺失" | "非法"): string {
  return `${paramName} 参数${reason}。正确格式参考（尖括号内为变量）：

${REGISTER_CURL}`;
}

export async function register(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  // identity 从 body 取，不再从 header 取
  const identity = args.identity as string;
  if (!identity) {
    return err(badParam("identity", "缺失"));
  }

  try {
    sanitizeIdentity(identity);
  } catch {
    return err(badParam("identity", "非法"));
  }

  const supervisor = args.supervisor === true;
  const developer = args.developer === true;
  const workDir = args.work_dir as string;
  if (!workDir) {
    return err(badParam("work_dir", "缺失"));
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
    const pairingNote = `结对编程由两个独立 AI 各自在一个 session 中注册。你只需注册自己的身份，不要在同一 session 注册对方身份——你不是对方，也不能代替对方操作`;
    const tip = supervisor
      ? `${prefix}。${identityInfo}。${pairingNote}。下一步调用 confirm_dir 接口，参数 work_dir="${workDir}"`
      : `${prefix}。${identityInfo}。${pairingNote}。下一步调用 wait_for_turn 接口，等待 supervisor 推进`;

    return ok({
      ok: true, identity, token, is_supervisor: supervisor, is_developer: developer,
      phase: state.phase,
    }, tip);
  });
}
