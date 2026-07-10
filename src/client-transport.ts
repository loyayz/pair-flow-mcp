/**
 * PairFlow MCP Client Transport — thin wrapper with registered token injection.
 *
 * The MCP SDK's StreamableHTTPClientTransport already supports requestInit
 * which applies to all requests (not just connect). This wrapper simplifies
 * construction for the common case of registered token injection.
 *
 * Usage:
 *   const t = createClientTransport("http://127.0.0.1:3100/mcp", token);
 *   const c = new Client({ name: "my", version: "1" }, {});
 *   await c.connect(t);
 *   // All subsequent tool calls include X-AI-Identity: <registered token>
 */
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export function createClientTransport(baseUrl: string, token: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { "X-AI-Identity": token } },
  });
}
