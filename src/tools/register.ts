import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { sanitizeIdentity } from "../identity.js";
import { err, ok } from "../response.js";
import { registerToken } from "../token-map.js";

const REGISTER_CURL = `curl -s -X POST http://localhost:3100/mcp \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register","arguments":{"identity":"<你的身份名>"}}}'

- identity: 你的身份名称，如 "claude"。只能包含字母、数字、下划线、连字符`;

function badParam(paramName: string, reason: "缺失" | "非法"): string {
  return `${paramName} 参数${reason}。正确格式参考（尖括号内为变量）：

${REGISTER_CURL}`;
}

export async function register(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = args.identity as string;
  if (!identity) return err(badParam("identity", "缺失"));

  try { sanitizeIdentity(identity); } catch { return err(badParam("identity", "非法")); }

  const token = registerToken(identity);

  const tip = `Set X-AI-Identity: ${token} header on all subsequent requests。你已注册。
询问用户以下信息后调用 confirm_task({...})。两个 AI 使用相同的 task_path 自动成对，
服务端校验角色组合规则和 work_dir 一致性。

confirm_task 入参：

task_path   — 任务文档绝对路径，不得包含 . 或 .. 路径段。两个 AI 必须传相同规范化路径才能成对。
task_type   — 任务类型。"development"（开发）走完整四阶段流程；
              "requirements"（需求）只做需求分析+汇总，跳过 planning 和 implementation。
supervisor  — 是否为监督者（true/false）。双方就位后必须恰好一个监督者。
developer   — 是否为开发者（true/false）。双方就位后必须恰好一个开发者，可与监督者为同一参与者。
work_dir    — 项目根目录绝对路径，不得包含 . 或 .. 路径段。两个 AI 必须一致。`;

  return ok({ ok: true, identity, token }, tip);
}
