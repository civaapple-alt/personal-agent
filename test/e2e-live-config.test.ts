import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildLiveEnv, loadLiveE2eConfig, resolveLiveModelConfig } from "../e2e/live/config.ts";
import {
	enforceAllowedProvider,
	parseAllowedProviders,
	parseDemoThinkingLevel,
	resolveVerifierModelFromEnv,
} from "../packages/server/src/demo/model-selection.ts";

test("parseAllowedProviders and enforceAllowedProvider enforce fail-closed provider allowlist", () => {
	assert.equal(parseAllowedProviders(undefined), null);
	assert.equal(parseAllowedProviders(" ,  "), null);
	assert.deepEqual(parseAllowedProviders("kimi-coding, opencode-go , kimi-coding"), ["kimi-coding", "opencode-go"]);

	assert.doesNotThrow(() => enforceAllowedProvider("kimi-coding", null));
	assert.doesNotThrow(() => enforceAllowedProvider("opencode-go", ["kimi-coding", "opencode-go"]));
	assert.throws(
		() => enforceAllowedProvider("anthropic", ["kimi-coding", "opencode-go"]),
		/blocked by cost allowlist \[kimi-coding, opencode-go\]/,
	);
});

test("parseDemoThinkingLevel and resolveVerifierModelFromEnv validate paired verifier & allowlist", () => {
	assert.equal(parseDemoThinkingLevel(undefined), undefined);
	assert.equal(parseDemoThinkingLevel("off"), "off");
	assert.throws(() => parseDemoThinkingLevel("ultra"), /Invalid thinking level/);

	assert.deepEqual(resolveVerifierModelFromEnv({}, {}), {});
	assert.deepEqual(
		resolveVerifierModelFromEnv(
			{},
			{
				PA_E2E_VERIFIER_PROVIDER: "opencode-go",
				PA_E2E_VERIFIER_MODEL: "deepseek-v4.1-flash",
				PA_E2E_ALLOWED_PROVIDERS: "kimi-coding,opencode-go",
			},
		),
		{ verifierProvider: "opencode-go", verifierModel: "deepseek-v4.1-flash" },
	);
	assert.throws(
		() => resolveVerifierModelFromEnv({}, { PA_E2E_VERIFIER_PROVIDER: "opencode-go" }),
		/Configure both verifier provider and verifier model/,
	);
	assert.throws(
		() =>
			resolveVerifierModelFromEnv(
				{},
				{
					PA_E2E_VERIFIER_PROVIDER: "openai",
					PA_E2E_VERIFIER_MODEL: "gpt-5",
					PA_E2E_ALLOWED_PROVIDERS: "kimi-coding,opencode-go",
				},
			),
		/blocked by cost allowlist/,
	);
});

test("resolveLiveModelConfig follows CLI > env > profile precedence and blocks disallowed providers", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-live-cfg-"));
	try {
		const configFile = join(dir, "live.config.json");
		writeFileSync(
			configFile,
			JSON.stringify({
				defaultProfile: "smoke",
				allowedProviders: ["kimi-coding", "opencode-go"],
				profiles: {
					smoke: {
						provider: "kimi-coding",
						model: "kimi-for-coding-highspeed",
						thinkingLevel: "minimal",
					},
					"cross-verify": {
						provider: "kimi-coding",
						model: "kimi-for-coding-highspeed",
						thinkingLevel: "low",
						verifier: { provider: "opencode-go", model: "deepseek-v4.1-flash" },
					},
				},
			}),
			"utf8",
		);

		const loaded = loadLiveE2eConfig(dir, configFile);
		assert.ok(loaded);
		assert.equal(loaded.config.defaultProfile, "smoke");

		// 1. Uses defaultProfile ("smoke")
		const fromDefault = resolveLiveModelConfig({ rootDir: dir, configPath: configFile, env: {} });
		assert.equal(fromDefault.profileName, "smoke");
		assert.equal(fromDefault.provider, "kimi-coding");
		assert.equal(fromDefault.model, "kimi-for-coding-highspeed");
		assert.equal(fromDefault.thinkingLevel, "minimal");
		assert.deepEqual(fromDefault.allowedProviders, ["kimi-coding", "opencode-go"]);

		// 2. Named profile via PA_E2E_PROFILE, overridden by env model and then CLI
		const fromEnv = resolveLiveModelConfig({
			rootDir: dir,
			configPath: configFile,
			env: {
				PA_E2E_PROFILE: "cross-verify",
				PA_E2E_PROVIDER: "opencode-go",
				PA_E2E_MODEL: "glm-5.3-flash",
				PA_E2E_THINKING: "minimal",
			},
		});
		assert.equal(fromEnv.profileName, "cross-verify");
		assert.equal(fromEnv.provider, "opencode-go");
		assert.equal(fromEnv.model, "glm-5.3-flash");
		assert.equal(fromEnv.thinkingLevel, "minimal");
		assert.equal(fromEnv.verifierProvider, "opencode-go");
		assert.equal(fromEnv.verifierModel, "deepseek-v4.1-flash");

		const fromCli = resolveLiveModelConfig({
			rootDir: dir,
			configPath: configFile,
			profile: "cross-verify",
			provider: "kimi-coding",
			model: "k3.1-pro-highspeed",
			thinkingLevel: "off",
			env: {
				PA_E2E_PROVIDER: "opencode-go",
				PA_E2E_MODEL: "glm-5.3-flash",
			},
		});
		assert.equal(fromCli.provider, "kimi-coding");
		assert.equal(fromCli.model, "k3.1-pro-highspeed");
		assert.equal(fromCli.thinkingLevel, "off");

		const childEnv = buildLiveEnv({}, fromCli);
		assert.equal(childEnv.PA_E2E_PROVIDER, "kimi-coding");
		assert.equal(childEnv.PA_E2E_MODEL, "k3.1-pro-highspeed");
		assert.equal(childEnv.PA_E2E_THINKING, "off");
		assert.equal(childEnv.PA_E2E_VERIFIER_PROVIDER, "opencode-go");
		assert.equal(childEnv.PA_E2E_VERIFIER_MODEL, "deepseek-v4.1-flash");
		assert.equal(childEnv.PA_E2E_ALLOWED_PROVIDERS, "kimi-coding,opencode-go");

		// 3. Rejects unapproved providers cleanly before running anything
		assert.throws(
			() =>
				resolveLiveModelConfig({
					rootDir: dir,
					configPath: configFile,
					provider: "anthropic",
					model: "claude-sonnet-4",
					env: {},
				}),
			/blocked by cost allowlist/,
		);
		assert.throws(
			() =>
				resolveLiveModelConfig({
					rootDir: dir,
					configPath: configFile,
					verifierProvider: "anthropic",
					verifierModel: "claude-sonnet-4",
					env: {},
				}),
			/Verifier provider "anthropic" is blocked by cost allowlist/,
		);
		assert.throws(
			() => resolveLiveModelConfig({ rootDir: dir, configPath: configFile, profile: "missing", env: {} }),
			/profile "missing" not found/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
