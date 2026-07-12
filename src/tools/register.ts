import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { sanitizeIdentity } from "../identity.js";
import { err, ok } from "../response.js";
import { registerToken } from "../token-map.js";
import { renderTip } from "../tip-template.js";

function registerCurl(mcpUrl: string): string {
  return `curl -s -X POST ${mcpUrl} \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register","arguments":{"identity":"<你的身份名>"}}}'

- identity: 你的身份名称，如 "claude"。长度 1–64，只能包含字母、数字、下划线、连字符；服务端统一转为小写；unknown 和 idle 为保留字`;
}

function badParam(paramName: string, reason: "缺失" | "非法", mcpUrl: string): string {
  return `${paramName} 参数${reason}。正确格式参考（尖括号内为变量）：

${registerCurl(mcpUrl)}`;
}

export async function register(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const mcpUrl = extra.requestInfo?.url
    ? `${extra.requestInfo.url.origin}/mcp`
    : "http://127.0.0.1:35690/mcp";
  const rawIdentity = args.identity as string;
  if (!rawIdentity) return err(badParam("identity", "缺失", mcpUrl));

  let identity: string;
  try { identity = sanitizeIdentity(rawIdentity); } catch { return err(badParam("identity", "非法", mcpUrl)); }

  const token = registerToken(identity);

  const tip = renderTip("register.success", { token, identity });

  return ok({ ok: true, identity, token }, tip);
}
