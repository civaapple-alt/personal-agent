import { defineConfig } from "@playwright/test";
import { resolveBrowserExecutablePath } from "./fixtures/browser.ts";

export default defineConfig({
	testDir: ".",
	testMatch: /.*\.spec\.ts$/,
	grepInvert: /@live/,
	workers: 1,
	fullyParallel: false,
	retries: process.env.CI ? 1 : 0,
	timeout: 45_000,
	expect: { timeout: 10_000 },
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
});
