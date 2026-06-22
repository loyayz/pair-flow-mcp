/**
 * PairFlow MCP Client Transport — thin wrapper with identity injection.
 *
 * The MCP SDK's StreamableHTTPClientTransport already supports requestInit
 * which applies to all requests (not just connect). This wrapper simplifies
 * construction for the common case of X-AI-Identity header injection.
 *
 * Usage:
 *   const t = new PairFlowClientTransport("http://localhost:3100/mcp", "my-identity");
 *   const c = new Client({ name: "my", version: "1" }, {});
 *   await c.connect(t);
 *   // All subsequent tool calls include X-AI-Identity: my-identity
 */
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export function createClientTransport(baseUrl: string, identity: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { "X-AI-Identity": identity } },
  });
}
