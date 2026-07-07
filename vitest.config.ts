import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			exclude: ["src/index.ts"],
			thresholds: {
				statements: 85,
				branches: 85,
				functions: 85,
				lines: 85,
			},
		},
	},
});
