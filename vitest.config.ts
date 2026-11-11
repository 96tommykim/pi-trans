import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { environment: "node", pool: "forks", testTimeout: 5_000, hookTimeout: 30_000 },
});
