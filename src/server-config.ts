import { parseArgs } from "node:util";

const INVALID_PORT_MESSAGE = "--port must be an integer between 1 and 65535";
const DEFAULT_PORT = 35690;

export const SERVER_HELP = `Usage: npx tsx src/index.ts [--port <port>]

Options:
  --port <port>  Listen port from 1 to 65535 (default: ${DEFAULT_PORT})
  --help         Show this help message`;

export interface ServerArgs {
  port: number;
  help: boolean;
}

export function parseServerArgs(args: string[]): ServerArgs {
  let rawPort: string | undefined;
  let help = false;
  try {
    const { values } = parseArgs({
      args,
      options: {
        port: { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    });
    rawPort = values.port;
    help = values.help ?? false;
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      throw new Error(INVALID_PORT_MESSAGE);
    }
    throw error;
  }

  if (help) return { port: DEFAULT_PORT, help: true };
  if (rawPort === undefined) return { port: DEFAULT_PORT, help: false };
  if (!/^\d+$/.test(rawPort)) throw new Error(INVALID_PORT_MESSAGE);

  const port = Number(rawPort);
  if (port < 1 || port > 65_535) throw new Error(INVALID_PORT_MESSAGE);
  return { port, help: false };
}

export function describeListenError(error: { code?: string }, port: number): string | null {
  if (error.code === "EADDRINUSE") {
    return `port ${port} is already in use; stop the existing server or choose another port with --port`;
  }
  if (error.code === "EACCES") {
    return `permission denied while binding port ${port}; choose an allowed port with --port`;
  }
  return null;
}
