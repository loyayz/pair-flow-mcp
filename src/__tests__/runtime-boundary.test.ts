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
});
