import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";

const SYSTEM_BROWSER_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

/** Resolve Chrome/Chromium executable without forcing duplicate browser downloads when system Chrome exists. */
export function resolveBrowserExecutablePath(): string {
	for (const envName of ["PA_E2E_CHROME_BIN", "CHROMIUM_BIN"] as const) {
		const candidate = process.env[envName]?.trim();
		if (candidate) {
			if (existsSync(candidate)) return candidate;
			throw new Error(`${envName} points to missing browser binary: ${candidate}`);
		}
	}

	const bundled = chromium.executablePath();
	if (bundled && existsSync(bundled)) {
		return bundled;
	}

	for (const candidate of SYSTEM_BROWSER_CANDIDATES) {
		if (existsSync(candidate)) return candidate;
	}

	throw new Error(
		"No Chromium/Chrome executable found for E2E. Install Playwright Chromium (`npx playwright install chromium`) or set PA_E2E_CHROME_BIN.",
	);
}
