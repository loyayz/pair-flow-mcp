import { describe, expect, it } from "vitest";
import { describeListenError, parseServerArgs } from "../server-config.js";

describe("server CLI configuration", () => {
  it("uses port 35690 by default", () => {
    expect(parseServerArgs([])).toEqual({ port: 35690, help: false });
  });

  it("accepts a port argument", () => {
    expect(parseServerArgs(["--port", "3200"])).toEqual({ port: 3200, help: false });
    expect(parseServerArgs(["--port=3201"])).toEqual({ port: 3201, help: false });
  });

  it.each(["0", "65536", "35690abc", "1.5", "-1", ""])(
    "rejects invalid port %j",
    (port) => {
      expect(() => parseServerArgs(["--port", port])).toThrow(
        "--port must be an integer between 1 and 65535",
      );
    },
  );

  it("rejects a missing port value", () => {
    expect(() => parseServerArgs(["--port"])).toThrow(
      "--port must be an integer between 1 and 65535",
    );
  });

  it("preserves parseArgs errors for unknown options", () => {
    expect(() => parseServerArgs(["--port", "3200", "--unknown"])).toThrow(
      "Unknown option '--unknown'",
    );
  });

  it("recognizes help without requiring a port", () => {
    expect(parseServerArgs(["--help"])).toEqual({ port: 35690, help: true });
  });
});

describe("server listen errors", () => {
  it("explains address conflicts", () => {
    expect(describeListenError({ code: "EADDRINUSE" }, 35690)).toBe(
      "port 35690 is already in use; stop the existing server or choose another port with --port",
    );
  });

  it("explains permission failures", () => {
    expect(describeListenError({ code: "EACCES" }, 80)).toBe(
      "permission denied while binding port 80; choose an allowed port with --port",
    );
  });

  it("leaves unrelated errors to crash handling", () => {
    expect(describeListenError({ code: "EIO" }, 35690)).toBeNull();
  });
});
