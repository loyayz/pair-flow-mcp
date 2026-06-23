import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      STATE_DIR: ".pairflow-test-vitest",
      HANDOFF_DIR: ".handoff-test-vitest",
    },
  },
});
