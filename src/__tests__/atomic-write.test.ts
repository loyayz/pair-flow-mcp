import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { atomicWriteText } from "../atomic-write.js";

describe("atomicWriteText", () => {
  it("writes through a temporary file and leaves only the target file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairflow-atomic-"));
    try {
      const target = join(dir, "state.meta.json");
      await atomicWriteText(target, "first");
      await atomicWriteText(target, "second");

      expect(await readFile(target, "utf-8")).toBe("second");
      expect(await readdir(dir)).toEqual(["state.meta.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
