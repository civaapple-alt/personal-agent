import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const checker = resolve("scripts/check-open-source.mjs");
const policy = pathToFileURL(resolve("scripts/release-policy.mjs")).href;

function git(root: string, args: string[]) {
	const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "Fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		},
	});
	assert.equal(result.status, 0, result.stderr);
}

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pa-open-source-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const pkg = { name: "license-fixture", version: "0.6.0", license: "MIT", private: true };
	await writeFile(join(root, "package.json"), JSON.stringify(pkg));
	await writeFile(join(root, "package-lock.json"), JSON.stringify({ version: pkg.version, packages: { "": pkg } }));
	for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
		await writeFile(join(root, name), await readFile(resolve(name)));
	git(root, ["init", "--quiet"]);
	git(root, ["add", "."]);
	git(root, ["commit", "--quiet", "-m", "Create controlled license fixture"]);
	return root;
}

test("release path policy protects nested credentials, databases and generated directories while allowing env examples", () => {
	const paths = [
		".data/agent.db",
		".notes/prototypes/README.md",
		"config/.env.production",
		".npmrc",
		"keys/id_rsa",
		"agent.sqlite3",
		"agent.db-wal",
		"dist/server.js",
		"apps/web/dist/assets/app.js",
		".env.example",
		"config/.env.local.example",
		"apps/cli/src/main.ts",
	];
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import {forbiddenReleasePath} from ${JSON.stringify(policy)}; console.log(JSON.stringify(process.argv.slice(1).map(forbiddenReleasePath)));`,
			...paths,
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), [
		true,
		true,
		true,
		true,
		true,
		true,
		true,
		true,
		true,
		false,
		false,
		false,
	]);
});

test("current snapshot checks reject tracked credentials and public scope flags unresolved images", async (t) => {
	const root = await fixture(t);
	const run = (...args: string[]) => spawnSync(process.execPath, [checker, ...args], { cwd: root, encoding: "utf8" });
	assert.equal(run().status, 0);
	await writeFile(join(root, ".env.production"), "EXAMPLE=not-a-secret\n");
	git(root, ["add", ".env.production"]);
	const credential = run();
	assert.equal(credential.status, 1);
	assert.match(credential.stdout, /private-or-generated-path/);
	await rm(join(root, ".env.production"));
	git(root, ["add", "-A"]);
	await mkdir(join(root, "docs/references/grok-bot"), { recursive: true });
	await writeFile(join(root, "docs/references/grok-bot/example.webp"), "Controlled image placeholder");
	git(root, ["add", "."]);
	assert.equal(run().status, 0);
	const publicRun = run("--public");
	assert.equal(publicRun.status, 1);
	assert.match(publicRun.stdout, /example.webp/);
});

test("history audit detects removed credential material without exposing its value", async (t) => {
	const root = await fixture(t);
	const token = ["sk", "a".repeat(40)].join("-");
	await writeFile(join(root, "removed.txt"), token);
	git(root, ["add", "."]);
	git(root, ["commit", "--quiet", "-m", "Add controlled historical material"]);
	await rm(join(root, "removed.txt"));
	git(root, ["add", "-A"]);
	git(root, ["commit", "--quiet", "-m", "Remove controlled material"]);
	const current = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
	assert.equal(current.status, 0);
	const history = spawnSync(process.execPath, [checker, "--history"], { cwd: root, encoding: "utf8" });
	assert.equal(history.status, 1);
	assert.match(history.stdout, /openai-style-key/);
	assert.match(history.stdout, /"scope": "history"/);
	assert.ok(!history.stdout.includes(token));
	assert.ok(!history.stderr.includes(token));
});

test("audit rejects license/version drift and help needs no repository or model", async (t) => {
	const root = await fixture(t);
	await writeFile(
		join(root, "package-lock.json"),
		JSON.stringify({ version: "9.9.9", packages: { "": { version: "9.9.9", license: "MIT" } } }),
	);
	assert.equal(spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" }).status, 1);
	const help = spawnSync(process.execPath, [checker, "--help"], { cwd: tmpdir(), encoding: "utf8" });
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /No model, network/);
});

test("Git exports omit unconfirmed reference images while preserving original prototypes and local history", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, ".gitattributes"), await readFile(resolve(".gitattributes")));
	await mkdir(join(root, "docs/references/grok-bot"), { recursive: true });
	await mkdir(join(root, "docs/prototypes/v4"), { recursive: true });
	await writeFile(join(root, "docs/references/grok-bot/official-overview.webp"), "Controlled third-party placeholder");
	await writeFile(join(root, "docs/prototypes/v4/original.png"), "Controlled original prototype");
	git(root, ["add", "."]);
	git(root, ["commit", "--quiet", "-m", "Add controlled export policy"]);
	const archive = spawnSync("git", ["archive", "--format=tar", "HEAD"], { cwd: root });
	assert.equal(archive.status, 0);
	const list = spawnSync("tar", ["-tf", "-"], { input: archive.stdout, encoding: "utf8" });
	assert.equal(list.status, 0, list.stderr);
	assert.match(list.stdout, /LICENSE/);
	assert.match(list.stdout, /THIRD_PARTY_NOTICES.md/);
	assert.match(list.stdout, /docs\/prototypes\/v4\/original.png/);
	assert.doesNotMatch(list.stdout, /official-overview.webp/);
	assert.ok((await readFile(join(root, "docs/references/grok-bot/official-overview.webp"))).length > 0);
	git(root, ["cat-file", "-e", "HEAD:docs/references/grok-bot/official-overview.webp"]);
});
