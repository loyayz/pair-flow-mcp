import type { ServerOptions } from "node:http";

export const HTTP_SERVER_OPTIONS: ServerOptions = {
  headersTimeout: 10_000,
  requestTimeout: 30_000,
  connectionsCheckingInterval: 1_000,
};
