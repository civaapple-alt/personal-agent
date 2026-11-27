import { defineConfig } from "@playwright/test";
import { resolveBrowserExecutablePath } from "./fixtures/browser.ts";

export default defineConfig({
	testDir: ".",
	workers: 1,
	fullyParallel: false,
	retries: process.env.CI ? 1 : 0,
	reporter: [["list"], ["html", { open: "never", outputFolder: "../playwright-report" }]],
	use: {
		headless: true,
		viewport: { width: 1440, height: 900 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		launchOptions: {
			executablePath: resolveBrowserExecutablePath(),
		},
	},
	projects: [
		{
			name: "no-agent",
			testMatch: /.*\.spec\.ts$/,
			grepInvert: /@live/,
			timeout: 45_000,
			expect: { timeout: 10_000 },
		},
		{
			name: "live",
			testMatch: /.*\.live\.spec\.ts$/,
			grep: /@live/,
			timeout: 360_000,
			expect: { timeout: 15_000 },
		},
	],
});
