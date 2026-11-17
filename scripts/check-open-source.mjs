import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { forbiddenReleasePath, secretIndicators } from "./release-policy.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
	console.log(
		"npm run check:opensource -- [--history] [--public]\nRead-only audit of MIT/version metadata, tracked source paths and finite credential patterns. --history scans all reachable Git objects; matched values are never printed. --public additionally fails on unresolved reference images. No model, network, user-data scan, Git rewrite or publication. This is not a complete secret or rights audit.",
	);
} else {
	assert.ok(
		args.every((arg) => arg === "--history" || arg === "--public"),
		"Unknown audit option",
	);
	await main();
}

async function main() {
	const root = process.cwd();
	const git = (args, options = {}) =>
		execFileSync("git", args, { cwd: root, maxBuffer: 256 * 1024 * 1024, ...options });
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
	const license = await readFile(join(root, "LICENSE"), "utf8");
	const notices = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
	assert.equal(pkg.license, "MIT");
	assert.equal(lock.packages[""].license, "MIT");
	assert.equal(lock.version, pkg.version);
	assert.equal(lock.packages[""].version, pkg.version);
	assert.ok(license.startsWith("MIT License\n") && license.includes("Personal Agent contributors"));
	assert.ok(notices.includes("2026 Lauren Tan") && notices.includes("Meta Platforms, Inc."));
	const paths = git(["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean);
	const findings = [];
	for (const path of paths) {
		if (forbiddenReleasePath(path)) findings.push({ scope: "current", path, rule: "private-or-generated-path" });
		for (const hit of secretIndicators(await readFile(join(root, path))))
			findings.push({ scope: "current", path, ...hit });
	}
	let historyObjects = 0;
	if (args.includes("--history")) {
		const ids = git(["rev-list", "--objects", "--all", "--no-object-names"]).toString("utf8").trim();
		const batch = git(["cat-file", "--batch"], { input: `${ids}\n` });
		let offset = 0;
		while (offset < batch.length) {
			const end = batch.indexOf(10, offset);
			assert.ok(end >= offset, "Invalid Git object header");
			const [object, type, sizeText] = batch.subarray(offset, end).toString("ascii").split(" ");
			const size = Number(sizeText);
			assert.ok(Number.isSafeInteger(size) && size >= 0 && end + 1 + size < batch.length, "Invalid Git object size");
			if (type === "blob" || type === "commit" || type === "tag") {
				for (const hit of secretIndicators(batch.subarray(end + 1, end + 1 + size)))
					findings.push({ scope: "history", object, ...hit });
			}
			historyObjects += 1;
			offset = end + size + 2;
		}
	}
	const references = paths.filter((path) => /^docs\/references\/grok-bot\/.*\.(?:webp|png|jpe?g|svg)$/.test(path));
	const dependencyLicenses = {};
	for (const [path, dependency] of Object.entries(lock.packages)) {
		if (!path) continue;
		const key = dependency.license ?? "MISSING";
		dependencyLicenses[key] = (dependencyLicenses[key] ?? 0) + 1;
	}
	console.log(
		JSON.stringify(
			{
				version: pkg.version,
				license: pkg.license,
				npmPrivate: pkg.private === true,
				trackedFiles: paths.length,
				historyObjects,
				dependencyLicenses,
				findings,
				referenceImagesRequiringReview: references,
				limits:
					"Finite credential patterns only; no claim of exhaustive detection or redistribution rights. Git identities and private business context require separate human review.",
			},
			null,
			2,
		),
	);
	process.exitCode = findings.length || (args.includes("--public") && references.length) ? 1 : 0;
}
