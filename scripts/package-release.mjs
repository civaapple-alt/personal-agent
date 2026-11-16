// Package a clean committed snapshot. No publish, tag mutation, model calls or user-data access.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
	console.log(
		"npm run package:release\nPackage clean HEAD into .releases/v<VERSION>/ with source/prebuilt archives, manifest and SHA256SUMS.\nBuilds in a disposable snapshot using installed dependencies, then checks the extracted archives without model calls. Does not create tags or publish externally.",
	);
} else {
	assert.equal(args.length, 0, "Only --help is supported");
	await main();
}

async function main() {
	const root = process.cwd();
	const run = async (cmd, argv, cwd = root, env = process.env) => {
		const result = await exec(cmd, argv, { cwd, env, maxBuffer: 16 * 1024 * 1024 });
		return result.stdout.trim();
	};
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
	assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "Release requires a numeric version");
	assert.equal(lock.version, pkg.version, "Lockfile version differs");
	assert.equal(lock.packages[""].version, pkg.version, "Lockfile root package version differs");
	assert.equal(
		await run("git", ["status", "--porcelain", "--untracked-files=no"]),
		"",
		"Commit tracked changes before packaging",
	);
	const commit = await run("git", ["rev-parse", "HEAD"]);
	const tracked = (await run("git", ["ls-files", "-z"])).split("\0").filter(Boolean);
	assert.ok(
		!tracked.some(
			(path) =>
				/^(?:\.data|\.pi|\.releases|node_modules|dist|web\/dist)(?:\/|$)/.test(path) ||
				path === ".env" ||
				path === ".npmrc",
		),
		"Runtime data, credentials or generated files must not be tracked in the source snapshot",
	);
	const version = pkg.version;
	const directory = join(root, ".releases", `v${version}`);
	const sourceName = `personal-agent-${version}-source.tar.gz`;
	const prebuiltName = `personal-agent-${version}-prebuilt.tar.gz`;
	const checksum = async (path) =>
		createHash("sha256")
			.update(await readFile(path))
			.digest("hex");
	const checksumText = async (folder, manifest) => {
		const lines = manifest.files.map((file) => `${file.sha256}  ${file.name}`);
		lines.push(`${await checksum(join(folder, "manifest.json"))}  manifest.json`);
		return `${lines.join("\n")}\n`;
	};
	try {
		await lstat(directory);
		const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
		assert.equal(manifest.version, version, "Existing release version differs");
		assert.equal(manifest.commit, commit, "Existing release belongs to another commit; not overwritten");
		assert.deepEqual(
			manifest.files.map((file) => file.name),
			[sourceName, prebuiltName],
		);
		for (const file of manifest.files)
			assert.equal(await checksum(join(directory, file.name)), file.sha256, "Existing archive checksum differs");
		assert.equal(await readFile(join(directory, "SHA256SUMS"), "utf8"), await checksumText(directory, manifest));
		console.log(`Verified existing release: ${directory}`);
		return;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		// An incomplete existing directory is never replaced.
		await lstat(directory).then(
			() => {
				throw new Error(`Incomplete existing release: ${directory}`);
			},
			(missing) => {
				if (missing.code !== "ENOENT") throw missing;
			},
		);
	}
	assert.ok((await stat(join(root, "node_modules"))).isDirectory(), "Install build dependencies with npm ci first");
	const parent = join(root, ".releases");
	await mkdir(parent, { recursive: true });
	const pending = join(parent, `.v${version}-${randomUUID()}`);
	await mkdir(pending);
	const temporary = await mkdtemp(join(tmpdir(), "personal-agent-release-"));
	try {
		const prefix = `personal-agent-${version}`;
		console.log(`Packaging ${version} from ${commit}`);
		await run("git", [
			"archive",
			"--format=tar.gz",
			`--prefix=${prefix}/`,
			`--output=${join(pending, sourceName)}`,
			commit,
		]);
		await run("tar", ["-xzf", join(pending, sourceName), "-C", temporary]);
		const snapshot = join(temporary, prefix);
		const snapshotPackage = JSON.parse(await readFile(join(snapshot, "package.json"), "utf8"));
		assert.equal(snapshotPackage.version, version);
		await symlink(join(root, "node_modules"), join(snapshot, "node_modules"), "dir");
		console.log(await run("npm", ["run", "build"], snapshot, { ...process.env, NODE_ENV: "production" }));
		await unlink(join(snapshot, "node_modules"));
		await run("tar", ["-czf", join(pending, prebuiltName), "-C", temporary, prefix], root, {
			...process.env,
			COPYFILE_DISABLE: "1",
		});
		const verification = join(temporary, "verify");
		await mkdir(verification);
		await run("tar", ["-xzf", join(pending, prebuiltName), "-C", verification]);
		const extracted = join(verification, prefix);
		await assert.rejects(lstat(join(extracted, "node_modules")), { code: "ENOENT" });
		await assert.rejects(lstat(join(extracted, ".data")), { code: "ENOENT" });
		const startupOutput = await run(process.execPath, ["scripts/check-server-startup.mjs"], extracted);
		console.log(startupOutput);
		const files = [];
		for (const name of [sourceName, prebuiltName])
			files.push({
				name,
				bytes: (await stat(join(pending, name))).size,
				sha256: await checksum(join(pending, name)),
			});
		const manifest = {
			version,
			commit,
			createdAt: new Date().toISOString(),
			nodeVersion: process.version,
			files,
			validation: {
				isolatedBuild: true,
				extractedStartup: true,
				includesNodeModules: false,
				includesUserData: false,
				startupOutput,
			},
		};
		await writeFile(join(pending, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		await writeFile(join(pending, "SHA256SUMS"), await checksumText(pending, manifest));
		assert.equal(await run("git", ["rev-parse", "HEAD"]), commit, "HEAD changed during packaging");
		assert.equal(
			await run("git", ["status", "--porcelain", "--untracked-files=no"]),
			"",
			"Tracked files changed during packaging",
		);
		await rename(pending, directory);
		console.log(`Local release artifacts: ${directory}`);
	} finally {
		await rm(temporary, { recursive: true, force: true });
		await rm(pending, { recursive: true, force: true });
	}
}
