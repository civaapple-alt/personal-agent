#!/usr/bin/env node
/** Zero-dependency read-only repository preflight check example for PA Skills. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const cwd = resolve(process.argv[2] ?? process.cwd());

function safeGit(args) {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

const pkgPath = resolve(cwd, "package.json");
let packageName = null;
let packageVersion = null;
if (existsSync(pkgPath)) {
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		packageName = typeof pkg.name === "string" ? pkg.name : null;
		packageVersion = typeof pkg.version === "string" ? pkg.version : null;
	} catch {
		// ignore malformed package.json
	}
}

const status = safeGit(["status", "--short"]);
const result = {
	cwd,
	nodeVersion: process.version,
	packageName,
	packageVersion,
	gitBranch: safeGit(["rev-parse", "--abbrev-ref", "HEAD"]),
	dirtyCount: status ? status.split(/\r?\n/).filter(Boolean).length : 0,
};

console.log(JSON.stringify(result, null, 2));
