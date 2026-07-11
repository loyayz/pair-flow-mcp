import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("PairFlow runtime boundary", () => {
  it("does not import command execution APIs", async () => {
    const sourceRoot = resolve("src");
    const files = (await readdir(sourceRoot, { recursive: true }))
      .filter((file) => file.endsWith(".ts") && !file.startsWith("__tests__"));
    const sources = await Promise.all(files.map((file) => readFile(resolve(sourceRoot, file), "utf-8")));

    expect(sources.join("\n")).not.toContain("node:child_process");
  });

  it("does not keep non-persistent crash-loop counters", async () => {
    const source = await readFile(resolve("src", "index.ts"), "utf-8");

    expect(source).not.toContain("crashCount");
    expect(source).not.toContain("lastCrashTime");
    expect(source).not.toContain("Crash loop detected");
  });

  it("exits immediately after an uncaught exception", async () => {
    const source = await readFile(resolve("src", "index.ts"), "utf-8");
    const handler = source.match(/process\.on\("uncaughtException"[\s\S]*?\n}\);/)?.[0];

    expect(handler).toContain("writeSync(process.stderr.fd");
    expect(handler).toContain("process.exit(1)");
    expect(handler).not.toContain("setTimeout");
  });

  it("does not advertise a startup recovery gate", async () => {
    const source = await readFile(resolve("src", "index.ts"), "utf-8");

    expect(source).not.toContain("recovery in progress");
    expect(source).not.toMatch(/\blet ready\b/);
  });
});
